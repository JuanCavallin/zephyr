/**
 * The coding-agent task board (spec §10, docs/cacp-07-task-board.md).
 *
 * One board is one `task_board` run. Its tasks come from `decompose` and are shown for
 * review; NOTHING runs until `runReady`. Each started task gets its own `board_task`
 * run, branch and worktree, a write lease over its scope, and an executor (a harness
 * behind the permission bridge). A finished task goes through the merge queue onto the
 * board's integration branch; a conflict or red tests spawn a fix task.
 *
 *   createBoard   decompose only; emits task.created. The board waits for review.
 *   editBoard     split / merge / reorder / scope / update / pin, on pending or ready
 *                 tasks, applied atomically and rejected if they create a cycle.
 *   runReady      start scheduling: a task starts once its deps are done, its scope
 *                 does not overlap a task in flight, and the concurrency cap allows.
 *   inbox         "Needs you": every pending approval in the store, blocked tasks and
 *                 queued lease extensions, oldest first.
 *
 * Every decision that picks between options (routing) goes through DecisionService,
 * which has a deterministic fallback. Every native tool call goes through the
 * permission bridge, which authorizes it and checks the lease; Jev never skips that.
 */

import {
  isTerminal,
  applyTemplateToRequest,
  taskTemplate,
  toRepoPath,
  type Approval,
  type Assignee,
  type Json,
  type ProviderCallContext,
  type Run,
  type RunEvent,
  type RunStatus,
  type SignalSeam,
  type Task,
  type TaskStatus,
  type TaskTemplateId,
  type TextModelAdapter,
  type Levers,
  type VerifyPolicy,
} from '@htn/shared';
import { waitForApproval, type ApprovalOutcome } from '../core/approvalGate.js';
import { findCycle, planWaves, scopesOverlap } from '../core/coordination/conflictGraph.js';
import { decompose, DecomposeError } from '../core/coordination/decompose.js';
import { Integrator, worktreeFs, type IntentSubmission } from '../core/coordination/integrator.js';
import { LeaseTable, type ExtensionRequest } from '../core/coordination/leases.js';
import {
  MergeQueue,
  type FixTaskRequest,
  type MergeItem,
  type MergeResult,
  type TestTally,
} from '../core/coordination/mergeQueue.js';
import {
  budgetBreach,
  DEFAULT_TASK_BUDGET,
  ProgressTracker,
  transition,
  type TaskBudget,
} from '../core/coordination/stateMachine.js';
import type { DecisionService } from '../core/decisions/service.js';
import { candidateKey } from '../core/decisions/routing.js';
import { requestWordingSignal } from '../core/learning/signalLog.js';
import { InMemorySignalLog } from '../core/learning/signals.mock.js';
import { createPermissionBridge, type Authorizer } from '../core/tools/permissionBridge.js';
import type { Exec } from '../core/verify/publish.js';
import { newId, nowIso } from '../lib/ids.js';
import { createMockHarness, type MockHarnessStep } from '../providers/mockharness/index.js';
import type { Store } from '../store/types.js';
import { execArgv } from './publish.service.js';

export const BOARD_KIND = 'task_board';
export const BOARD_TASK_KIND = 'board_task';
export const MERGE_POLICY_RULE = 'merge-queue-git-publish';
export const ROUTE_POLICY_RULE = 'task-routing';
export const DEFAULT_CONCURRENCY = 2;

/* -------------------------------------------------------------------------- */
/* Executor contract                                                          */
/* -------------------------------------------------------------------------- */

export class BudgetBreachError extends Error {
  readonly code = 'TASK_BUDGET';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetBreachError';
  }
}

export interface TaskExecutionContext {
  task: Task;
  /** The task's own run. Tool calls are recorded on it. */
  taskRunId: string;
  stepId: string;
  worktree: string;
  leases: LeaseTable;
  tracker: ProgressTracker;
  signal: AbortSignal;
  emit(event: RunEvent): Promise<void>;
  /** Publish progress; throws BudgetBreachError when the task is over budget or stuck. */
  step(): Promise<void>;
  /**
   * The board's template policy, when it was created from one. Executors that drive a
   * real harness apply it; the scripted harness ignores it.
   */
  policy?: BoardPolicy;
  /** A hot-file change (package.json, barrels): applied and committed by the integrator. */
  submitIntent(sub: Omit<IntentSubmission, 'taskId'>): Promise<{ status: 'applied' | 'rejected'; error?: string }>;
}

export type TaskExecutor = (ctx: TaskExecutionContext) => Promise<{ status: 'done' | 'failed'; detail?: string }>;

/**
 * A concrete file for each scope glob, so the scripted harness has something to write.
 * Not `index.ts`: barrel files are hot and never leased.
 */
