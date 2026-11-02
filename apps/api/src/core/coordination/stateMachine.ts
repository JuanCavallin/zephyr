/**
 * Task lifecycle (spec §10 State machine).
 *
 *   pending -> ready -> running -> review -> done
 *                 \________\________\-> blocked / failed
 *
 * Every transition goes through `transition`, which throws on an illegal move and
 * returns the `task.status` event to emit, so a board can never show a state the
 * machine did not allow, and every event carries the `taskId`.
 *
 * Progress is DERIVED from what Zephyr observed: verification tallies, files the
 * harness actually wrote through the broker, gateway token usage and harness turns.
 * Nothing an agent says can move it: `ProgressTracker.observe` reads only typed
 * measurement events and ignores everything else, text included.
 */

import type { Assignee, RunEvent, Task, TaskProgress, TaskStatus } from '@htn/shared';

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  // pending: on the board, awaiting review / "Run ready tasks" / its deps.
  pending: ['ready', 'blocked', 'failed'],
  // ready: deps done, may be started; back to pending if the plan is edited.
  ready: ['running', 'pending', 'blocked'],
  running: ['review', 'blocked', 'failed'],
  // review: in the merge queue. A conflict or red tests send it back to running as a fix.
  review: ['done', 'running', 'blocked', 'failed'],
  done: [],
  // blocked: needs a person (stuck, over budget, lease queued). Resume re-readies it.
  blocked: ['ready', 'pending', 'failed'],
  // failed: a retry re-readies it.
  failed: ['ready'],
};

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super('Task ' + taskId + ' cannot go from ' + from + ' to ' + to);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export type TaskStatusEvent = Extract<RunEvent, { type: 'task.status' }>;

/**
 * Move `task` to `to`. Pure: returns the next task and the event; the caller persists
 * and emits. `blocked` and `failed` require a reason; leaving them clears it.
 */
export function transition(
  task: Task,
  to: TaskStatus,
  opts: { reason?: string; assignee?: Assignee; at: string },
): { task: Task; event: TaskStatusEvent } {
  if (!canTransition(task.status, to)) throw new IllegalTransitionError(task.id, task.status, to);
  if ((to === 'blocked' || to === 'failed') && !opts.reason)
    throw new Error('Task ' + task.id + ' -> ' + to + ' needs a reason');
  const next: Task = { ...task, status: to, updatedAt: opts.at };
  if (opts.reason) next.reason = opts.reason;
  else delete next.reason;
  if (opts.assignee) next.assignee = opts.assignee;
  const event: TaskStatusEvent = {
    type: 'task.status',
    taskId: task.id,
    from: task.status,
    to,
    at: opts.at,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.assignee ? { assignee: opts.assignee } : {}),
  };
  return { task: next, event };
}

export const EMPTY_PROGRESS: TaskProgress = Object.freeze({
  testsPassed: 0,
  testsTotal: 0,
  filesChanged: 0,
  tokens: 0,
  turns: 0,
});

/**
 * Accumulates a task's progress from observations. One per task run.
 *
 * The inputs are deliberately narrow: typed run events from the gateway, the harness
 * turn boundary and the verifier, plus the set of paths the broker allowed the harness
 * to write. An agent's message, tool output or claimed status never reaches it.
 */
export class ProgressTracker {
  private tests: { passed: number; total: number } = { passed: 0, total: 0 };
  private readonly files = new Set<string>();
  private tokens = 0;
  private turns = 0;
  private lastChangeAt: number;

  constructor(
    readonly taskId: string,
    private readonly runId?: string,
    now = Date.now(),
  ) {
    this.lastChangeAt = now;
  }

  /** Feed any run event; only measurement events for this task's run count. */
  observe(event: RunEvent, now = Date.now()): boolean {
    const before = this.key();
    switch (event.type) {
      case 'verify.tests':
        if (this.runId && event.runId !== this.runId) break;
        this.tests = {
          passed: event.tally.passed,
          total: event.tally.passed + event.tally.failed + event.tally.skipped,
        };
        break;
      case 'gateway.call':
        if (this.runId && event.runId !== this.runId) break;
        this.tokens += event.usage.inputTokens + event.usage.outputTokens;
        break;
      case 'harness.turn.ended':
        if (event.taskId && event.taskId !== this.taskId) break;
        if (this.runId && event.runId !== this.runId) break;
        this.turns += 1;
        break;
      default:
        break;
    }
    return this.touch(before, now);
  }

  /** Paths the broker allowed this task to write (repo-relative). */
  observeFiles(paths: Iterable<string>, now = Date.now()): boolean {
    const before = this.key();
    for (const p of paths) this.files.add(p);
    return this.touch(before, now);
  }

  /** Token usage reported by a harness adapter's own accounting (not the agent's words). */
  observeTokens(n: number, now = Date.now()): boolean {
    const before = this.key();
    if (Number.isFinite(n) && n > 0) this.tokens += Math.floor(n);
    return this.touch(before, now);
  }

  /** A completed harness turn the adapter observed directly (no event bus). */
  observeTurn(now = Date.now()): boolean {
    const before = this.key();
    this.turns += 1;
    return this.touch(before, now);
  }

  snapshot(): TaskProgress {
    return {
      testsPassed: this.tests.passed,
      testsTotal: this.tests.total,
      filesChanged: this.files.size,
      tokens: this.tokens,
      turns: this.turns,
    };
  }

  /** Milliseconds since the progress last changed. */
  idleMs(now = Date.now()): number {
    return now - this.lastChangeAt;
  }

  private key(): string {
    return JSON.stringify(this.snapshot());
  }

  private touch(before: string, now: number): boolean {
    const changed = this.key() !== before;
    if (changed) this.lastChangeAt = now;
    return changed;
  }
}

export interface TaskBudget {
  maxTurns?: number;
  maxTokens?: number;
  /** No observed progress for this long -> stuck. */
  stuckMs?: number;
}

/** Keep the defaults small: a board task is a slice of a request, not a whole project. */
export const DEFAULT_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 40,
  maxTokens: 400_000,
  stuckMs: 10 * 60_000,
};

/** Why a running task must stop and go to `blocked`, or null. */
export function budgetBreach(tracker: ProgressTracker, budget: TaskBudget, now = Date.now()): string | null {
  const p = tracker.snapshot();
  if (budget.maxTurns !== undefined && p.turns > budget.maxTurns)
    return 'over budget: ' + p.turns + ' turns > ' + budget.maxTurns;
  if (budget.maxTokens !== undefined && p.tokens > budget.maxTokens)
    return 'over budget: ' + p.tokens + ' tokens > ' + budget.maxTokens;
  if (budget.stuckMs !== undefined && tracker.idleMs(now) > budget.stuckMs)
    return 'stuck: no progress for ' + Math.round(tracker.idleMs(now) / 1000) + 's';
  return null;
}
