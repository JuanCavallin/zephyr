import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentGraph,
  AgentSessionState,
  Approval,
  BrowserSiteBlock,
  BrowserTargetMemory,
  Conversation,
  EgressEvent,
  McpConnection,
  PiiSpanWithValue,
  Run,
  RunEvent,
  ScheduleDecision,
  Step,
  StoredEvent,
} from '@htn/shared';
import { nowIso } from '../lib/ids.js';
import { NotFoundError, type ListRunsFilter, type Store } from './types.js';

export interface SqliteStore extends Store {
  hydrate(): Promise<void>;
  close(): void;
}

/**
 * Durable control-plane store. JSON payload columns preserve the published
 * domain contracts while indexed scalar columns support the few queries the
 * API actually performs. Schema changes therefore stay additive and cheap.
 */
export function createSqliteStore(path: string): SqliteStore {
  const filename = resolve(path);
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_status_created ON runs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS runs_kind_created ON runs(kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS steps_run_seq ON steps(run_id, seq);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS approvals_run_created ON approvals(run_id, created_at);

    CREATE TABLE IF NOT EXISTS session_states (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      harness_session_id TEXT,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_run_created ON session_states(run_id, created_at);
    CREATE INDEX IF NOT EXISTS sessions_harness ON session_states(harness_session_id);

    CREATE TABLE IF NOT EXISTS egress (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS egress_run_at ON egress(run_id, at);

    CREATE TABLE IF NOT EXISTS pii (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pii_run ON pii(run_id);

    CREATE TABLE IF NOT EXISTS schedule_decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_run_at ON schedule_decisions(run_id, at);

    CREATE TABLE IF NOT EXISTS graphs (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY(run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, seq);

    CREATE TABLE IF NOT EXISTS target_memory (
      key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS target_memory_scope ON target_memory(scope, last_seen);

    CREATE TABLE IF NOT EXISTS site_blocks (
      origin TEXT NOT NULL,
      reason TEXT NOT NULL,
      last_at TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY(origin, reason)
    );

    CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_connections_name ON mcp_connections(name);
  `);

  // Additive run-lineage migration. Older databases stored graphId only inside
  // the JSON body/input; backfill the indexed column without losing that data.
  const runColumns = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  if (!runColumns.some((column) => column.name === 'graph_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN graph_id TEXT');
  }
  const unindexedRuns = db.prepare('SELECT id, body FROM runs WHERE graph_id IS NULL').all() as {
    id: string;
    body: string;
  }[];
  const updateRunGraphId = db.prepare('UPDATE runs SET graph_id = ? WHERE id = ?');
  for (const row of unindexedRuns) {
    const run = decode<Run>(row.body);
    const input = run.input && typeof run.input === 'object' ? run.input : null;
    const inputGraphId =
      input && !Array.isArray(input) && typeof input.graphId === 'string' ? input.graphId : null;
    updateRunGraphId.run(run.graphId ?? inputGraphId, row.id);
  }
  db.exec('CREATE INDEX IF NOT EXISTS runs_graph_created ON runs(graph_id, created_at DESC)');

  const store: SqliteStore = {
    async hydrate() {
      const row = db.prepare('SELECT COUNT(*) AS count FROM runs').get() as
        { count?: number } | undefined;
      console.log('[store] sqlite=' + filename + ' runs=' + Number(row?.count ?? 0).toString());
    },

    close() {
      db.close();
    },

    async createRun(run) {
      writeRun(db, run);
      return clone(run);
    },
    async getRun(id) {
      return readOne<Run>(db, 'SELECT body FROM runs WHERE id = ?', id);
    },
    async listRuns(filter: ListRunsFilter = {}) {
      const clauses: string[] = [];
      const values: (string | number)[] = [];
      if (filter.graphId) {
        clauses.push('graph_id = ?');
        values.push(filter.graphId);
      }
      if (filter.status) {
        clauses.push('status = ?');
        values.push(filter.status);
      }
      if (filter.kind) {
        clauses.push('kind = ?');
        values.push(filter.kind);
      }
      values.push(filter.limit ?? 50);
      const rows = db
        .prepare(
          'SELECT body FROM runs' +
            (clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '') +
            ' ORDER BY created_at DESC LIMIT ?',
        )
        .all(...values);
      return readRows<Run>(rows);
    },
    async patchRun(id, patch) {
      const existing = await store.getRun(id);
      if (!existing) throw new NotFoundError('Run', id);
      const next: Run = { ...existing, ...patch, id, updatedAt: nowIso() };
      writeRun(db, next);
      return clone(next);
    },

    async appendStep(step) {
      return transaction(db, () => {
        const row = db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM steps WHERE run_id = ?')
          .get(step.runId) as { seq: number };
        const full: Step = { ...step, seq: Number(row.seq) };
        db.prepare('INSERT INTO steps(id, run_id, seq, body) VALUES (?, ?, ?, ?)').run(
          full.id,
          full.runId,
          full.seq,
          encode(full),
        );
        return clone(full);
      });
    },
    async patchStep(id, patch) {
      const existing = await store.getStep(id);
      if (!existing) throw new NotFoundError('Step', id);
      const next: Step = { ...existing, ...patch, id };
      db.prepare('UPDATE steps SET body = ? WHERE id = ?').run(encode(next), id);
      return clone(next);
    },
    async getStep(id) {
      return readOne<Step>(db, 'SELECT body FROM steps WHERE id = ?', id);
    },
    async listSteps(runId) {
      return readRows<Step>(
        db.prepare('SELECT body FROM steps WHERE run_id = ? ORDER BY seq').all(runId),
      );
    },

    async createApproval(approval) {
      db.prepare(
        `INSERT INTO approvals(id, run_id, created_at, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,
           created_at=excluded.created_at, body=excluded.body`,
      ).run(approval.id, approval.runId, approval.createdAt, encode(approval));
      return clone(approval);
    },
    async getApproval(id) {
      return readOne<Approval>(db, 'SELECT body FROM approvals WHERE id = ?', id);
    },
    async patchApproval(id, patch) {
      const existing = await store.getApproval(id);
      if (!existing) throw new NotFoundError('Approval', id);
      const next: Approval = { ...existing, ...patch, id };
      db.prepare('UPDATE approvals SET body = ? WHERE id = ?').run(encode(next), id);
      return clone(next);
    },
    async listApprovals(runId) {
      return readRows<Approval>(
        db.prepare('SELECT body FROM approvals WHERE run_id = ? ORDER BY created_at').all(runId),
      );
    },

    async createSessionState(state) {
      writeSession(db, state);
      return clone(state);
    },
    async getSessionState(id) {
      return readOne<AgentSessionState>(db, 'SELECT body FROM session_states WHERE id = ?', id);
    },
    async getSessionStateByHarnessSession(harnessSessionId) {
      return readOne<AgentSessionState>(
        db,
        'SELECT body FROM session_states WHERE harness_session_id = ?',
        harnessSessionId,
      );
    },
    async patchSessionState(id, patch) {
      const existing = await store.getSessionState(id);
      if (!existing) throw new NotFoundError('AgentSessionState', id);
      const next: AgentSessionState = { ...existing, ...patch, id, updatedAt: nowIso() };
      writeSession(db, next);
      return clone(next);
    },
    async listSessionStates(runId) {
      return readRows<AgentSessionState>(
        runId
          ? db
              .prepare('SELECT body FROM session_states WHERE run_id = ? ORDER BY created_at')
              .all(runId)
          : db.prepare('SELECT body FROM session_states ORDER BY created_at').all(),
      );
    },

    async saveMcpConnection(connection) {
      db.prepare(
        `INSERT INTO mcp_connections(id, name, url, updated_at, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url,
           updated_at=excluded.updated_at, body=excluded.body`,
      ).run(
        connection.id,
        connection.name,
        connection.url,
        connection.updatedAt,
        encode(connection),
      );
      return clone(connection);
    },
    async getMcpConnection(id) {
      return readOne<McpConnection>(db, 'SELECT body FROM mcp_connections WHERE id = ?', id);
    },
    async listMcpConnections() {
      return readRows<McpConnection>(
        db.prepare('SELECT body FROM mcp_connections ORDER BY name').all(),
      );
    },
    async deleteMcpConnection(id) {
      return Number(db.prepare('DELETE FROM mcp_connections WHERE id = ?').run(id).changes) > 0;
    },

    async getTargetMemory(key) {
      return readOne<BrowserTargetMemory>(db, 'SELECT body FROM target_memory WHERE key = ?', key);
    },
    async putTargetMemory(entry) {
      db.prepare(
        `INSERT INTO target_memory(key, scope, last_seen, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET scope=excluded.scope, last_seen=excluded.last_seen, body=excluded.body`,
      ).run(entry.key, entry.scope, entry.lastSeen, encode(entry));
    },
    async deleteTargetMemory(key) {
      db.prepare('DELETE FROM target_memory WHERE key = ?').run(key);
    },
    async listTargetMemory(scope) {
      return readRows<BrowserTargetMemory>(
        scope === undefined
          ? db.prepare('SELECT body FROM target_memory ORDER BY last_seen DESC').all()
          : db
              .prepare('SELECT body FROM target_memory WHERE scope = ? ORDER BY last_seen DESC')
              .all(scope),
      );
    },
    async recordSiteBlock(origin, reason, at) {
      const existing = readOne<BrowserSiteBlock>(
        db,
        'SELECT body FROM site_blocks WHERE origin = ? AND reason = ?',
        origin,
        reason,
      );
      const next: BrowserSiteBlock = existing
        ? { ...existing, count: existing.count + 1, lastAt: at }
        : { origin, reason, count: 1, firstAt: at, lastAt: at };
      db.prepare(
        `INSERT INTO site_blocks(origin, reason, last_at, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(origin, reason) DO UPDATE SET last_at=excluded.last_at, body=excluded.body`,
      ).run(origin, reason, at, encode(next));
      return clone(next);
    },
    async listSiteBlocks() {
      return readRows<BrowserSiteBlock>(
        db.prepare('SELECT body FROM site_blocks ORDER BY last_at DESC').all(),
      );
    },

    async appendEgress(event) {
      db.prepare('INSERT INTO egress(id, run_id, at, body) VALUES (?, ?, ?, ?)').run(
        event.id,
        event.runId,
        event.at,
        encode(event),
      );
      return clone(event);
    },
    async listEgress(runId) {
      return readRows<EgressEvent>(
        db.prepare('SELECT body FROM egress WHERE run_id = ? ORDER BY at, rowid').all(runId),
      );
    },

    async appendPiiSpan(span) {
      db.prepare('INSERT INTO pii(id, run_id, body) VALUES (?, ?, ?)').run(
        span.id,
        span.runId,
        encode(span),
      );
      return clone(span);
    },
    async listPiiSpans(runId) {
      return readRows<PiiSpanWithValue>(
        db.prepare('SELECT body FROM pii WHERE run_id = ? ORDER BY rowid').all(runId),
      );
    },

    async createScheduleDecision(decision) {
      db.prepare('INSERT INTO schedule_decisions(id, run_id, at, body) VALUES (?, ?, ?, ?)').run(
        decision.id,
        decision.runId,
        decision.at,
        encode(decision),
      );
      return clone(decision);
    },
    async listScheduleDecisions(runId) {
      return readRows<ScheduleDecision>(
        db
          .prepare('SELECT body FROM schedule_decisions WHERE run_id = ? ORDER BY at, rowid')
          .all(runId),
      );
    },

    async saveGraph(graph) {
      db.prepare(
        `INSERT INTO graphs(id, updated_at, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, body=excluded.body`,
      ).run(graph.id, graph.updatedAt, encode(graph));
      return clone(graph);
    },
    async getGraph(id) {
      return readOne<AgentGraph>(db, 'SELECT body FROM graphs WHERE id = ?', id);
    },
    async listGraphs() {
      return readRows<AgentGraph>(
        db.prepare('SELECT body FROM graphs ORDER BY updated_at DESC').all(),
      );
    },
    async deleteGraph(id) {
      return Number(db.prepare('DELETE FROM graphs WHERE id = ?').run(id).changes) > 0;
    },

    /* ------------------------------------------------------- Conversations */

    async saveConversation(conversation) {
      db.prepare(
        `INSERT INTO conversations(id, updated_at, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, body=excluded.body`,
      ).run(conversation.id, conversation.updatedAt, encode(conversation));
      return clone(conversation);
    },
    async getConversation(id) {
      return readOne<Conversation>(db, 'SELECT body FROM conversations WHERE id = ?', id);
    },
    async listConversations() {
      return readRows<Conversation>(
        db.prepare('SELECT body FROM conversations ORDER BY updated_at DESC').all(),
      );
    },

    async appendEvent(runId: string, event: RunEvent) {
      return transaction(db, () => {
        const row = db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?')
          .get(runId) as { seq: number };
        const stored: StoredEvent = {
          seq: Number(row.seq),
          runId,
          event,
          at: nowIso(),
        };
        db.prepare('INSERT INTO events(run_id, seq, at, body) VALUES (?, ?, ?, ?)').run(
          runId,
          stored.seq,
          stored.at,
          encode(stored),
        );
        return clone(stored);
      });
    },
    async eventsSince(runId, seq) {
      return readRows<StoredEvent>(
        db
          .prepare('SELECT body FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
          .all(runId, seq),
      );
    },
  };

  return store;
}

function writeRun(db: DatabaseSync, run: Run): void {
  db.prepare(
    `INSERT INTO runs(id, status, kind, created_at, updated_at, graph_id, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, kind=excluded.kind,
       created_at=excluded.created_at, updated_at=excluded.updated_at,
       graph_id=excluded.graph_id, body=excluded.body`,
  ).run(
    run.id,
    run.status,
    run.kind,
    run.createdAt,
    run.updatedAt,
    run.graphId ?? null,
    encode(run),
  );
}

function writeSession(db: DatabaseSync, state: AgentSessionState): void {
  db.prepare(
    `INSERT INTO session_states(id, run_id, harness_session_id, created_at, body)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,
       harness_session_id=excluded.harness_session_id, created_at=excluded.created_at,
       body=excluded.body`,
  ).run(state.id, state.runId, state.harnessSessionId ?? null, state.createdAt, encode(state));
}

function readOne<T>(db: DatabaseSync, sql: string, ...values: string[]): T | null {
  const row = db.prepare(sql).get(...values);
  return row ? decode<T>((row as { body: string }).body) : null;
}

function readRows<T>(rows: unknown[]): T[] {
  return rows.map((row) => decode<T>((row as { body: string }).body));
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
