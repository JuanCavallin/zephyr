/**
 * A graph `coding_task` node: Claude Code changes the configured git repository.
 *
 *   1. open a worktree `<runId>_<nodeId>` (branch `zephyr/<that>`) from `base`;
 *   2. run Claude Code in it (claudeCodeRunner: every native tool call is authorized);
 *   3. commit what it changed on that branch, locally;
 *   4. publish 'branch' | 'pr': push the branch (and open a PR) through `publishRun`,
 *      which waits for a person to approve the exact push, bound to the diff;
 *   5. close the worktree. The branch is kept whenever it holds a commit.
 *
 * Never touches main: the push names the task branch, and nothing merges.
 */

import { createHash } from 'node:crypto';
import type { CodingTaskResult, CodingTaskSpec } from '../core/playbooks/types.js';
import type { Exec, PublishResult } from '../core/verify/publish.js';
import { changedFiles, runClaudeCodeInWorktree, type AttachableClaudeCode } from './claudeCodeRunner.js';
import type { PublishOptions } from './publish.service.js';
import type { WorkspacesService } from './workspaces.service.js';

export type CodingTaskInput = CodingTaskSpec & { runId: string; signal: AbortSignal };

export interface CodingTaskDeps {
  claudeCode: () => AttachableClaudeCode;
  workspaces: () => Promise<Pick<WorkspacesService, 'open' | 'finish'>>;
  exec: Exec;
  publish: (runId: string, options: PublishOptions) => Promise<PublishResult>;
  pollMs?: number;
}

const RUN_ID_MAX = 64;

/** The node's own workspace id: `<runId>_<nodeId>`, hashed when it would not fit. */
export function codingWorkspaceRunId(runId: string, nodeId: string): string {
  const id = runId + '_' + nodeId.replace(/[^A-Za-z0-9_-]/g, '-');
  if (id.length <= RUN_ID_MAX) return id;
  return runId + '_' + createHash('sha256').update(nodeId).digest('hex').slice(0, 12);
}

export function codingTaskPrompt(spec: Pick<CodingTaskSpec, 'goal'>): string {
  return [
    spec.goal,
    '',
    'You are working in a checkout of the repository on its own branch.',
    'Add or update tests for what you change, and run them.',
    'Do not commit, push or switch branches: Zephyr commits your work, and pushing needs a person\'s approval.',
  ].join('\n');
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

export function createCodingTaskRunner(deps: CodingTaskDeps): (input: CodingTaskInput) => Promise<CodingTaskResult> {
  return async (input) => {
    const wsRunId = codingWorkspaceRunId(input.runId, input.nodeId);
    const workspaces = await deps.workspaces();
    const ws = await workspaces.open(wsRunId, input.base ?? 'HEAD');
    const git = async (args: string[]) => {
      const r = await deps.exec('git', args, { cwd: ws.path });
      if (r.code !== 0) throw new Error('git ' + args[0] + ' failed: ' + (r.stderr || r.stdout).trim().slice(0, 300));
    };
    let committed = false;
    try {
      const run = await runClaudeCodeInWorktree(deps.claudeCode(), {
        runId: input.runId,
        stepId: input.stepId,
        workspace: { runId: wsRunId, path: ws.path, branch: ws.branch },
        goal: codingTaskPrompt(input),
        signal: input.signal,
        ...(input.maxDurationMs ? { timeoutMs: input.maxDurationMs } : {}),
        ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
        policyRule: 'graph:coding_task',
      });
      if (run.status === 'failed') throw new Error('Claude Code did not finish: ' + (run.detail ?? 'failed'));
      const files = await changedFiles(ws.path, deps.exec);
      if (!files.length) {
        throw new Error('Claude Code finished without changing any file' + (run.text ? ': ' + clip(run.text, 300) : ''));
      }

      // Commit first, so the work survives a rejected or failed push. The publish diff
      // is taken against the worktree's base commit, so it is the same either way.
      await git(['add', '-A', '--', '.']);
      await git(['commit', '-q', '-m', input.title]);
      committed = true;

      let published: CodingTaskResult['published'] = { status: 'committed' };
      if (input.publish !== 'none') {
        const p = await deps.publish(input.runId, {
          stepId: input.stepId,
          workspaceRunId: wsRunId,
          title: input.title,
          openPr: input.publish === 'pr',
          base: 'main',
          signal: input.signal,
        });
        if (p.status !== 'published') {
          throw new Error(`Not published (${p.stage}): ${p.reason}. The work is committed on ${ws.branch}.`);
        }
        published = p.prUrl ? { status: 'pr_opened', prUrl: p.prUrl } : { status: 'pushed' };
      }
      return { branch: ws.branch, files, summary: run.text, toolCalls: run.toolCalls, published };
    } finally {
      await workspaces
        .finish(wsRunId, committed ? 'succeeded' : 'failed', { keepBranch: committed })
        .catch(() => undefined);
    }
  };
}

/** Production wiring over the runtime singletons. */
export function liveCodingTaskRunner(): (input: CodingTaskInput) => Promise<CodingTaskResult> {
  return async (input) => {
    const [{ sharedClaudeCode }, { workspaces }, { execArgv, publishRunLive }] = await Promise.all([
      import('./claudeCodeRunner.js'),
      import('./workspaces.service.js'),
      import('./publish.service.js'),
    ]);
    return createCodingTaskRunner({
      claudeCode: sharedClaudeCode,
      workspaces,
      exec: execArgv,
      publish: publishRunLive,
    })(input);
  };
}
