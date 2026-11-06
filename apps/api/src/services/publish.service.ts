/**
 * Live wiring for the `git.publish` executor (core/verify/publish.ts): the runtime
 * store and bus, the run's approval gate, its worktree, the evidence service and the
 * shaped test runner for the full suite. `gh` and `git` run as argv, no shell.
 *
 * Call it before the workspace is disposed; the diff and the push come from the live
 * worktree on branch `zephyr/<runId>`.
 */

import { execFile } from 'node:child_process';
import { DEFAULT_VERIFY_POLICY, type HarnessId, type VerifyPolicy } from '@htn/shared';
import { newId } from '../lib/ids.js';
import { createPermissionBridge } from '../core/tools/permissionBridge.js';
import { OutputStore } from '../core/tools/shaped/outputStore.js';
import { runTests } from '../core/tools/shaped/runTests.js';
import { publishRun, type Exec, type PublishResult } from '../core/verify/publish.js';

export interface PublishOptions {
  title: string;
  base?: string;
  draft?: boolean;
  /** Open a PR after the push (needs `gh`). Default true; false pushes the branch only. */
  openPr?: boolean;
  remote?: string;
  /**
   * The workspace to publish, when it is not the run's own (a graph node's worktree,
   * `<runId>_<nodeId>`). Worktree, branch and diff come from it; the approval, the
   * events and the evidence stay on `runId`.
   */
  workspaceRunId?: string;
  /** Step the approval blocks. Required: approvals bind to a run step. */
  stepId: string;
  sessionStateId?: string;
  harness?: HarnessId;
  policy?: Pick<VerifyPolicy, 'fullSuiteBeforePublish'>;
  signal?: AbortSignal;
}

export const execArgv: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === null ? error.message : '')) });
      },
    );
  });

export async function publishRunLive(runId: string, options: PublishOptions): Promise<PublishResult> {
  const [{ bus, providers, toolApprovalGate }, { workspaces }, { evidenceService }] = await Promise.all([
    import('./runtime.js'),
    import('./workspaces.service.js'),
    import('./evidence.service.js'),
  ]);
  const wsRunId = options.workspaceRunId ?? runId;
  const worktree = providers.provider('workspace').pathOf(wsRunId);
  if (!worktree) throw new Error(`publish: run ${wsRunId} has no workspace`);
  const branch = 'zephyr/' + wsRunId;
  const ws = await workspaces();
  const binding = async () => ({ branch, diffHash: (await ws.diff(wsRunId)).hash });
  const bridge = createPermissionBridge({
    harness: options.harness ?? 'claudecode',
    worktree,
    run: { runId, stepId: options.stepId, ...(options.sessionStateId ? { sessionStateId: options.sessionStateId } : {}) },
    approvals: toolApprovalGate,
    publishBinding: binding,
    onLifecycle: (lifecycle) => bus.emit(runId, { type: 'tool.lifecycle', lifecycle }).then(() => {}),
  });
  const outputs = new OutputStore();

  return publishRun(
    {
      runId,
      worktree,
      branch,
      base: options.base ?? 'main',
      title: options.title,
      ...(options.remote ? { remote: options.remote } : {}),
      ...(options.draft ? { draft: true } : {}),
      ...(options.openPr === false ? { openPr: false } : {}),
      policy: options.policy ?? DEFAULT_VERIFY_POLICY,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      bridge,
      sessionId: options.sessionStateId ?? newId('ses'),
      binding,
      exec: execArgv,
      dirty: async () => {
        const status = await execArgv('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree });
        if (status.code !== 0) throw new Error(status.stderr.trim() || 'git status failed');
        return status.stdout.trim().length > 0;
      },
      emit: (event) => bus.emit(runId, event).then(() => {}),
      evidence: async () => {
        const { bundle, markdownPath } = await (await evidenceService()).produce(
          runId,
          wsRunId === runId ? {} : { diff: await ws.diff(wsRunId) },
        );
        if (!markdownPath) throw new Error('evidence.md was not written');
        return { bundleId: bundle.id, diffHash: bundle.diff.hash, bodyPath: markdownPath };
      },
      runFullSuite: async (signal) => {
        const r = await runTests({ runId, worktree, ...(signal ? { signal } : {}) }, { store: outputs });
        if (!r.ok) throw new Error(r.message);
        const d = r.digest as { passed: number; failed: number; total: number; failures: { id: string }[] };
        return {
          tally: { passed: d.passed, failed: d.failed, skipped: Math.max(0, d.total - d.passed - d.failed) },
          failedTests: d.failures.map((f) => f.id),
          exitCode: r.facts.exitCode,
        };
      },
    },
  );
}
