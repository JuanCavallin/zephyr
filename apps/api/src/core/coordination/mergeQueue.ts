/**
 * The merge queue (step 7, spec §10).
 *
 * Finished tasks land on the integration branch ONE AT A TIME, in enqueue order. Per task:
 *
 *   1. commit any uncommitted work in the task's worktree;
 *   2. `git rebase <integration>` in the task's worktree. A conflict aborts the rebase
 *      and spawns a fix task, pinned to the same assignee, with the conflicted files as
 *      context;
 *   3. rerun the task's selected tests on the rebased tree. Red spawns a fix task too;
 *   4. attach evidence;
 *   5. merging is `git.publish`: it needs an approval unless `policy.autoMergeGreen`.
 *      A pending approval parks the task (`awaiting_approval`); `resolveApproval` later
 *      re-runs it from step 2 (other tasks may have landed meanwhile) and merges;
 *   6. `git merge --ff-only <task branch>` in the integration worktree.
 *
 * A rejected or revised approval and a revert each record a preference signal (step 8).
 * So does a user's edit: what the user changed in the task's worktree while its approval
 * was pending is diffed against the agent's head and recorded as `user_edit`.
 * Every outcome is emitted as `merge.result`.
 *
 * Git runs as argv through an injected `Exec`, never a shell string.
 */

import type { PreferenceSignal, SignalSeam, Task } from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import { editDiffFromGit } from '../learning/signalLog.js';
import { KeyedLock } from '../locks.js';
import type { Exec } from '../verify/publish.js';

export type MergeOutcome = 'merged' | 'conflict' | 'tests_failed' | 'awaiting_approval' | 'rejected';

export interface MergeResult {
  taskId: string;
  outcome: MergeOutcome;
  commit?: string;
  fixTaskId?: string;
  detail?: string;
  at: string;
}

export interface MergeItem {
  task: Task;
  /** The task's own worktree, with `branch` checked out. */
  worktree: string;
  branch: string;
  /**
   * The commit holding the agent's own output, when the caller knows it. Anything on the
   * branch past it at merge time is the user's edit, recorded as a `user_edit` signal.
   * The queue fills this in itself when it parks a task for approval.
   */
  agentCommit?: string;
}

export interface TestTally {
  passed: number;
  failed: number;
  failedTests: string[];
}

export interface FixTaskRequest {
  parent: Task;
  title: string;
  acceptance: string;
  writeScope: string[];
  /** The parent's assignee, pinned: the fix goes back to the same agent. */
  assignee?: Task['assignee'];
  pinned: boolean;
  context: { kind: 'conflict'; files: string[]; detail: string } | { kind: 'tests_failed'; failedTests: string[]; detail: string } | { kind: 'revised'; comment: string; detail: string };
}

export type ApprovalVerdict =
  | { status: 'approved'; approvalId: string }
  | { status: 'pending'; approvalId: string }
  | { status: 'rejected' | 'revised'; approvalId: string; comment?: string };

export interface MergeQueueDeps {
  exec: Exec;
  /** The checkout the queue merges into; `branch` is checked out there. */
  integration: { worktree: string; branch: string };
  runTests(item: MergeItem, signal?: AbortSignal): Promise<TestTally>;
  /** Attach the evidence bundle for a green task. */
  evidence?(item: MergeItem, tests: TestTally): Promise<void> | void;
  /** `git.publish` approval. Not called when `policy.autoMergeGreen`. */
  approve?(item: MergeItem, tests: TestTally): Promise<ApprovalVerdict>;
  createFixTask(req: FixTaskRequest): Promise<{ id: string }> | { id: string };
  signals?: SignalSeam;
  emit?(result: MergeResult): void;
  policy?: { autoMergeGreen?: boolean };
  /** Signals from a private-route run are flagged so only a local model learns from them. */
  privateRun?: boolean;
  /** Capturing a user edit failed. The merge goes on regardless. */
  onCaptureError?(error: unknown): void;
  now?: () => string;
}

export class MergeQueueError extends Error {
  readonly code = 'MERGE_QUEUE';
  constructor(message: string) {
    super(message);
    this.name = 'MergeQueueError';
  }
}

const QUEUE_KEY = 'merge';

export class MergeQueue {
  private readonly lock = new KeyedLock();
  private readonly parked = new Map<string, { item: MergeItem; approvalId: string }>();
  /** Tasks inside `approve()`: settles once the task is parked, or turns out not to be. */
  private readonly parking = new Map<string, Promise<void>>();
  private readonly results: MergeResult[] = [];
  private readonly now: () => string;

  constructor(private readonly deps: MergeQueueDeps) {
    this.now = deps.now ?? nowIso;
  }

  history(taskId?: string): MergeResult[] {
    return this.results.filter((r) => !taskId || r.taskId === taskId);
  }

  awaiting(): Array<{ taskId: string; approvalId: string }> {
    return [...this.parked.entries()].map(([taskId, p]) => ({ taskId, approvalId: p.approvalId }));
  }

