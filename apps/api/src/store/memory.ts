/**
 * In-memory Store. The data model is still churning, so there are no migrations
 * to fight — a schema change here is a TypeScript edit and nothing else.
 *
 * PERSIST_TO_DISK=true adds a debounced JSON snapshot to .data/, which buys
 * restart survival for ~30 lines. Upgrade to SQLite + Drizzle only when a concrete
 * need appears (long runs that must survive a deploy, or visibly slow filtering).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AgentSessionState,
  BrowserSiteBlock,
  BrowserTargetMemory,
  Conversation,
  AgentGraph,
  Approval,
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

interface Snapshot {
  graphs?: AgentGraph[];
  conversations?: Conversation[];
  sessionStates?: AgentSessionState[];
  mcpConnections?: McpConnection[];
  runs: Run[];
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  pii: PiiSpanWithValue[];
  scheduleDecisions: ScheduleDecision[];
  events: StoredEvent[];
}

const SNAPSHOT_PATH = resolve(process.cwd(), '../../.data/store.json');

export function createMemoryStore(opts: { persistToDisk?: boolean } = {}): Store & {
  hydrate(): Promise<void>;
} {
  const runs = new Map<string, Run>();
  const steps = new Map<string, Step>();
  const approvals = new Map<string, Approval>();
  const sessionStates = new Map<string, AgentSessionState>();
  const mcpConnections = new Map<string, McpConnection>();
  const egress = new Map<string, EgressEvent[]>();
  const pii = new Map<string, PiiSpanWithValue[]>();
  const scheduleDecisions = new Map<string, ScheduleDecision[]>();
  const events = new Map<string, StoredEvent[]>();
  const graphs = new Map<string, AgentGraph>();
  const conversations = new Map<string, Conversation>();
  // Not part of the disk snapshot: browser memory is a cache, and a lost one
  // only costs a target decision on the next visit.
  const targetMemory = new Map<string, BrowserTargetMemory>();
  const siteBlocks = new Map<string, BrowserSiteBlock>();
  /** Monotonic step counter per run, so Step.seq is stable and gap-free. */
  const stepSeq = new Map<string, number>();

  let saveTimer: NodeJS.Timeout | null = null;

  function scheduleSave(): void {
    if (!opts.persistToDisk) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void save();
    }, 400);
    // Do not hold the process open just to flush a snapshot.
    saveTimer.unref?.();
  }

  async function save(): Promise<void> {
    const snapshot: Snapshot = {
      graphs: [...graphs.values()],
      conversations: [...conversations.values()],
      sessionStates: [...sessionStates.values()],
      mcpConnections: [...mcpConnections.values()],
      runs: [...runs.values()],
      steps: [...steps.values()],
      approvals: [...approvals.values()],
      egress: [...egress.values()].flat(),
      pii: [...pii.values()].flat(),
      scheduleDecisions: [...scheduleDecisions.values()].flat(),
      events: [...events.values()].flat(),
    };
    try {
      await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
      await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot), 'utf8');
    } catch (err) {
      console.warn('[store] snapshot write failed:', (err as Error).message);
    }
  }

  async function hydrate(): Promise<void> {
    if (!opts.persistToDisk) return;
    try {
      const raw = await readFile(SNAPSHOT_PATH, 'utf8');
      const snap = JSON.parse(raw) as Snapshot;
      for (const r of snap.runs) {
        const input = r.input && typeof r.input === 'object' ? r.input : null;
        const inputGraphId =
          input && !Array.isArray(input) && typeof input.graphId === 'string'
            ? input.graphId
            : undefined;
        runs.set(r.id, r.graphId || !inputGraphId ? r : { ...r, graphId: inputGraphId });
      }
      for (const s of snap.steps) {
        steps.set(s.id, s);
        stepSeq.set(s.runId, Math.max(stepSeq.get(s.runId) ?? 0, s.seq));
      }
      for (const a of snap.approvals) approvals.set(a.id, a);
      // `?? []` because a snapshot written before conversations were restored
      // to the store has no such key -- hydrating must not throw on it.
      for (const c of snap.conversations ?? []) conversations.set(c.id, c);
      for (const state of snap.sessionStates ?? []) sessionStates.set(state.id, state);
      for (const connection of snap.mcpConnections ?? []) {
        mcpConnections.set(connection.id, connection);
      }
      for (const e of snap.egress) push(egress, e.runId, e);
      for (const p of snap.pii) push(pii, p.runId, p);
      for (const d of snap.scheduleDecisions) push(scheduleDecisions, d.runId, d);
      for (const e of snap.events) push(events, e.runId, e);
      for (const g of snap.graphs ?? []) graphs.set(g.id, g);
      console.log('[store] hydrated ' + snap.runs.length + ' run(s) from snapshot');
    } catch {
      // No snapshot yet, or it is unreadable. Starting empty is correct.
    }
  }

  function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }

  return {
    hydrate,

    /* ---------------------------------------------------------------- Runs */
    async createRun(run) {
      runs.set(run.id, run);
      scheduleSave();
      return run;
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async listRuns(filter: ListRunsFilter = {}) {
      let list = [...runs.values()];
      if (filter.graphId) list = list.filter((r) => r.graphId === filter.graphId);
      if (filter.status) list = list.filter((r) => r.status === filter.status);
      if (filter.kind) list = list.filter((r) => r.kind === filter.kind);
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
      return list.slice(0, filter.limit ?? 50);
    },
    async patchRun(id, patch) {
      const existing = runs.get(id);
      if (!existing) throw new NotFoundError('Run', id);
      const next: Run = { ...existing, ...patch, id, updatedAt: nowIso() };
      runs.set(id, next);
      scheduleSave();
      return next;
    },

    /* --------------------------------------------------------------- Steps */
    async appendStep(step) {
      const seq = (stepSeq.get(step.runId) ?? 0) + 1;
      stepSeq.set(step.runId, seq);
      const full: Step = { ...step, seq };
      steps.set(full.id, full);
      scheduleSave();
      return full;
    },
    async patchStep(id, patch) {
      const existing = steps.get(id);
      if (!existing) throw new NotFoundError('Step', id);
      const next: Step = { ...existing, ...patch, id };
      steps.set(id, next);
      scheduleSave();
      return next;
    },
    async getStep(id) {
      return steps.get(id) ?? null;
    },
    async listSteps(runId) {
      return [...steps.values()].filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq);
    },

    /* ----------------------------------------------------------- Approvals */
    async createApproval(approval) {
      approvals.set(approval.id, approval);
      scheduleSave();
      return approval;
    },
    async getApproval(id) {
      return approvals.get(id) ?? null;
    },
    async patchApproval(id, patch) {
      const existing = approvals.get(id);
      if (!existing) throw new NotFoundError('Approval', id);
      const next: Approval = { ...existing, ...patch, id };
      approvals.set(id, next);
      scheduleSave();
      return next;
    },
    async listApprovals(runId) {
      return [...approvals.values()]
        .filter((a) => a.runId === runId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },

    /* ---------------------------------------------- Agent session state */
    async createSessionState(state) {
      sessionStates.set(state.id, state);
      scheduleSave();
      return state;
    },
    async getSessionState(id) {
      return sessionStates.get(id) ?? null;
    },
    async getSessionStateByHarnessSession(harnessSessionId) {
      return (
        [...sessionStates.values()].find((state) => state.harnessSessionId === harnessSessionId) ??
        null
      );
    },
    async patchSessionState(id, patch) {
      const existing = sessionStates.get(id);
      if (!existing) throw new NotFoundError('AgentSessionState', id);
      const next: AgentSessionState = { ...existing, ...patch, id, updatedAt: nowIso() };
      sessionStates.set(id, next);
      scheduleSave();
      return next;
    },
    async listSessionStates(runId) {
      return [...sessionStates.values()]
        .filter((state) => !runId || state.runId === runId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },

    /* ------------------------------------------ Upstream MCP connections */
    async saveMcpConnection(connection) {
      mcpConnections.set(connection.id, structuredClone(connection));
      scheduleSave();
      return structuredClone(connection);
    },
    async getMcpConnection(id) {
      const connection = mcpConnections.get(id);
      return connection ? structuredClone(connection) : null;
    },
    async listMcpConnections() {
      return [...mcpConnections.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((connection) => structuredClone(connection));
    },
    async deleteMcpConnection(id) {
      const deleted = mcpConnections.delete(id);
      if (deleted) scheduleSave();
      return deleted;
    },

    async getTargetMemory(key) {
      const entry = targetMemory.get(key);
      return entry ? structuredClone(entry) : null;
    },
    async putTargetMemory(entry) {
      targetMemory.set(entry.key, structuredClone(entry));
    },
    async deleteTargetMemory(key) {
      targetMemory.delete(key);
    },
    async listTargetMemory(scope) {
      return [...targetMemory.values()]
        .filter((entry) => scope === undefined || entry.scope === scope)
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .map((entry) => structuredClone(entry));
    },
    async recordSiteBlock(origin, reason, at) {
      const key = origin + '|' + reason;
      const existing = siteBlocks.get(key);
      const next: BrowserSiteBlock = existing
        ? { ...existing, count: existing.count + 1, lastAt: at }
        : { origin, reason, count: 1, firstAt: at, lastAt: at };
      siteBlocks.set(key, next);
      return structuredClone(next);
    },
    async listSiteBlocks() {
      return [...siteBlocks.values()]
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
        .map((block) => structuredClone(block));
    },

    /* -------------------------------------------------------------- Egress */
    async appendEgress(event) {
      push(egress, event.runId, event);
      scheduleSave();
      return event;
    },
    async listEgress(runId) {
      return [...(egress.get(runId) ?? [])];
    },

    /* ----------------------------------------------------------------- PII */
    async appendPiiSpan(span) {
      push(pii, span.runId, span);
      scheduleSave();
      return span;
    },
    async listPiiSpans(runId) {
      return [...(pii.get(runId) ?? [])];
    },

    /* --------------------------------------------------- Schedule decisions */
    async createScheduleDecision(decision) {
      push(scheduleDecisions, decision.runId, decision);
      scheduleSave();
      return decision;
    },
    async listScheduleDecisions(runId) {
      return [...(scheduleDecisions.get(runId) ?? [])];
    },

    /* -------------------------------------------------------------- Graphs */
    async saveGraph(graph) {
      graphs.set(graph.id, graph);
      scheduleSave();
      return graph;
    },
    async getGraph(id) {
      return graphs.get(id) ?? null;
    },
    async listGraphs() {
      return [...graphs.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    async deleteGraph(id) {
      const existed = graphs.delete(id);
      if (existed) scheduleSave();
      return existed;
    },

    /* ------------------------------------------------------- Conversations */

    async saveConversation(conversation) {
      conversations.set(conversation.id, conversation);
      scheduleSave();
      return conversation;
    },
    async getConversation(id) {
      return conversations.get(id) ?? null;
    },
    async listConversations() {
      return [...conversations.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    /* -------------------------------------------------------------- Events */
    async appendEvent(runId: string, event: RunEvent) {
      const list = events.get(runId) ?? [];
      const stored: StoredEvent = { seq: list.length + 1, runId, event, at: nowIso() };
      list.push(stored);
      events.set(runId, list);
      scheduleSave();
      return stored;
    },
    async eventsSince(runId, seq) {
      return (events.get(runId) ?? []).filter((e) => e.seq > seq);
    },
  };
}
