/**
 * Step 8 learning service: the profile, the signal log, the background learning pass,
 * the lifecycle actions the feed exposes, export/delete, and project proposals.
 *
 * Learning is off the critical path. Recording a signal stores it and returns; drafting
 * (normal model) and scoring (Jev) run later, after a task finishes, one pass at a time.
 * Nothing here can fail a task: pass failures are reported, never thrown.
 */

import type { PreferenceSignal, RunEvent, TextModelAdapter } from '@htn/shared';
import { Lifecycle } from '../core/learning/lifecycle.js';
import { skillArms, skillRegressions, type RegressionOptions, type SkillArm } from '../core/learning/measure.js';
import { runLearningPass, type LearningPassResult } from '../core/learning/pipeline.js';
import {
  ProfileStore,
  type EntryKind,
  type EntryStatus,
  type LearnedEntry,
  type ProfileExport,
} from '../core/learning/profileStore.js';
import { createKnowledgeLoader, type KnowledgeLoader, type KnowledgeLoaderDeps } from '../core/learning/relevance.js';
import type { LearningDecisions } from '../core/learning/score.js';
import {
  describeSignal,
  feedbackSignal,
  requestWordingSignal,
  SignalLog,
  userEditSignal,
  variantPickSignal,
  type EditDiff,
  type SignalOrigin,
} from '../core/learning/signalLog.js';
import { proposeProjectKnowledge, type ProjectProposal } from '../core/learning/emit.js';

type Complete = TextModelAdapter['complete'];

/** Maps to an HTTP status in the routes: unknown ids are 404, refused actions 409. */
export class LearningError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LearningError';
  }
}

export interface LearningServiceDeps {
  store: ProfileStore;
  decisions: LearningDecisions;
  /** Remote text model for drafting from non-private signals. */
  complete: Complete;
  /** Local model; the only one that may draft from private signals. */
  completeLocal?: Complete;
  emit?(runId: string, event: RunEvent): unknown;
  onError?(error: unknown): void;
  /** Repository project proposals are made in, unless one is given per call. */
  repoRoot?: string;
  regression?: RegressionOptions;
  /**
   * Whether a signal's origin (a run or task) is private. Feedback and variant picks arrive
   * from the UI, so the server decides privacy here rather than trusting the client's flag.
   */
  isPrivate?(origin: { runId?: string; taskId?: string }): boolean | Promise<boolean>;
}

export interface FeedEvidence {
  id: string;
  kind: PreferenceSignal['kind'];
  summary: string;
  at: string;
  taskId?: string;
  private: boolean;
}

export interface FeedItem {
  entry: LearnedEntry;
  evidence: FeedEvidence[];
  versions: { version: number; at: string; reason: string }[];
  /** Skills only: pass counts per version, from tagged runs. */
  arms?: SkillArm[];
}

export interface TaskFinished {
  taskId: string;
  runId?: string;
  outcome: 'passed' | 'failed';
}

export class LearningService {
  readonly store: ProfileStore;
  readonly lifecycle: Lifecycle;
  readonly signals: SignalLog;
  private pass: Promise<LearningPassResult> | null = null;
  private again = false;
  private last: LearningPassResult | null = null;

  constructor(private readonly deps: LearningServiceDeps) {
    this.store = deps.store;
    this.lifecycle = new Lifecycle({ store: deps.store, ...(deps.emit ? { emit: deps.emit } : {}) });
    this.signals = new SignalLog({
      store: deps.store,
      ...(deps.emit ? { emit: deps.emit } : {}),
      ...(deps.onError ? { onError: deps.onError } : {}),
    });
  }

  // ---- signals ------------------------------------------------------------------

  async recordEdit(edit: EditDiff, origin: SignalOrigin = {}): Promise<PreferenceSignal> {
    const s = userEditSignal(edit, origin);
    await this.signals.recordSignal(s, { detail: edit.diff });
    return s;
  }

  async variantPick(chosen: string, rejected: string[], origin: SignalOrigin = {}): Promise<PreferenceSignal> {
    const s = variantPickSignal(chosen, rejected, await this.withPrivacy(origin));
    await this.signals.recordSignal(s);
    return s;
  }

  async feedback(rating: 'up' | 'down', comment: string | undefined, origin: SignalOrigin = {}): Promise<PreferenceSignal> {
    const s = feedbackSignal(rating, comment, await this.withPrivacy(origin));
    await this.signals.recordSignal(s);
    return s;
  }

  async requestWording(text: string, origin: SignalOrigin = {}): Promise<PreferenceSignal | null> {
    if (!text.trim()) return null;
    const s = requestWordingSignal(text, origin);
    await this.signals.recordSignal(s);
    return s;
  }

  // ---- the background pass -------------------------------------------------------

  /**
   * A task ended: record the outcome against any skills its run loaded, check for
   * regressing skills, and start a learning pass in the background. Never throws and
   * never waits for the pass.
   */
  onTaskFinished(t: TaskFinished): void {
    try {
      if (t.runId) this.store.recordRunOutcome(t.runId, t.outcome);
      this.demoteRegressions();
    } catch (error) {
      this.deps.onError?.(error);
    }
    void this.runPass().catch((error) => this.deps.onError?.(error));
  }