  /** Queue a finished task. Resolves with its outcome; the queue position is taken now. */
  enqueue(item: MergeItem, signal?: AbortSignal): Promise<MergeResult> {
    return this.serial((s) => this.process(item, false, s), signal);
  }

  /**
   * Finish a parked task. `approved` re-runs rebase + tests and merges without asking
   * again; `rejected` and `revised` record a signal, and `revised` spawns a fix task.
   */
  async resolveApproval(
    taskId: string,
    decision: { outcome: 'approved' | 'rejected' | 'revised'; comment?: string },
    signal?: AbortSignal,
  ): Promise<MergeResult> {
    // A person can decide the moment approve() makes the approval visible, before the
    // task is parked: wait for that rather than reject a real decision.
    await this.parking.get(taskId);
    const parked = this.parked.get(taskId);
    if (!parked) throw new MergeQueueError(taskId + ' is not awaiting a merge approval');
    this.parked.delete(taskId);
    if (decision.outcome === 'approved') return this.serial((s) => this.process(parked.item, true, s), signal);
    return this.serial(
      () =>
        this.decline(parked.item, {
          status: decision.outcome as 'rejected' | 'revised',
          approvalId: parked.approvalId,
          ...(decision.comment ? { comment: decision.comment } : {}),
        }),
      signal,
    );
  }

  /**
   * Run `fn` holding the queue: nothing merges meanwhile. For other writers of the
   * integration branch (the hot-file integrator committing an intent), so a task
   * rebased onto the old tip never meets a moved branch at `merge --ff-only`.
   */
  exclusive<T>(fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.serial(fn, signal);
  }

  /** Revert a merged commit on the integration branch and record a `revert` signal. */
  revert(taskId: string, commit: string, signal?: AbortSignal): Promise<string> {
    return this.serial(async (s) => {
      const { worktree } = this.deps.integration;
      await this.git(worktree, ['revert', '--no-edit', commit], s);
      const head = (await this.git(worktree, ['rev-parse', 'HEAD'], s)).trim();
      await this.record({ kind: 'revert', commit, taskId });
      return head;
    }, signal);
  }

  private async serial<T>(fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.lock.acquire(QUEUE_KEY, signal);
    try {
      return await fn(signal);
    } finally {
      release();
    }
  }

