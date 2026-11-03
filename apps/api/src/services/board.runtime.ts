/**
 * The process-wide task board, wired to the runtime singletons. Lazy, because the
 * workspaces service resolves asynchronously and the check scripts never need it.
 */

import { runTests } from '../core/tools/shaped/runTests.js';
import type { OutputStore } from '../core/tools/shaped/outputStore.js';
import type { MergeItem, TestTally } from '../core/coordination/mergeQueue.js';
import { bus, decisionService, providers, shapedTools, store } from './runtime.js';
import { learningService } from './learning.runtime.js';
import { BoardService } from './tasks.service.js';
import { workspaces } from './workspaces.service.js';

/**
 * The merge queue's test gate, on the shaped runner. A repo with no test command
 * counts as green with nothing run; a runner that cannot start counts as one failure.
 */
export function shapedTestTally(outputs: OutputStore) {
  return async (item: MergeItem, signal?: AbortSignal): Promise<TestTally> => {
    const r = await runTests(
      { runId: item.task.runId ?? item.task.id, worktree: item.worktree, ...(signal ? { signal } : {}) },
      { store: outputs },
    );
    if (!r.ok) {
      if (r.code === 'NO_COMMAND') return { passed: 0, failed: 0, failedTests: [] };
      return { passed: 0, failed: 1, failedTests: ['runner: ' + r.message] };
    }
    const d = r.digest as { passed?: number; failed?: number; failures?: { id: string }[] };
    return { passed: d.passed ?? 0, failed: d.failed ?? 0, failedTests: (d.failures ?? []).map((f) => f.id) };
  };
}

let instance: BoardService | undefined;

export function boardService(): BoardService {
  instance ??= new BoardService({
    store,
    emit: (runId, event) => bus.emit(runId, event),
    complete: (req, ctx) => providers.provider('text.model').complete(req, ctx),
    decisions: decisionService,
    openWorkspace: async (runId, base) => (await workspaces()).open(runId, base),
    closeWorkspace: async (runId, status, opts) => (await workspaces()).finish(runId, status, opts),
    runTests: shapedTestTally(shapedTools.store),
    // The learning loop: merge-queue edits and request wording in, task outcomes to its pass.
    signals: learningService().signals,
    onTaskFinished: (t) => learningService().onTaskFinished(t),
  });
  return instance;
}
