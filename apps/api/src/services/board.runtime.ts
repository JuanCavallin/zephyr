/**
 * The process-wide task board, wired to the runtime singletons. Lazy, because the
 * workspaces service resolves asynchronously and the check scripts never need it.
 */

import { runTests } from '../core/tools/shaped/runTests.js';
import type { OutputStore } from '../core/tools/shaped/outputStore.js';
import type { MergeItem, TestTally } from '../core/coordination/mergeQueue.js';
import { config } from '../config.js';
import { bus, decisionService, providers, shapedTools, store } from './runtime.js';
import { learningService } from './learning.runtime.js';
import { claudeCodeExecutor } from './claudeCodeRunner.js';
import { publishRunLive } from './publish.service.js';
import { BoardService, type BoardServiceDeps } from './tasks.service.js';
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

/** Live Claude Code runs board tasks; otherwise the scripted mock harness does. */
function liveHarness(): Pick<BoardServiceDeps, 'executor' | 'candidates'> {
  if (config.providers.claudecode.mode !== 'live') return {};
  return {
    executor: claudeCodeExecutor(),
    candidates: [
      { kind: 'agent', harness: 'claudecode', tier: 'standard' },
      { kind: 'human', reason: 'reviewer' },
    ],
  };
}

export function boardService(): BoardService {
  instance ??= new BoardService({
    ...liveHarness(),
    // Pushes `zephyr/<boardRunId>` (never main) behind the run's approval gate.
    publish: ({ boardRunId, stepId, title, openPr, signal }) =>
      publishRunLive(boardRunId, { stepId, title, openPr, base: 'main', signal }),
    store,
    workspaceMode: config.providers.git.mode === 'live' ? 'live' : 'mock',
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