  private async process(item: MergeItem, approved: boolean, signal?: AbortSignal): Promise<MergeResult> {
    const { task, worktree } = item;
    const target = this.deps.integration.branch;

    // 1. Commit what the agent left uncommitted, or, past the agent's own commit, what
    //    the user edited during review.
    const dirty = (await this.git(worktree, ['status', '--porcelain', '--untracked-files=all'], signal)).trim();
    if (dirty) {
      await this.git(worktree, ['add', '-A'], signal);
      const message = item.agentCommit ? 'review edits: ' + task.title : 'zephyr: ' + task.title;
      await this.git(worktree, ['commit', '-q', '-m', message], signal);
    }
    // The user's edit, before the rebase mixes in other tasks' work. Never fails the merge.
    if (item.agentCommit) await this.captureEdit(item, signal);

    // 2. Rebase onto the integration branch.
    const rebase = await this.deps.exec('git', ['rebase', target], { cwd: worktree, ...(signal ? { signal } : {}) });
    if (rebase.code !== 0) {
      const conflicted = await this.deps.exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: worktree });
      const files = conflicted.stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
      await this.deps.exec('git', ['rebase', '--abort'], { cwd: worktree });
      const detail = files.length
        ? 'rebase onto ' + target + ' conflicts in ' + files.join(', ')
        : 'rebase onto ' + target + ' failed: ' + (rebase.stderr.trim() || rebase.stdout.trim() || 'unknown error');
      const fix = await this.fix(task, { kind: 'conflict', files, detail });
      return this.finish({ taskId: task.id, outcome: 'conflict', fixTaskId: fix.id, detail });
    }

    // 3. Rerun the selected tests on the rebased tree.
    const tests = await this.deps.runTests(item, signal);
    if (tests.failed > 0) {
      const detail = tests.failed + ' failing: ' + (tests.failedTests.join(', ') || 'unnamed');
      const fix = await this.fix(task, { kind: 'tests_failed', failedTests: tests.failedTests, detail });
      return this.finish({ taskId: task.id, outcome: 'tests_failed', fixTaskId: fix.id, detail });
    }

    // 4. Evidence.
    await this.deps.evidence?.(item, tests);

    // 5. Merging is git.publish.
    if (!approved && !this.deps.policy?.autoMergeGreen) {
      if (!this.deps.approve)
        throw new MergeQueueError('merge needs an approval and no approval gate is configured');
      // Remember the agent's head: what the user changes from here on is their edit.
      const head = (await this.git(worktree, ['rev-parse', 'HEAD'], signal)).trim();
      let settle!: () => void;
      this.parking.set(task.id, new Promise<void>((r) => (settle = r)));
      let verdict: ApprovalVerdict;
      try {
        verdict = await this.deps.approve(item, tests);
        if (verdict.status === 'pending')
          this.parked.set(task.id, { item: { ...item, agentCommit: item.agentCommit ?? head }, approvalId: verdict.approvalId });
      } finally {
        this.parking.delete(task.id);
        settle();
      }
      if (verdict.status === 'pending') {
        return this.finish({
          taskId: task.id,
          outcome: 'awaiting_approval',
          detail: 'approval ' + verdict.approvalId + ' pending',
        });
      }
      if (verdict.status !== 'approved') return this.decline(item, verdict);
    }

    // 6. Fast-forward the integration branch.
    const { worktree: integration } = this.deps.integration;
    await this.git(integration, ['merge', '--ff-only', '-q', item.branch], signal);
    const commit = (await this.git(integration, ['rev-parse', 'HEAD'], signal)).trim();
    return this.finish({ taskId: task.id, outcome: 'merged', commit, detail: tests.passed + ' tests passed' });
  }

  private async decline(
    item: MergeItem,
    verdict: { status: 'rejected' | 'revised'; approvalId: string; comment?: string },
  ): Promise<MergeResult> {
    await this.record({
      kind: 'approval',
      approvalId: verdict.approvalId,
      outcome: verdict.status,
      taskId: item.task.id,
      ...(verdict.comment ? { comment: verdict.comment } : {}),
    });
    if (verdict.status === 'revised') {
      const comment = verdict.comment ?? 'changes requested';
      const fix = await this.fix(item.task, { kind: 'revised', comment, detail: 'revision requested: ' + comment });
      return this.finish({ taskId: item.task.id, outcome: 'rejected', fixTaskId: fix.id, detail: 'revision requested: ' + comment });
    }
    return this.finish({
      taskId: item.task.id,
      outcome: 'rejected',
      detail: 'merge rejected' + (verdict.comment ? ': ' + verdict.comment : ''),
    });
  }

  private fix(parent: Task, context: FixTaskRequest['context']): Promise<{ id: string }> {
    const what = context.kind === 'conflict' ? 'merge conflict' : context.kind === 'tests_failed' ? 'failing tests' : 'review';
    return Promise.resolve(
      this.deps.createFixTask({
        parent,
        title: 'Fix ' + what + ': ' + parent.title,
        acceptance: parent.acceptance,
        writeScope: [...parent.writeScope],
        ...(parent.assignee ? { assignee: parent.assignee } : {}),
        pinned: parent.assignee !== undefined,
        context,
      }),
    );
  }

  /** `git diff <agentCommit> HEAD` in the task's worktree, recorded as a `user_edit`. */
  private async captureEdit(item: MergeItem, signal?: AbortSignal): Promise<void> {
    if (!this.deps.signals || !item.agentCommit) return;
    try {
      const r = await this.deps.exec('git', ['diff', '--no-color', '--no-ext-diff', item.agentCommit, 'HEAD'], {
        cwd: item.worktree,
        ...(signal ? { signal } : {}),
      });
      if (r.code !== 0) return;
      const edit = editDiffFromGit(r.stdout);
      if (!edit) return;
      await this.record(
        {
          kind: 'user_edit',
          diffHash: edit.diffHash,
          files: edit.files,
          taskId: item.task.id,
          ...(item.task.runId ? { runId: item.task.runId } : {}),
        },
        { scope: 'personal', detail: edit.diff },
      );
    } catch (error) {
      this.deps.onCaptureError?.(error);
    }
  }

  private async record(
    s:
      | { kind: 'approval'; approvalId: string; outcome: 'rejected' | 'revised'; comment?: string; taskId: string }
      | { kind: 'revert'; commit: string; taskId: string }
      | { kind: 'user_edit'; diffHash: string; files: string[]; taskId: string; runId?: string },
    opts: { scope?: 'personal' | 'project'; detail?: string } = {},
  ): Promise<void> {
    if (!this.deps.signals) return;
    const signal = {
      id: newId('sig'),
      scope: opts.scope ?? 'project',
      private: this.deps.privateRun ?? false,
      at: this.now(),
      ...s,
    } as PreferenceSignal;
    await this.deps.signals.recordSignal(signal, opts.detail ? { detail: opts.detail } : undefined);
  }

  private finish(r: Omit<MergeResult, 'at'>): MergeResult {
    const result: MergeResult = { ...r, at: this.now() };
    this.results.push(result);
    this.deps.emit?.(result);
    return result;
  }

  private async git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    const r = await this.deps.exec('git', args, { cwd, ...(signal ? { signal } : {}) });
    if (r.code !== 0) throw new MergeQueueError('git ' + args.join(' ') + ' failed: ' + (r.stderr.trim() || r.stdout.trim()));
    return r.stdout;
  }
}
