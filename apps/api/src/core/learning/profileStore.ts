/**
 * Step 8 profile store (spec §11): the personal profile at `~/.zephyr/profile.db`.
 *
 * Holds preference signals, learned entries (preferences and skills) with every version
 * they went through, the links from each entry to the signals that are its evidence, and
 * the skill measurement tags (which run loaded which skill). Project entries live here too
 * until they are emitted into the repo as a proposal (`emit.ts`); the file never leaves the
 * machine.
 *
 * Schema changes are numbered migrations tracked in `PRAGMA user_version`; append, never edit.
 * `exportAll` and `deleteAll` are the one-command export and delete.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  preferenceSchema,
  preferenceSignalSchema,
  skillSchema,
  type LearningScope,
  type Preference,
  type PreferenceSignal,
  type SignalSeam,
  type Skill,
} from '@htn/shared';
import { nowIso } from '../../lib/ids.js';

export type EntryKind = 'pref' | 'skill';
export type EntryStatus = 'candidate' | 'active' | 'retired';

/** One learned entry, current version. Preferences carry `text`; skills also carry `skill`. */
export interface LearnedEntry {
  id: string;
  kind: EntryKind;
  scope: LearningScope;
  status: EntryStatus;
  /** 0..1, how well the evidence supports the entry. */
  confidence: number;
  version: number;
  /** Signal ids. */
  evidence: string[];
  /** The preference statement, or the skill's one-line description. */
  text: string;
  skill?: { name: string; description: string; body: string };
  /**
   * False while only the deterministic fallback has scored this entry: confidence from the
   * fallback never crosses the activation threshold on its own.
   */
  autoActivate: boolean;
  /** Who decided the latest score: Jev, or the fallback. */
  source: 'jev' | 'fallback';
  /** Learned from private-route signals: only local models may read it, and it is never emitted. */
  private?: boolean;
  retiredReason?: string;
  /** The user reverted it: never re-activated automatically. */
  reverted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EntryVersion {
  entryId: string;
  version: number;
  at: string;
  reason: string;
  entry: LearnedEntry;
}

export interface StoredSignal {
  signal: PreferenceSignal;
  /** Local-only evidence detail, e.g. the edit diff. Never sent to a remote model for private signals. */
  detail?: string;
  processed: boolean;
}

export interface SkillRunTag {
  runId: string;
  taskId?: string;
  skillId: string;
  skillVersion: number;
  at: string;
  outcome?: 'passed' | 'failed';
}

export interface ProfileExport {
  format: 'zephyr-profile';
  schemaVersion: number;
  exportedAt: string;
  signals: StoredSignal[];
  entries: LearnedEntry[];
  versions: EntryVersion[];
  skillRuns: SkillRunTag[];
}

/** The newest schema this code knows. */
export const PROFILE_SCHEMA_VERSION = 2;

const MIGRATIONS: string[] = [
  // 1: signals, entries, their versions and evidence links.
  `
  CREATE TABLE signals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    private INTEGER NOT NULL,
    task_id TEXT,
    run_id TEXT,
    at TEXT NOT NULL,
    body TEXT NOT NULL,
    detail TEXT,
    processed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX signals_at ON signals(at);
  CREATE INDEX signals_processed ON signals(processed, at);

  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX entries_status ON entries(status, updated_at DESC);

  CREATE TABLE entry_versions (
    entry_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    at TEXT NOT NULL,
    reason TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (entry_id, version)
  );

  CREATE TABLE entry_evidence (
    entry_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    PRIMARY KEY (entry_id, signal_id)
  );
  CREATE INDEX evidence_signal ON entry_evidence(signal_id);
  `,
  // 2: skill measurement tags (step 9 compares arms on these).
  `
  CREATE TABLE skill_runs (
    run_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_version INTEGER NOT NULL,
    task_id TEXT,
    at TEXT NOT NULL,
    outcome TEXT,
    PRIMARY KEY (run_id, skill_id)
  );
  CREATE INDEX skill_runs_skill ON skill_runs(skill_id, at);
  `,
];

/** `ZEPHYR_PROFILE_DB`, else `~/.zephyr/profile.db`. */
export function defaultProfilePath(): string {
  return process.env.ZEPHYR_PROFILE_DB || join(homedir(), '.zephyr', 'profile.db');
}

export class ProfileStoreError extends Error {
  readonly code = 'PROFILE_STORE';
  constructor(message: string) {
    super(message);
    this.name = 'ProfileStoreError';
  }
}

type Row = Record<string, unknown>;

export class ProfileStore implements SignalSeam {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  /** `':memory:'` for a throwaway profile. */
  constructor(path: string = defaultProfilePath(), opts: { now?: () => string } = {}) {
    this.now = opts.now ?? nowIso;
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    if (this.path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.migrate();
  }

  /** The schema version on disk after migrating. */
  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    return Number(row.user_version);
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current > MIGRATIONS.length) {
      throw new ProfileStoreError(
        `profile schema ${current} is newer than this build understands (${MIGRATIONS.length})`,
      );
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---- signals -------------------------------------------------------------

  /** The step 1 seam. `evidence.detail` stays in this file (e.g. the edit diff). */
  async recordSignal(s: PreferenceSignal, evidence: { detail?: string } = {}): Promise<void> {
    const signal = preferenceSignalSchema.parse(s);
    this.db
      .prepare(
        `INSERT INTO signals (id, kind, scope, private, task_id, run_id, at, body, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        signal.id,
        signal.kind,
        signal.scope,
        signal.private ? 1 : 0,
        signal.taskId ?? null,
        signal.runId ?? null,
        signal.at,
        JSON.stringify(signal),
        evidence.detail ?? null,
      );
  }

  signal(id: string): StoredSignal | undefined {
    const row = this.db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.signalOf(row) : undefined;
  }

  /** Oldest first. */
  signals(filter: { unprocessed?: boolean; limit?: number } = {}): StoredSignal[] {
    const where = filter.unprocessed ? 'WHERE processed = 0' : '';
    const rows = this.db
      .prepare(`SELECT * FROM signals ${where} ORDER BY at, id LIMIT ?`)
      .all(filter.limit ?? 10_000) as Row[];
    return rows.map((r) => this.signalOf(r));
  }

  markProcessed(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE signals SET processed = 1 WHERE id = ?');
    this.tx(() => ids.forEach((id) => stmt.run(id)));
  }

  private signalOf(row: Row): StoredSignal {
    return {
      signal: preferenceSignalSchema.parse(JSON.parse(String(row.body))),
      ...(row.detail != null ? { detail: String(row.detail) } : {}),
      processed: Number(row.processed) === 1,
    };
  }

  // ---- entries ---------------------------------------------------------------

  /**
   * Write a new version of an entry. `entry.version` must be exactly one past the stored
   * version (1 for a new entry): a stale writer fails instead of overwriting.
   */
  putEntry(entry: LearnedEntry, reason: string): LearnedEntry {
    if (entry.evidence.length === 0) throw new ProfileStoreError(entry.id + ': an entry needs evidence');
    return this.tx(() => {
      const prev = this.entry(entry.id);
      const expected = (prev?.version ?? 0) + 1;
      if (entry.version !== expected) {
        throw new ProfileStoreError(`${entry.id}: version ${entry.version}, expected ${expected}`);
      }
      const body = JSON.stringify(entry);
      this.db
        .prepare(
          `INSERT INTO entries (id, kind, scope, status, confidence, version, created_at, updated_at, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, scope = excluded.scope,
             status = excluded.status, confidence = excluded.confidence, version = excluded.version,
             updated_at = excluded.updated_at, body = excluded.body`,
        )
        .run(entry.id, entry.kind, entry.scope, entry.status, entry.confidence, entry.version, entry.createdAt, entry.updatedAt, body);
      this.db
        .prepare('INSERT INTO entry_versions (entry_id, version, at, reason, body) VALUES (?, ?, ?, ?, ?)')
        .run(entry.id, entry.version, this.now(), reason, body);
      const link = this.db.prepare('INSERT OR IGNORE INTO entry_evidence (entry_id, signal_id) VALUES (?, ?)');
      for (const signalId of entry.evidence) link.run(entry.id, signalId);
      return entry;
    });
  }

  entry(id: string): LearnedEntry | undefined {
    const row = this.db.prepare('SELECT body FROM entries WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.body)) as LearnedEntry) : undefined;
  }

  /** Newest change first. */
  entries(filter: { status?: EntryStatus[]; scope?: LearningScope; kind?: EntryKind } = {}): LearnedEntry[] {
    const rows = this.db.prepare('SELECT body FROM entries ORDER BY updated_at DESC, id').all() as Row[];
    return rows
      .map((r) => JSON.parse(String(r.body)) as LearnedEntry)
      .filter(
        (e) =>
          (!filter.status || filter.status.includes(e.status)) &&
          (!filter.scope || e.scope === filter.scope) &&
          (!filter.kind || e.kind === filter.kind),
      );
  }

  /** Oldest first. */
  versions(entryId: string): EntryVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM entry_versions WHERE entry_id = ? ORDER BY version')
      .all(entryId) as Row[];
    return rows.map((r) => ({
      entryId: String(r.entry_id),
      version: Number(r.version),
      at: String(r.at),
      reason: String(r.reason),
      entry: JSON.parse(String(r.body)) as LearnedEntry,
    }));
  }

  /** The signals an entry links to, oldest first. */
  evidenceFor(entryId: string): StoredSignal[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM entry_evidence e JOIN signals s ON s.id = e.signal_id
         WHERE e.entry_id = ? ORDER BY s.at, s.id`,
      )
      .all(entryId) as Row[];
    return rows.map((r) => this.signalOf(r));
  }

  // ---- skill measurement -----------------------------------------------------

  /** Step 9 hook: this run loaded these skills. */
  tagRun(runId: string, skills: { id: string; version: number }[], taskId?: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO skill_runs (run_id, skill_id, skill_version, task_id, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, skill_id) DO NOTHING`,
    );
    const at = this.now();
    this.tx(() => skills.forEach((s) => stmt.run(runId, s.id, s.version, taskId ?? null, at)));
  }

  /** Record how a tagged run ended. Untagged runs are ignored. */
  recordRunOutcome(runId: string, outcome: 'passed' | 'failed'): void {
    this.db.prepare('UPDATE skill_runs SET outcome = ? WHERE run_id = ?').run(outcome, runId);
  }

  skillRuns(skillId?: string): SkillRunTag[] {
    const rows = (
      skillId
        ? this.db.prepare('SELECT * FROM skill_runs WHERE skill_id = ? ORDER BY at, run_id').all(skillId)
        : this.db.prepare('SELECT * FROM skill_runs ORDER BY at, run_id').all()
    ) as Row[];
    return rows.map((r) => ({
      runId: String(r.run_id),
      ...(r.task_id != null ? { taskId: String(r.task_id) } : {}),
      skillId: String(r.skill_id),
      skillVersion: Number(r.skill_version),
      at: String(r.at),
      ...(r.outcome != null ? { outcome: String(r.outcome) as 'passed' | 'failed' } : {}),
    }));
  }

  // ---- export / delete --------------------------------------------------------

  exportAll(): ProfileExport {
    const entries = this.entries();
    return {
      format: 'zephyr-profile',
      schemaVersion: this.schemaVersion(),
      exportedAt: this.now(),
      signals: this.signals(),
      entries,
      versions: entries.flatMap((e) => this.versions(e.id)),
      skillRuns: this.skillRuns(),
    };
  }

  /** Forget everything: signals, entries, versions, evidence links and run tags. */
  deleteAll(): { signals: number; entries: number } {
    const counts = {
      signals: Number((this.db.prepare('SELECT COUNT(*) AS n FROM signals').get() as Row).n),
      entries: Number((this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as Row).n),
    };
    this.tx(() => {
      for (const table of ['entry_evidence', 'entry_versions', 'entries', 'signals', 'skill_runs']) {
        this.db.exec(`DELETE FROM ${table}`);
      }
    });
    if (this.path !== ':memory:') this.db.exec('VACUUM');
    return counts;
  }

  close(): void {
    this.db.close();
  }
}

/** The shared `Preference` contract for an entry (events, feed). */
export function toPreference(e: LearnedEntry): Preference {
  return preferenceSchema.parse({
    id: e.id,
    scope: e.scope,
    statement: e.text,
    confidence: e.confidence,
    status: e.status,
    evidence: e.evidence,
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}

/** The shared `Skill` contract for a skill entry. */
export function toSkill(e: LearnedEntry): Skill {
  if (!e.skill) throw new ProfileStoreError(e.id + ' is not a skill');
  return skillSchema.parse({
    id: e.id,
    scope: e.scope,
    name: e.skill.name,
    description: e.skill.description,
    body: e.skill.body,
    status: e.status,
    evidence: e.evidence,
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}
