/**
 * The Zephyr-side `git.publish` executor (step 6): push the run branch and open a PR
 * whose body is the rendered evidence bundle.
 *
 *   1. full suite   when `policy.fullSuiteBeforePublish`: run every test and emit a
 *                   `verify.tests` event (phase `full`). Any failure, or a runner that
 *                   exits non-zero without a parseable failure, blocks publish.
 *   2. evidence     assemble the bundle and write evidence.json + evidence.md. The md
 *                   file is the PR body (`gh pr create --body-file`).
 *   3. approval     one request through the permission bridge for the exact commands
 *                   below. The bridge classifies it as `git.publish` and binds the
 *                   approval to (branch, diff hash), so it is the same gate a harness
 *                   `gh pr create` meets.
 *   4. rebind       after approval, the worktree diff hash must still equal the hash
 *                   the bundle was built from: the PR body describes the diff that was
 *                   approved, or nothing is published.
 *   5. execute      when the worktree has uncommitted work, `git add -A` and `git commit`
 *                   first (the same `add -A` the diff hash is snapshotted with, so the
 *                   pushed tree is the approved one); then `git push -u <remote>
 *                   <branch>` and `gh pr create`. argv only, no shell; the approved text
 *                   is these calls joined with `&&`.
 */

import type { CodingEvent, EvidenceBundle, NativeToolRequest, VerifyPolicy } from '@htn/shared';
import { nowIso } from '../../lib/ids.js';
import type { PermissionBridge, PublishBinding } from '../tools/permissionBridge.js';

export type TestTally = EvidenceBundle['tests']['after'];

export interface PublishInput {
  runId: string;
  worktree: string;
  branch: string;
  base: string;
  title: string;
  remote?: string;
  draft?: boolean;
  policy?: Pick<VerifyPolicy, 'fullSuiteBeforePublish'>;
  signal?: AbortSignal;
}

export interface FullSuiteResult {
  tally: TestTally;
  failedTests?: string[];
  /** Runner exit code; non-zero with no counted failure still blocks. */
  exitCode?: number | null;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: string[], opts: { cwd: string; signal?: AbortSignal }) => Promise<ExecResult>;

export interface PublishDeps {
  bridge: Pick<PermissionBridge, 'decide' | 'report'>;
  /** Session the bridge request is attributed to. */
  sessionId: string;
  /** Assemble + write the bundle. `bodyPath` is the rendered markdown file. */
  evidence: () => Promise<{ bundleId: string; diffHash: string; bodyPath: string }>;
  /** Current (branch, diff hash) of the worktree, read again after approval. */
  binding: () => Promise<PublishBinding>;
  exec: Exec;
  /** True when the worktree has changes the branch does not hold yet. */
  dirty?: () => Promise<boolean>;
  emit: (event: CodingEvent) => Promise<void>;
  /** Required when the policy asks for the full suite; absent then blocks. */
  runFullSuite?: (signal?: AbortSignal) => Promise<FullSuiteResult>;
}

export type PublishStage = 'full-suite' | 'evidence' | 'approval' | 'diff-changed' | 'commit' | 'push' | 'pr';

export type PublishResult =
  | {
      status: 'published';
      branch: string;
      diffHash: string;
      bundleId: string;
      bodyPath: string;
      approvalId?: string;
      prUrl?: string;
      fullSuite?: TestTally;
    }
  | { status: 'blocked'; stage: PublishStage; reason: string; fullSuite?: TestTally };

/** The argv calls publish runs, in order. Exported for the approval text and tests. */
export function publishCommands(input: PublishInput, bodyPath: string, commit = false): [string, string[]][] {
  const remote = input.remote ?? 'origin';
  return [
    ...(commit
      ? ([
          ['git', ['add', '-A', '--', '.']],
          ['git', ['commit', '-m', input.title]],
        ] as [string, string[]][])
      : []),
    ['git', ['push', '-u', remote, input.branch]],
    [
      'gh',
      [
        'pr',
        'create',
        '--head',
        input.branch,
        '--base',
        input.base,
        '--title',
        input.title,
        '--body-file',
        bodyPath,
        ...(input.draft ? ['--draft'] : []),
      ],
    ],
  ];
}