export function concreteScopePath(glob: string): string {
  if (!/[*?[{]/.test(glob)) return glob;
  const base = glob.split('/').filter((s) => !/[*?[{]/.test(s));
  return [...base, 'main.ts'].join('/');
}

export function defaultTaskScript(task: Task): MockHarnessStep[] {
  const paths = [...new Set(task.writeScope.map(concreteScopePath))];
  const steps: MockHarnessStep[] = paths.map((path) => ({
    tool: 'Write',
    path,
    content: '// ' + task.title + '\nexport const ready = false;\n',
  }));
  if (paths[0]) steps.push({ tool: 'Edit', path: paths[0], find: 'ready = false', replace: 'ready = true' });
  return steps;
}

/**
 * The offline executor: the scripted mockharness, every tool call through the real
 * permission bridge (authorization + lease). A denied write is emitted as
 * `lease.denied` by the lease table itself.
 */
export function mockHarnessExecutor(
  opts: {
    script?: (task: Task) => MockHarnessStep[];
    intents?: (task: Task) => Omit<IntentSubmission, 'taskId'>[];
    authorize?: Authorizer;
  } = {},
): TaskExecutor {
  return async (ctx) => {
    const bridge = createPermissionBridge({
      harness: 'mockharness',
      worktree: ctx.worktree,
      run: { runId: ctx.taskRunId, stepId: ctx.stepId },
      leases: ctx.leases,
      ...(opts.authorize ? { authorize: opts.authorize } : {}),
    });
    const harness = createMockHarness({
      decide: async (req) => (await bridge.decide(req, ctx.signal)).verdict,
    });
    const pctx: ProviderCallContext = { runId: ctx.taskRunId, policyRule: 'board-task:mockharness' };
    try {
      const script = (opts.script ?? defaultTaskScript)(ctx.task);
      const started = await harness.startTask(
        { goal: ctx.task.title, context: { workspaceDir: ctx.worktree, script, taskId: ctx.task.id } },
        pctx,
      );
      if (!started.ok) return { status: 'failed', detail: started.error.message };
      for (;;) {
        if (ctx.signal.aborted) return { status: 'failed', detail: 'cancelled' };
        const polled = await harness.pollTask(started.data.taskId, pctx);
        if (!polled.ok) return { status: 'failed', detail: polled.error.message };
        const partial = polled.data.partial as { filesChanged?: string[] } | undefined;
        ctx.tracker.observeFiles(partial?.filesChanged ?? []);
        ctx.tracker.observeTurn();
        await ctx.step();
        if (polled.data.status === 'done') break;
        if (polled.data.status === 'failed')
          return { status: 'failed', detail: polled.data.log?.at(-1) ?? 'harness failed' };
      }
      for (const intent of opts.intents?.(ctx.task) ?? []) {
        const r = await ctx.submitIntent(intent);
        if (r.status === 'rejected') return { status: 'failed', detail: 'intent rejected: ' + (r.error ?? intent.description) };
      }
      return { status: 'done' };
    } finally {
      await harness.dispose();
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export class BoardError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}

export interface BoardServiceDeps {
  store: Store;
  emit(runId: string, event: RunEvent): Promise<unknown>;
  /** The planner's text model, for decomposition. */
  complete: TextModelAdapter['complete'];
  decisions: Pick<DecisionService, 'routeTask'>;
  /** Assignees routing may pick from. Default: mockharness cheap + standard, and a person. */
  candidates?: Assignee[];
  /** Create a worktree for a run, on branch `zephyr/<runId>`, from `base`. */
  openWorkspace(runId: string, base?: string): Promise<{ path: string; branch: string }>;
  closeWorkspace?(runId: string, status: RunStatus, opts?: { keepBranch?: boolean }): Promise<unknown>;
  executor?: TaskExecutor;
  exec?: Exec;
  /** The tests the merge queue reruns on the rebased tree. */
  runTests(item: MergeItem, signal?: AbortSignal): Promise<TestTally>;
  evidence?(item: MergeItem, tests: TestTally): Promise<void> | void;
  signals?: SignalSeam;
  /**
   * A task reached a final outcome: merged (passed) or rejected (failed). The learning
   * loop records it against the skills the run loaded and starts a pass. Must not throw
   * and must not block; the board never waits on learning.
   */
  onTaskFinished?(t: { taskId: string; runId?: string; outcome: 'passed' | 'failed' }): void;
  budget?: TaskBudget;
  leaseTtlMs?: number;
}

/** What a template sets on a board's runs (docs/cacp-09, templates). */
export interface BoardPolicy {
  levers: Levers;
  verify: Pick<VerifyPolicy, 'protectDefaults' | 'fullSuiteBeforePublish'> & { protectedGlobs: string[] };
}

export interface CreateBoardInput {
  request: string;
  /** Preset policy, budget and concurrency (packages/shared/src/templates.ts). */
  template?: TaskTemplateId;
  repoFiles?: string[];
  /** A private-route board: routing never sends it to a remote decision model. */
  private?: boolean;
  /** Base ref the integration branch starts from. */
  base?: string;
}

export type BoardEditOp =
  | { op: 'split'; taskId: string; parts: Array<{ title: string; acceptance?: string; writeScope: string[] }> }
  | { op: 'merge'; taskIds: string[]; title?: string; acceptance?: string }
  | { op: 'reorder'; order: string[] }
  | { op: 'scope'; taskId: string; writeScope: string[] }
  | { op: 'update'; taskId: string; title?: string; acceptance?: string; dependsOn?: string[] }
  | { op: 'pin'; taskId: string; assignee: Assignee | null };

export interface BoardView {
  run: Run;
  tasks: Task[];
  /** Tasks grouped by when they can run, dependencies and scope overlaps respected. */
  waves: string[][];
}

export type InboxItem =
  | { kind: 'approval'; at: string; boardRunId?: string; taskId?: string; approval: Approval }
  | { kind: 'blocked_task'; at: string; boardRunId: string; taskId: string; title: string; reason: string }
  | { kind: 'lease_extension'; at: string; boardRunId: string; taskId: string; request: ExtensionRequest };

interface Board {
  run: Run;
  private: boolean;
  base: string;
  tasks: Map<string, Task>;
  order: string[];
  items: Map<string, MergeItem>;
  fixParents: Map<string, string>;
  leases: LeaseTable;
  integration?: { worktree: string; branch: string };
  queue?: MergeQueue;
  integrator?: Integrator;
  started: boolean;
  concurrency: number;
  autoMergeGreen: boolean;
  /** Per-task budget from the board's template; overrides the service default. */
  budget?: TaskBudget;
  policy?: BoardPolicy;
  inFlight: Set<string>;
  active: Set<Promise<unknown>>;
  pumping: Promise<void>;
  abort: AbortController;
}

const DEFAULT_CANDIDATES: Assignee[] = [
  { kind: 'agent', harness: 'mockharness', tier: 'cheap' },
  { kind: 'agent', harness: 'mockharness', tier: 'standard' },
  { kind: 'human', reason: 'reviewer' },
];

const EDITABLE: readonly TaskStatus[] = ['pending', 'ready'];

export class BoardService {
  private readonly boards = new Map<string, Board>();
  private readonly listeners = new Set<() => void>();
  private readonly exec: Exec;
  private readonly signals: SignalSeam;

  constructor(private readonly deps: BoardServiceDeps) {
    this.exec = deps.exec ?? execArgv;
    this.signals = deps.signals ?? new InMemorySignalLog();
  }

  /* --------------------------------- reads -------------------------------- */

  async getBoard(boardId: string): Promise<BoardView> {
    const b = this.boards.get(boardId);
    if (b) {
      const tasks = this.ordered(b);
      return { run: b.run, tasks, waves: this.waves(tasks) };
    }
    const run = await this.deps.store.getRun(boardId);
    if (!run || run.kind !== BOARD_KIND) throw new BoardError('NOT_FOUND', 'Board ' + boardId + ' not found');
    const stored = (run.result as { tasks?: Task[] } | undefined)?.tasks ?? [];
    return { run, tasks: stored, waves: this.waves(stored) };
  }

  /**
   * Whether a run or task belongs to a private board: the board's own run, a task's run, or a
   * task id. Signals from the UI use this so a client cannot launder a private board's
   * feedback into a remote model by leaving out the private flag.
   */
  async isPrivate(origin: { runId?: string; taskId?: string }): Promise<boolean> {
    const { runId, taskId } = origin;
    if (!runId && !taskId) return false;
    for (const b of this.boards.values()) {
      if (!b.private) continue;
      if (runId && b.run.id === runId) return true;
      for (const t of b.tasks.values()) if ((taskId && t.id === taskId) || (runId && t.runId === runId)) return true;
    }
    if (runId && !this.boards.has(runId)) {
      const run = await this.deps.store.getRun(runId).catch(() => undefined);
      if (run?.kind === BOARD_KIND && (run.input as { private?: boolean } | undefined)?.private === true) return true;
    }
    return false;
  }

  /** Resolves once nothing on the board is executing or merging. For tests and shutdown. */
  async whenIdle(boardId: string): Promise<void> {
    const b = this.must(boardId);
    for (;;) {
      await b.pumping;
      if (b.active.size === 0) return;
      await Promise.allSettled([...b.active]);
    }
  }

  /** "Needs you": everything waiting on a person, oldest first. */
  async inbox(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    const runs = await this.deps.store.listRuns({ limit: 10_000 });
    const taskOfRun = new Map<string, { boardRunId: string; taskId: string }>();
    for (const b of this.boards.values())
      for (const t of b.tasks.values()) if (t.runId) taskOfRun.set(t.runId, { boardRunId: b.run.id, taskId: t.id });
    for (const run of runs) {
      if (isTerminal(run.status)) continue;
      for (const approval of await this.deps.store.listApprovals(run.id)) {
        if (approval.status !== 'pending') continue;
        items.push({ kind: 'approval', at: approval.createdAt, ...taskOfRun.get(run.id), approval });
      }
    }
    for (const b of this.boards.values()) {
      for (const t of b.tasks.values())
        if (t.status === 'blocked')
          items.push({
            kind: 'blocked_task',
            at: t.updatedAt,
            boardRunId: b.run.id,
            taskId: t.id,
            title: t.title,
            reason: t.reason ?? 'blocked',
          });
      for (const r of b.leases.pending())
        items.push({
          kind: 'lease_extension',
          at: r.requestedAt,
          boardRunId: b.run.id,
          taskId: r.taskId,
          request: { ...r, globs: [...r.globs], blockedBy: [...r.blockedBy] },
        });
    }
    return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  /** Called whenever the inbox may have changed (an SSE stream re-sends it). */
  onInboxChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* -------------------------------- create -------------------------------- */

  async createBoard(input: CreateBoardInput): Promise<BoardView> {
    const at = nowIso();
    const template = input.template ? taskTemplate(input.template) : undefined;
    const request = template ? applyTemplateToRequest(input.request, template) : input.request;
    const run = await this.deps.store.createRun({
      id: newId('run'),
      kind: BOARD_KIND,
      title: 'Board: ' + input.request.split(/\r?\n/)[0]!.slice(0, 80),
      status: 'pending',
      input: {
        request: input.request,
        private: input.private ?? false,
        ...(template ? { template: template.id } : {}),
      } as Json,
      createdAt: at,
      updatedAt: at,
    });
    const b: Board = {
      run,
      private: input.private ?? false,
      base: input.base ?? 'HEAD',
      tasks: new Map(),
      order: [],
      items: new Map(),
      fixParents: new Map(),
      leases: undefined as unknown as LeaseTable,
      started: false,
      concurrency: template?.concurrency ?? DEFAULT_CONCURRENCY,
      autoMergeGreen: template?.autoMergeGreen ?? false,
      ...(template
        ? {
            budget: { ...template.budget },
            policy: { levers: { ...template.levers }, verify: { ...template.verify, protectedGlobs: [...template.verify.protectedGlobs] } },
          }
        : {}),
      inFlight: new Set(),
      active: new Set(),
      pumping: Promise.resolve(),
      abort: new AbortController(),
    };
    b.leases = new LeaseTable({
      ...(this.deps.leaseTtlMs ? { ttlMs: this.deps.leaseTtlMs } : {}),
      onEvent: (e) => {
        void this.emit(b, e);
        this.changed();
      },
    });
    this.boards.set(run.id, b);
    await this.emit(b, { type: 'run.updated', run });
    // How the user asks is the weakest preference signal; recording it never blocks the board.
    if (input.request.trim()) {
      void Promise.resolve()
        .then(() => this.signals.recordSignal(requestWordingSignal(input.request, { runId: run.id, private: b.private })))
        .catch(() => undefined);
    }

    try {
      const plan = await decompose(
        { runId: run.id, request, ...(input.repoFiles ? { repoFiles: input.repoFiles } : {}) },
        { complete: this.deps.complete },
      );
      const ids = new Map(plan.tasks.map((t) => [t.id, newId('task')]));
      for (const d of plan.tasks) {
        const task: Task = {
          id: ids.get(d.id)!,
          boardRunId: run.id,
          title: d.title,
          acceptance: d.acceptance,
          writeScope: [...d.writeScope],
          dependsOn: d.deps.map((x) => ids.get(x)!).filter(Boolean),
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        };
        b.tasks.set(task.id, task);
        b.order.push(task.id);
        await this.emit(b, { type: 'task.created', task: { ...task } });
      }
      await this.patchBoard(b, { summary: plan.tasks.length + ' tasks proposed; review, then run ready tasks' });
    } catch (err) {
      const message = err instanceof DecomposeError ? err.message : 'decomposition failed: ' + (err as Error).message;
      await this.patchBoard(b, { status: 'failed', error: { code: 'DECOMPOSE', message }, summary: message });
    }
    return this.getBoard(run.id);
  }

  /* --------------------------------- edits -------------------------------- */

  async editBoard(boardId: string, ops: BoardEditOp[]): Promise<BoardView> {
    const b = this.must(boardId);
    if (isTerminal(b.run.status)) throw new BoardError('CONFLICT', 'Board ' + boardId + ' is finished');
    const tasks = new Map([...b.tasks].map(([k, v]) => [k, { ...v, writeScope: [...v.writeScope], dependsOn: [...v.dependsOn] }]));
    let order = [...b.order];
    const at = nowIso();
    const created = new Set<string>();
    const removed = new Set<string>();
    const touched = new Set<string>();
    const editable = (id: string): Task => {
      const t = tasks.get(id);
      if (!t) throw new BoardError('NOT_FOUND', 'Task ' + id + ' not found');
      if (!EDITABLE.includes(t.status)) throw new BoardError('CONFLICT', 'Task ' + id + ' is ' + t.status + '; only pending or ready tasks can be edited');
      return t;
    };
    const scope = (paths: string[]): string[] => {
      const out = paths.map((p) => toRepoPath(p));
      if (out.some((p) => !p) || out.length === 0) throw new BoardError('INVALID', 'write scope must be non-empty repo-relative paths');
      return [...new Set(out as string[])];
    };
    const rewire = (from: string[], to: string[]) => {
      for (const t of tasks.values()) {
        if (!t.dependsOn.some((d) => from.includes(d))) continue;
        t.dependsOn = [...new Set([...t.dependsOn.filter((d) => !from.includes(d)), ...to])].filter((d) => d !== t.id);
        touched.add(t.id);
      }
    };
    const add = (t: Task, at: number) => {
      tasks.set(t.id, t);
      order.splice(at, 0, t.id);
      created.add(t.id);
    };
    const drop = (id: string) => {
      tasks.delete(id);
      order = order.filter((x) => x !== id);
      if (created.has(id)) created.delete(id);
      else removed.add(id);
      touched.delete(id);
    };

    for (const op of ops) {
      switch (op.op) {
        case 'split': {
          const t = editable(op.taskId);
          if (op.parts.length < 2) throw new BoardError('INVALID', 'split needs at least two parts');
          const pos = order.indexOf(t.id);
          const parts = op.parts.map((p, i) => ({
            ...t,
            id: newId('task'),
            title: p.title,
            acceptance: p.acceptance ?? t.acceptance,
            writeScope: scope(p.writeScope),
            dependsOn: [...t.dependsOn],
            status: 'pending' as const,
            createdAt: at,
            updatedAt: at,
            _i: i,
          }));
          drop(t.id);
          parts.forEach(({ _i, ...p }) => add(p, pos + _i));
          rewire([t.id], parts.map((p) => p.id));
          break;
        }
        case 'merge': {
          if (op.taskIds.length < 2) throw new BoardError('INVALID', 'merge needs at least two tasks');
          const parts = op.taskIds.map(editable);
          const ids = parts.map((p) => p.id);
          const pos = Math.min(...ids.map((id) => order.indexOf(id)));
          const first = parts[0]!;
          const merged: Task = {
            ...first,
            id: newId('task'),
            title: op.title ?? parts.map((p) => p.title).join(' + '),
            acceptance: op.acceptance ?? parts.map((p) => p.acceptance).join(' '),
            writeScope: [...new Set(parts.flatMap((p) => p.writeScope))],
            dependsOn: [...new Set(parts.flatMap((p) => p.dependsOn))].filter((d) => !ids.includes(d)),
            status: 'pending',
            createdAt: at,
            updatedAt: at,
          };
          delete merged.assignee;
          delete merged.pinned;
          for (const id of ids) drop(id);
          add(merged, pos);
          rewire(ids, [merged.id]);
          break;
        }
        case 'reorder': {
          const same = op.order.length === order.length && op.order.every((id) => order.includes(id));
          if (!same) throw new BoardError('INVALID', 'reorder must list every task exactly once');
          order = [...op.order];
          break;
        }
        case 'scope': {
          const t = editable(op.taskId);
          t.writeScope = scope(op.writeScope);
          touched.add(t.id);
          break;
        }
        case 'update': {
          const t = editable(op.taskId);
          if (op.title !== undefined) t.title = op.title;
          if (op.acceptance !== undefined) t.acceptance = op.acceptance;
          if (op.dependsOn !== undefined) {
            for (const d of op.dependsOn) if (!tasks.has(d) || d === t.id) throw new BoardError('INVALID', 'unknown dependency ' + d);
            t.dependsOn = [...new Set(op.dependsOn)];
          }
          touched.add(t.id);
          break;
        }
        case 'pin': {
          const t = editable(op.taskId);
          if (op.assignee) {
            t.assignee = op.assignee;
            t.pinned = true;
          } else {
            delete t.assignee;
            delete t.pinned;
          }
          touched.add(t.id);
          break;
        }
      }
    }

    const cycle = findCycle([...tasks.values()].map((t) => ({ id: t.id, writeScope: t.writeScope, dependsOn: t.dependsOn })));
    if (cycle) throw new BoardError('INVALID', 'edit creates a dependency cycle: ' + cycle.join(' -> '));

    // A ready task whose new deps are not done goes back to pending.
    for (const t of tasks.values()) {
      if (t.status === 'ready' && t.dependsOn.some((d) => tasks.get(d)?.status !== 'done')) {
        t.status = 'pending';
        touched.add(t.id);
      }
      if (touched.has(t.id) || created.has(t.id)) t.updatedAt = at;
    }

    b.tasks = tasks;
    b.order = order;
    for (const id of removed) await this.emit(b, { type: 'task.removed', taskId: id, at });
    for (const id of order) {
      const t = tasks.get(id)!;
      if (created.has(id)) await this.emit(b, { type: 'task.created', task: { ...t } });
      else if (touched.has(id)) await this.emit(b, { type: 'task.updated', task: { ...t } });
    }
    await this.persist(b);
    if (b.started) this.pump(b);
    return this.getBoard(boardId);
  }

  /* ---------------------------------- run --------------------------------- */

  async runReady(boardId: string, opts: { concurrency?: number; autoMergeGreen?: boolean } = {}): Promise<BoardView> {
    const b = this.must(boardId);
    if (isTerminal(b.run.status)) throw new BoardError('CONFLICT', 'Board ' + boardId + ' is finished');
    if (b.tasks.size === 0) throw new BoardError('CONFLICT', 'Board ' + boardId + ' has no tasks');
    b.concurrency = Math.max(1, opts.concurrency ?? b.concurrency);
    b.autoMergeGreen = opts.autoMergeGreen ?? b.autoMergeGreen;
    if (!b.integration) {
      const ws = await this.deps.openWorkspace(b.run.id, b.base);
      b.integration = { worktree: ws.path, branch: ws.branch };
      b.integrator = new Integrator({
        fs: worktreeFs(ws.path),
        onUpdate: (intent, error) => void this.emit(b, { type: 'intent.updated', intent, ...(error ? { error } : {}) }),
      });
      b.queue = this.mergeQueue(b);
    }
    b.started = true;
    if (b.run.status !== 'running') await this.patchBoard(b, { status: 'running', summary: 'Running ready tasks' });
    this.pump(b);
    return this.getBoard(boardId);
  }

  /** A blocked task (stuck, over budget, needs a person) goes back to ready. */
  async resumeTask(boardId: string, taskId: string, assignee?: Assignee): Promise<Task> {
    const b = this.must(boardId);
    const t = b.tasks.get(taskId);
    if (!t) throw new BoardError('NOT_FOUND', 'Task ' + taskId + ' not found');
    if (t.status !== 'blocked') throw new BoardError('CONFLICT', 'Task ' + taskId + ' is ' + t.status + ', not blocked');
    if (assignee) {
      t.assignee = assignee;
      t.pinned = true;
    }
    await this.move(b, taskId, 'ready');
    this.changed();
    if (b.started) this.pump(b);
    return { ...b.tasks.get(taskId)! };
  }

  decideExtension(boardId: string, requestId: string, outcome: 'approve' | 'reject') {
    const b = this.must(boardId);
    const r = b.leases.decideExtension(requestId, outcome);
    if (!r) throw new BoardError('NOT_FOUND', 'Extension request ' + requestId + ' not found');
    this.changed();
    return r;
  }

  /** A running task asks to write outside its lease. Queued requests land in the inbox. */
  requestExtension(boardId: string, taskId: string, globs: string[]) {
    const b = this.must(boardId);
    if (!b.tasks.has(taskId)) throw new BoardError('NOT_FOUND', 'Task ' + taskId + ' not found');
    const r = b.leases.requestExtension(taskId, globs);
    this.changed();
    return r;
  }

  /** Leases of a board, for tools that request an extension on a task's behalf. */
  leasesOf(boardId: string): LeaseTable {
    return this.must(boardId).leases;
  }

  async cancel(boardId: string): Promise<void> {
    const b = this.must(boardId);
    b.abort.abort();
    b.started = false;
    await this.whenIdle(boardId).catch(() => undefined);
    await this.patchBoard(b, { status: 'cancelled', summary: 'Cancelled' });
  }

  /* ------------------------------- scheduler ------------------------------ */

  private pump(b: Board): void {
    b.pumping = b.pumping.then(() => this.pumpOnce(b)).catch(async (err) => {
      await this.log(b, 'error', 'scheduler: ' + (err as Error).message);
    });
  }

  private async pumpOnce(b: Board): Promise<void> {
    if (!b.started || b.abort.signal.aborted) return;
    for (const id of b.order) {
      const t = b.tasks.get(id);
      if (t?.status === 'pending' && t.dependsOn.every((d) => b.tasks.get(d)?.status === 'done')) await this.move(b, id, 'ready');
    }
    for (const id of b.order) {
      if (b.inFlight.size >= b.concurrency) break;
      const t = b.tasks.get(id);
      if (!t || t.status !== 'ready' || b.inFlight.has(id)) continue;
      const busy = [...b.inFlight].map((x) => b.tasks.get(x)!.writeScope);
      if (busy.some((s) => scopesOverlap(s, t.writeScope))) continue;
      b.inFlight.add(id);
      const work = this.runOne(b, id)
        .catch(async (err) => {
          const cur = b.tasks.get(id);
          const reason = 'internal error: ' + (err as Error).message;
          if (cur && !['done', 'failed'].includes(cur.status)) await this.move(b, id, 'failed', { reason }).catch(() => undefined);
          await this.log(b, 'error', 'task ' + id + ': ' + (err as Error).message);
        })
        .finally(() => {
          b.inFlight.delete(id);
          b.active.delete(work);
          this.pump(b);
        });
      b.active.add(work);
    }
    await this.maybeFinish(b);
  }

  private async maybeFinish(b: Board): Promise<void> {
    if (isTerminal(b.run.status) || b.inFlight.size || b.active.size) return;
    const tasks = [...b.tasks.values()];
    if (!tasks.length || !tasks.every((t) => t.status === 'done' || t.status === 'failed')) return;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    await this.patchBoard(b, {
      status: failed ? 'failed' : 'succeeded',
      summary: failed ? failed + ' of ' + tasks.length + ' tasks failed' : 'All ' + tasks.length + ' tasks merged',
    });
  }

  /** Route, open the worktree, lease, execute, release, then merge. */
  private async runOne(b: Board, taskId: string): Promise<void> {
    const { store } = this.deps;
    let task = b.tasks.get(taskId)!;
    const depth = this.fixDepth(b, taskId);

    // 1. Route. A pin wins; Jev picks otherwise; the rules decide when Jev cannot.
    const pool = this.deps.candidates ?? DEFAULT_CANDIDATES;
    const route = await this.deps.decisions.routeTask(
      { sanitizedForRemote: !b.private, dataLabels: [] },
      task,
      pool.map((a) => ({
        key: candidateKey(a),
        assignee: a,
        history: this.history(a),
        load: this.load(a),
        designPreferences: 0,
      })),
      { runId: b.run.id, policyRule: ROUTE_POLICY_RULE },
      depth,
    );
    await this.log(b, 'info', 'routed ' + taskId + ' to ' + candidateKey(route.assignee) + ' (' + route.source + ')');
    if (route.assignee.kind === 'human') {
      task.assignee = route.assignee;
      await this.move(b, taskId, 'blocked', { reason: 'needs a person: ' + (route.assignee.reason ?? 'routed to a human') });
      this.changed();
      return;
    }

    // 2. The task's own run, branch and worktree.
    const at = nowIso();
    let taskRun = task.runId ? await store.getRun(task.runId) : null;
    if (!taskRun) {
      taskRun = await store.createRun({
        id: newId('run'),
        kind: BOARD_TASK_KIND,
        title: task.title,
        status: 'running',
        input: { boardRunId: b.run.id, taskId, writeScope: task.writeScope } as Json,
        createdAt: at,
        updatedAt: at,
      });
    } else {
      taskRun = await store.patchRun(taskRun.id, { status: 'running', updatedAt: at });
    }
    await this.emit(b, { type: 'run.updated', run: taskRun }, taskRun.id);
    let item = b.items.get(taskId);
    if (!item) {
      const parent = b.fixParents.get(taskId);
      const inherited = parent ? b.items.get(parent) : undefined;
      if (inherited) item = { ...inherited, task };
      else {
        const ws = await this.deps.openWorkspace(taskRun.id, b.integration!.branch);
        item = { task, worktree: ws.path, branch: ws.branch };
      }
      b.items.set(taskId, item);
    }
    task = this.set(b, { ...task, runId: taskRun.id, branch: item.branch });

    // 3. Lease the write scope.
    const acquired = b.leases.acquire(taskId, task.writeScope);
    if (!acquired.ok) {
      await this.move(b, taskId, 'blocked', { reason: 'lease: ' + acquired.message });
      await this.finishTaskRun(taskRun.id, 'paused', acquired.message);
      this.changed();
      return;
    }
    await this.move(b, taskId, 'running', { assignee: route.assignee });

    // 4. Execute.
    const step = await store.appendStep({
      id: newId('step'),
      runId: taskRun.id,
      parentStepId: null,
      kind: 'harness',
      label: 'Run ' + candidateKey(route.assignee),
      status: 'running',
      input: { taskId, writeScope: task.writeScope, assignee: candidateKey(route.assignee) } as Json,
      startedAt: nowIso(),
    });
    await this.emit(b, { type: 'step.upserted', step }, taskRun.id);
    const tracker = new ProgressTracker(taskId, taskRun.id);
    const budget = { ...DEFAULT_TASK_BUDGET, ...this.deps.budget, ...b.budget };
    const executor = this.deps.executor ?? mockHarnessExecutor();
    let outcome: { status: 'done' | 'failed'; detail?: string };
    try {
      outcome = await executor({
        task: { ...task },
        taskRunId: taskRun.id,
        stepId: step.id,
        worktree: item.worktree,
        leases: b.leases,
        tracker,
        signal: b.abort.signal,
        ...(b.policy ? { policy: b.policy } : {}),
        emit: async (e) => void (await this.emit(b, e)),
        step: async () => {
          const progress = tracker.snapshot();
          this.set(b, { ...b.tasks.get(taskId)!, progress });
          await this.emit(b, { type: 'task.progress', taskId, progress, at: nowIso() });
          const breach = budgetBreach(tracker, budget);
          if (breach) throw new BudgetBreachError(breach);
        },
        submitIntent: (sub) => this.submitIntent(b, { ...sub, taskId }),
      });
    } catch (err) {
      if (!(err instanceof BudgetBreachError)) throw err;
      b.leases.release(taskId);
      await this.endStep(taskRun.id, step.id, 'blocked', err.message);
      await this.move(b, taskId, 'blocked', { reason: err.message });
      await this.finishTaskRun(taskRun.id, 'paused', err.message);
      this.changed();
      return;
    }
    b.leases.release(taskId);
    // A harness that "finished" without changing a file (every write denied, say) has
    // nothing to merge: an empty fast-forward is not a landed task.
    if (outcome.status === 'done' && tracker.snapshot().filesChanged === 0)
      outcome = { status: 'failed', detail: 'finished without changing any file' };
    if (outcome.status === 'failed') {
      const reason = outcome.detail ?? 'executor failed';
      await this.endStep(taskRun.id, step.id, 'failed', reason);
      await this.move(b, taskId, 'failed', { reason });
      await this.finishTaskRun(taskRun.id, 'failed', reason);
      this.taskFinished(b.tasks.get(taskId)!, 'failed');
      return;
    }
    await this.endStep(taskRun.id, step.id, 'succeeded');

    // 5. Merge.
    await this.move(b, taskId, 'review');
    const result = await b.queue!.enqueue({ ...item, task: { ...b.tasks.get(taskId)! } }, b.abort.signal);
    await this.afterMerge(b, taskId, result);
  }

  private async afterMerge(b: Board, taskId: string, result: MergeResult): Promise<void> {
    const task = b.tasks.get(taskId)!;
    switch (result.outcome) {
      case 'merged': {
        await this.move(b, taskId, 'done');
        await this.finishTaskRun(task.runId!, 'succeeded', 'merged ' + (result.commit ?? '').slice(0, 12));
        this.taskFinished(task, 'passed');
        // A merged fix finishes the task it was fixing, and that one's parent in turn.
        let parent = b.fixParents.get(taskId);
        while (parent) {
          const p = b.tasks.get(parent);
          if (p && p.status === 'review') {
            await this.move(b, parent, 'done');
            if (p.runId) await this.finishTaskRun(p.runId, 'succeeded', 'merged via ' + taskId);
          }
          parent = b.fixParents.get(parent);
        }
        return;
      }
      case 'awaiting_approval':
        this.changed();
        return;
      case 'conflict':
      case 'tests_failed':
        // The fix task carries the work; this one stays in review until it lands.
        return;
      case 'rejected': {
        if (result.fixTaskId) return;
        const reason = result.detail ?? 'merge rejected';
        await this.move(b, taskId, 'failed', { reason });
        await this.failChainParents(b, taskId, reason);
        if (task.runId) await this.finishTaskRun(task.runId, 'failed', reason);
        this.taskFinished(task, 'failed');
        return;
      }
    }
  }

  private taskFinished(task: Task, outcome: 'passed' | 'failed'): void {
    try {
      this.deps.onTaskFinished?.({ taskId: task.id, ...(task.runId ? { runId: task.runId } : {}), outcome });
    } catch {
      // Learning is off the critical path.
    }
  }

  private async failChainParents(b: Board, taskId: string, reason: string): Promise<void> {
    let parent = b.fixParents.get(taskId);
    while (parent) {
      const p = b.tasks.get(parent);
      if (p && p.status === 'review') {
        await this.move(b, parent, 'failed', { reason: 'fix ' + taskId + ' failed: ' + reason });
        if (p.runId) await this.finishTaskRun(p.runId, 'failed', reason);
      }
      parent = b.fixParents.get(parent);
    }
  }

  private mergeQueue(b: Board): MergeQueue {
    return new MergeQueue({
      exec: this.exec,
      integration: b.integration!,
      runTests: (item, signal) => this.deps.runTests(item, signal),
      ...(this.deps.evidence ? { evidence: this.deps.evidence } : {}),
      approve: (item, tests) => this.requestMergeApproval(b, item, tests),
      createFixTask: (req) => this.createFixTask(b, req),
      signals: this.signals,
      emit: (r) => void this.emit(b, { type: 'merge.result', ...r }),
      policy: { autoMergeGreen: b.autoMergeGreen },
      privateRun: b.private,
    });
  }

  private createFixTask(b: Board, req: FixTaskRequest): { id: string } {
    const at = nowIso();
    const depth = this.fixDepth(b, req.parent.id) + 1;
    // Pinned back to the same agent, until it has failed twice: then routing escalates.
    const pin = req.pinned && depth < 2 && req.assignee;
    const fix: Task = {
      id: newId('task'),
      boardRunId: b.run.id,
      title: req.title,
      acceptance: req.acceptance + ' (' + req.context.detail + ')',
      writeScope: [...req.writeScope],
      dependsOn: [],
      status: 'pending',
      ...(req.assignee ? { assignee: req.assignee } : {}),
      ...(pin ? { pinned: true } : {}),
      createdAt: at,
      updatedAt: at,
    };
    b.tasks.set(fix.id, fix);
    b.order.splice(b.order.indexOf(req.parent.id) + 1, 0, fix.id);
    b.fixParents.set(fix.id, req.parent.id);
    void this.emit(b, { type: 'task.created', task: { ...fix } });
    return { id: fix.id };
  }

  private async requestMergeApproval(b: Board, item: MergeItem, tests: TestTally) {
    const { store } = this.deps;
    const taskId = item.task.id;
    const runId = item.task.runId!;
    const into = b.integration!.branch;
    const step = await store.appendStep({
      id: newId('step'),
      runId,
      parentStepId: null,
      kind: 'merge',
      label: 'Merge ' + item.branch + ' into ' + into,
      status: 'blocked',
      riskClass: 'ask_human',
      startedAt: nowIso(),
    });
    const question =
      'Merge "' + item.task.title + '" (' + item.branch + ') into ' + into + '? ' + tests.passed + ' tests passed.';
    const proposedAction = {
      kind: 'git.publish',
      taskId,
      branch: item.branch,
      into,
      tests: { passed: tests.passed, failed: tests.failed },
    };
    const approval: Approval = {
      id: newId('apr'),
      runId,
      stepId: step.id,
      question,
      proposedAction,
      reversibility: 'recoverable',
      riskClass: 'ask_human',
      policyRule: MERGE_POLICY_RULE,
      status: 'pending',
      createdAt: nowIso(),
    };
    await store.createApproval(approval);
    // Register the waiter before anyone can see the approval, so a fast decision lands.
    const waiting = waitForApproval(approval.id, {
      kind: 'git.publish',
      description: question,
      reversibility: 'recoverable',
      payload: proposedAction,
    } as never);
    const blocked = await store.patchStep(step.id, { approvalId: approval.id });
    const run = await store.patchRun(runId, { status: 'awaiting_approval', updatedAt: nowIso() });
    await this.emit(b, { type: 'step.upserted', step: blocked }, runId);
    await this.emit(b, { type: 'run.updated', run }, runId);
    await this.emit(b, { type: 'approval.requested', approval }, runId);
    void waiting.then(
      (outcome) => this.track(b, this.afterApproval(b, taskId, approval.id, step.id, outcome)),
      () => undefined,
    );
    this.changed();
    return { status: 'pending' as const, approvalId: approval.id };
  }

  private async afterApproval(
    b: Board,
    taskId: string,
    approvalId: string,
    stepId: string,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    const { store } = this.deps;
    const task = b.tasks.get(taskId)!;
    const note = (await store.getApproval(approvalId))?.note;
    const run = await store.patchRun(task.runId!, { status: 'running', updatedAt: nowIso() });
    await this.emit(b, { type: 'run.updated', run }, run.id);
    const result = await b.queue!.resolveApproval(
      taskId,
      { outcome: outcome.verdict, ...(note ? { comment: note } : {}) },
      b.abort.signal,
    );
    await this.endStep(task.runId!, stepId, result.outcome === 'merged' ? 'succeeded' : 'failed', result.detail);
    await this.afterMerge(b, taskId, result);
    this.changed();
    this.pump(b);
  }

  private async submitIntent(b: Board, sub: IntentSubmission) {
    return b.queue!.exclusive(async () => {
      const intent = await b.integrator!.submit(sub);
      if (intent.status !== 'applied') {
        const error = b.integrator!.errorOf(intent.id);
        return { status: 'rejected' as const, ...(error ? { error } : {}) };
      }
      const wt = b.integration!.worktree;
      const dirty = await this.exec('git', ['status', '--porcelain'], { cwd: wt });
      if (dirty.code === 0 && dirty.stdout.trim()) {
        for (const args of [['add', '-A'], ['commit', '-q', '-m', 'zephyr: intent ' + sub.kind + ' ' + sub.path + ' (' + sub.description + ')']]) {
          const r = await this.exec('git', args, { cwd: wt });
          if (r.code !== 0) return { status: 'rejected' as const, error: 'git ' + args[0] + ' failed: ' + r.stderr.trim() };
        }
      }
      return { status: 'applied' as const };
    });
  }

  /* -------------------------------- helpers ------------------------------- */

  private must(boardId: string): Board {
    const b = this.boards.get(boardId);
    if (!b) throw new BoardError('NOT_FOUND', 'Board ' + boardId + ' not found or not active');
    return b;
  }

  private ordered(b: Board): Task[] {
    return b.order.map((id) => ({ ...b.tasks.get(id)! }));
  }

  private waves(tasks: Task[]): string[][] {
    const live = tasks.filter((t) => t.status !== 'done' && t.status !== 'failed');
    const settled = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    try {
      return planWaves(
        live.map((t) => ({ id: t.id, writeScope: t.writeScope, dependsOn: t.dependsOn.filter((d) => !settled.has(d)) })),
        settled,
      );
    } catch {
      return [];
    }
  }

  private fixDepth(b: Board, taskId: string): number {
    let depth = 0;
    for (let p = b.fixParents.get(taskId); p; p = b.fixParents.get(p)) depth++;
    return depth;
  }

  private history(a: Assignee): { done: number; failed: number } {
    const key = candidateKey(a);
    let done = 0;
    let failed = 0;
    for (const b of this.boards.values())
      for (const t of b.tasks.values()) {
        if (!t.assignee || candidateKey(t.assignee) !== key) continue;
        if (t.status === 'done') done++;
        if (t.status === 'failed') failed++;
      }
    return { done, failed };
  }

  private load(a: Assignee): number {
    const key = candidateKey(a);
    let n = 0;
    for (const b of this.boards.values())
      for (const t of b.tasks.values()) if (t.status === 'running' && t.assignee && candidateKey(t.assignee) === key) n++;
    return n;
  }

  private set(b: Board, task: Task): Task {
    b.tasks.set(task.id, task);
    const item = b.items.get(task.id);
    if (item) item.task = task;
    return task;
  }

  private async move(b: Board, taskId: string, to: TaskStatus, opts: { reason?: string; assignee?: Assignee } = {}) {
    const cur = b.tasks.get(taskId)!;
    const { task, event } = transition(cur, to, { ...opts, at: nowIso() });
    this.set(b, task);
    await this.emit(b, event);
    await this.persist(b);
    if (to === 'blocked' || cur.status === 'blocked') this.changed();
    return task;
  }

  private track(b: Board, p: Promise<unknown>): void {
    const work = p
      .catch((err) => this.log(b, 'error', 'merge approval: ' + (err as Error).message))
      .finally(() => {
        b.active.delete(work);
        this.pump(b);
      });
    b.active.add(work);
  }

  private async endStep(runId: string, stepId: string, status: 'succeeded' | 'failed' | 'blocked', error?: string) {
    const step = await this.deps.store.patchStep(stepId, {
      status,
      ...(status !== 'blocked' ? { endedAt: nowIso() } : {}),
      ...(error && status !== 'succeeded' ? { error: { code: status.toUpperCase(), message: error } } : {}),
    });
    await this.deps.emit(runId, { type: 'step.upserted', step });
  }

  private async finishTaskRun(runId: string, status: RunStatus, summary: string): Promise<void> {
    const run = await this.deps.store.patchRun(runId, { status, summary, updatedAt: nowIso() });
    await this.deps.emit(runId, { type: 'run.updated', run });
    if (isTerminal(status)) await this.deps.closeWorkspace?.(runId, status, { keepBranch: true });
  }

  private async persist(b: Board): Promise<void> {
    b.run = await this.deps.store.patchRun(b.run.id, {
      result: { tasks: this.ordered(b) } as unknown as Json,
      updatedAt: nowIso(),
    });
  }

  private async patchBoard(b: Board, patch: Partial<Run>): Promise<void> {
    b.run = await this.deps.store.patchRun(b.run.id, {
      ...patch,
      result: { tasks: this.ordered(b) } as unknown as Json,
      updatedAt: nowIso(),
    });
    await this.emit(b, { type: 'run.updated', run: b.run });
    if (patch.status && isTerminal(patch.status)) {
      this.changed();
      if (b.integration) await this.deps.closeWorkspace?.(b.run.id, patch.status, { keepBranch: true });
    }
  }

  private async emit(b: Board, event: RunEvent, runId = b.run.id): Promise<void> {
    await this.deps.emit(runId, event);
  }

  private async log(b: Board, level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    await this.deps.emit(b.run.id, { type: 'log', runId: b.run.id, level, message, at: nowIso() }).catch(() => undefined);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a listener must not break the board */
      }
    }
  }
}