  /**
   * One pass at a time. A call while a pass runs is folded into one follow-up pass,
   * so signals recorded meanwhile are not left waiting for the next task.
   */
  runPass(): Promise<LearningPassResult> {
    if (this.pass) {
      this.again = true;
      return this.pass;
    }
    const loop = async (): Promise<LearningPassResult> => {
      let result: LearningPassResult;
      do {
        this.again = false;
        result = await runLearningPass({
          store: this.store,
          decisions: this.deps.decisions,
          lifecycle: this.lifecycle,
          complete: this.deps.complete,
          ...(this.deps.completeLocal ? { completeLocal: this.deps.completeLocal } : {}),
        });
        this.last = result;
        if (!result.ok) this.deps.onError?.(new Error('learning pass: ' + result.error));
      } while (this.again);
      return result;
    };
    this.pass = loop().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  /** Resolves when no pass is running. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pass) await this.pass.catch(() => undefined);
  }

  lastPass(): LearningPassResult | null {
    return this.last;
  }

  /** Demote active skills whose current version passes clearly less often than before. */
  demoteRegressions(): LearnedEntry[] {
    const skills = this.store.entries({ status: ['active'], kind: 'skill' });
    if (skills.length === 0) return [];
    const regressions = skillRegressions(this.store.skillRuns(), skills, this.deps.regression);
    return regressions.map((r) =>
      this.lifecycle.demote(
        r.skillId,
        `v${r.version} passes ${pct(r.current.passRate)} of runs, v${r.baseline.version} passed ${pct(r.baseline.passRate)}`,
      ),
    );
  }

  // ---- the feed and its actions --------------------------------------------------

  feed(filter: { status?: EntryStatus[]; kind?: EntryKind } = {}): FeedItem[] {
    const runs = this.store.skillRuns();
    return this.store.entries(filter).map((entry) => {
      const item: FeedItem = {
        entry,
        evidence: this.store.evidenceFor(entry.id).map(({ signal }) => ({
          id: signal.id,
          kind: signal.kind,
          summary: describeSignal(signal),
          at: signal.at,
          ...(signal.taskId ? { taskId: signal.taskId } : {}),
          private: signal.private,
        })),
        versions: this.store.versions(entry.id).map(({ version, at, reason }) => ({ version, at, reason })),
      };
      if (entry.kind === 'skill') item.arms = skillArms(runs.filter((r) => r.skillId === entry.id));
      return item;
    });
  }

  revert(id: string): LearnedEntry {
    return this.act(id, () => this.lifecycle.revert(id));
  }

  restore(id: string, version: number): LearnedEntry {
    return this.act(id, () => this.lifecycle.restore(id, version));
  }

  accept(id: string): LearnedEntry {
    return this.act(id, () => this.lifecycle.accept(id));
  }

  promote(id: string): LearnedEntry {
    return this.act(id, () => this.lifecycle.promote(id));
  }

  // ---- export, delete, propose ---------------------------------------------------

  export(): ProfileExport {
    return this.store.exportAll();
  }

  deleteAll(): { signals: number; entries: number } {
    return this.store.deleteAll();
  }

  /** Active project entries (or the given ones) proposed as a local branch. Never pushed. */
  async propose(opts: { repo?: string; ids?: string[]; id?: string } = {}): Promise<ProjectProposal> {
    const repo = opts.repo ?? this.deps.repoRoot;
    if (!repo) throw new LearningError(400, 'NO_REPO', 'no repository to propose into');
    let entries: LearnedEntry[];
    if (opts.ids) {
      entries = opts.ids.map((id) => {
        const e = this.store.entry(id);
        if (!e) throw new LearningError(404, 'NOT_FOUND', 'no learned entry ' + id);
        return e;
      });
    } else {
      entries = this.store.entries({ status: ['active'], scope: 'project' });
    }
    try {
      return await proposeProjectKnowledge(repo, entries, opts.id ? { id: opts.id } : {});
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith('nothing to propose')) throw new LearningError(409, 'NOTHING_TO_PROPOSE', message);
      throw error;
    }
  }

  /** The context pack's knowledge source, over this profile. */
  knowledgeLoader(opts: Omit<KnowledgeLoaderDeps, 'store' | 'decisions'> = {}): KnowledgeLoader {
    return createKnowledgeLoader({ store: this.store, decisions: this.deps.decisions, ...opts });
  }

  /** A private origin stays private; a lookup that fails counts as private (fail closed). */
  private async withPrivacy(origin: SignalOrigin): Promise<SignalOrigin> {
    if (origin.private || !this.deps.isPrivate || (!origin.runId && !origin.taskId)) return origin;
    let priv: boolean;
    try {
      priv = await this.deps.isPrivate({
        ...(origin.runId ? { runId: origin.runId } : {}),
        ...(origin.taskId ? { taskId: origin.taskId } : {}),
      });
    } catch (error) {
      this.deps.onError?.(error);
      priv = true;
    }
    return priv ? { ...origin, private: true } : origin;
  }

  private act(id: string, fn: () => LearnedEntry): LearnedEntry {
    if (!this.store.entry(id)) throw new LearningError(404, 'NOT_FOUND', 'no learned entry ' + id);
    try {
      return fn();
    } catch (error) {
      const message = (error as Error).message;
      if (/has no version/.test(message)) throw new LearningError(404, 'NOT_FOUND', message);
      throw new LearningError(409, 'REFUSED', message);
    }
  }
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : Math.round(rate * 100) + '%';
}