/** POSIX-quoted display of one argv call; what the reviewer approves. */
export function displayCommand(file: string, args: string[]): string {
  return [file, ...args].map((a) => (/^[A-Za-z0-9_./:@=+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export async function publishRun(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  let fullSuite: TestTally | undefined;
  const blocked = (stage: PublishStage, reason: string): PublishResult => ({
    status: 'blocked',
    stage,
    reason,
    ...(fullSuite ? { fullSuite } : {}),
  });

  // 1. Full suite, when the policy asks for it.
  if (input.policy?.fullSuiteBeforePublish) {
    if (!deps.runFullSuite) return blocked('full-suite', 'policy requires the full suite but no runner is bound');
    let result: FullSuiteResult;
    try {
      result = await deps.runFullSuite(input.signal);
    } catch (error) {
      return blocked('full-suite', 'full suite failed to run: ' + (error as Error).message);
    }
    fullSuite = result.tally;
    await deps.emit({
      type: 'verify.tests',
      runId: input.runId,
      phase: 'full',
      selected: [],
      source: 'full',
      tally: result.tally,
      ...(result.failedTests?.length ? { failedTests: result.failedTests } : {}),
      at: nowIso(),
    });
    if (result.tally.failed > 0) {
      const names = result.failedTests?.length ? ': ' + result.failedTests.slice(0, 5).join(', ') : '';
      return blocked('full-suite', `${result.tally.failed} test${result.tally.failed === 1 ? '' : 's'} failing${names}`);
    }
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return blocked('full-suite', `test runner exited ${result.exitCode ?? 'abnormally'} with no counted failure`);
    }
  }

  // 2. Evidence: the PR body.
  let evidence: Awaited<ReturnType<PublishDeps['evidence']>>;
  try {
    evidence = await deps.evidence();
  } catch (error) {
    return blocked('evidence', (error as Error).message);
  }

  // 3. One approval, through the same bridge a harness publish meets.
  let commit: boolean;
  try {
    commit = (await deps.dirty?.()) ?? false;
  } catch (error) {
    return blocked('commit', 'cannot read the worktree status: ' + (error as Error).message);
  }
  const commands = publishCommands(input, evidence.bodyPath, commit);
  const req: NativeToolRequest = {
    harness: 'claudecode',
    toolName: 'Bash',
    rawInput: { command: commands.map(([f, a]) => displayCommand(f, a)).join(' && ') },
    sessionId: deps.sessionId,
  };
  const decision = await deps.bridge.decide(req, input.signal);
  if (decision.exact?.toolId !== 'git.publish') {
    return blocked('approval', 'publish command did not classify as git.publish');
  }
  if (decision.verdict !== 'allow') return blocked('approval', decision.reason);

  // 4. The approved diff is the one the body describes, and the one on disk now.
  const approvedHash = (decision.action?.arguments as { diffHash?: string } | undefined)?.diffHash;
  const now = await deps.binding().catch((error: Error) => error);
  if (now instanceof Error) return blocked('diff-changed', 'cannot re-read the worktree: ' + now.message);
  if (now.diffHash !== evidence.diffHash || (approvedHash !== undefined && approvedHash !== evidence.diffHash)) {
    return blocked('diff-changed', 'the worktree diff changed after the evidence was built; re-run publish');
  }

  // 5. Execute.
  let prUrl: string | undefined;
  for (const [file, args] of commands) {
    const stage: PublishStage = file === 'gh' ? 'pr' : args[0] === 'push' ? 'push' : 'commit';
    let out: ExecResult;
    try {
      out = await deps.exec(file, args, { cwd: input.worktree, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
      out = { code: null, stdout: '', stderr: (error as Error).message };
    }
    if (out.code !== 0) {
      const detail = (out.stderr || out.stdout).trim().slice(0, 500);
      await deps.bridge.report(req, 'failed', { error: `${file} exited ${out.code}: ${detail}` });
      return blocked(stage, `${file} exited ${out.code ?? 'abnormally'}${detail ? ': ' + detail : ''}`);
    }
    if (stage === 'pr') prUrl = /https?:\/\/\S+/.exec(out.stdout.trim().split('\n').pop() ?? '')?.[0];
  }
  await deps.bridge.report(req, 'succeeded', { outputSummary: prUrl ? 'opened ' + prUrl : 'published ' + input.branch });

  return {
    status: 'published',
    branch: input.branch,
    diffHash: evidence.diffHash,
    bundleId: evidence.bundleId,
    bodyPath: evidence.bodyPath,
    ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(fullSuite ? { fullSuite } : {}),
  };
}
