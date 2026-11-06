/**
 * Claude Code coding paths: the board executor, publish without a PR, and the graph
 * `coding_task` node.
 *
 *   pnpm check:claudecode-coding
 *
 * Offline: a real temp git repo, the mock ACP peer standing in for Claude Code,
 * no model and no network. Pushes go to a local bare repo.
 *
 * 1. publish: `openPr: false` pushes without `gh`.
 * 2. Permission bridge: a bridge bound to a board task enforces its write lease.
 * 3. Runtime attach mode: runs in a worktree it did not open; checkpoints use its id.
 * 4. runClaudeCodeInWorktree + claudeCodeExecutor: done, failed, cancelled, lease denial.
 * 5. Graph `coding_task`: schema, interpreter seam, clear error without the seam.
 * 6. createCodingTaskRunner end to end: commit on the node's branch; publish paths.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentGraph, NativeToolRequest, Step, Task } from '@htn/shared';

const { agentGraphSchema } = await import('@htn/shared');
const { publishCommands } = await import('../src/core/verify/publish.js');
const { createPermissionBridge } = await import('../src/core/tools/permissionBridge.js');
const { LeaseTable } = await import('../src/core/coordination/leases.js');
const { ProgressTracker } = await import('../src/core/coordination/stateMachine.js');
const { HookTokenStore } = await import('../src/core/hooks/hookTokens.js');
const { claudeCodeHarness } = await import('../src/providers/claudecode/live.js');
const { mockPeerHarness } = await import('../src/providers/_acp/mockPeer.js');
const { createLiveGitWorkspaces } = await import('../src/providers/git/live.js');
const { createWorkspacesService } = await import('../src/services/workspaces.service.js');
const { execArgv } = await import('../src/services/publish.service.js');
const { createAttachableClaudeCode, runClaudeCodeInWorktree, claudeCodeExecutor, boardTaskPrompt, parseIntents } = await import(
  '../src/services/claudeCodeRunner.js'
);
const { createCodingTaskRunner, codingWorkspaceRunId } = await import('../src/services/codingTask.service.js');
const { runGraph } = await import('../src/core/graph/interpreter.js');

type PlaybookContext = import('../src/core/playbooks/types.js').PlaybookContext;
type CodingTaskSpec = import('../src/core/playbooks/types.js').CodingTaskSpec;
type CodingTaskInput = import('../src/services/codingTask.service.js').CodingTaskInput;
type TaskExecutionContext = import('../src/services/tasks.service.js').TaskExecutionContext;
type PublishOptions = import('../src/services/publish.service.js').PublishOptions;
type PublishResult = import('../src/core/verify/publish.js').PublishResult;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const scratch = await mkdtemp(join(tmpdir(), 'zephyr-coding-check-'));
const repo = join(scratch, 'repo');
const remote = join(scratch, 'remote.git');
git(scratch, 'init', '-q', '--bare', remote);
git(scratch, 'init', '-q', '-b', 'main', repo);
git(repo, 'config', 'user.name', 'Zephyr Check');
git(repo, 'config', 'user.email', 'check@zephyr.invalid');
await writeFile(join(repo, 'README.md'), '# fixture\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', 'origin', 'main');
const mainBefore = git(repo, 'rev-parse', 'main');

const gitWorkspaces = createLiveGitWorkspaces({ repoRoot: repo, workspacesDir: join(scratch, 'ws') });
const base = createWorkspacesService(() => gitWorkspaces as never);
const opened: string[] = [];
const checkpointed: string[] = [];
const workspaces = {
  ...base,
  async open(runId: string, from?: string) {
    opened.push(runId);
    return base.open(runId, from);
  },
  async checkpointTurn(runId: string) {
    checkpointed.push(runId);
    return base.checkpointTurn(runId);
  },
};

const tokens = new HookTokenStore();
const minted: string[] = [];
const mint = tokens.mint.bind(tokens);
tokens.mint = ((...args: Parameters<typeof mint>) => {
  const t = mint(...args);
  minted.push(t);
  return t;
}) as typeof tokens.mint;

const cc = createAttachableClaudeCode({
  harness: mockPeerHarness({ harness: 'claudecode', env: claudeCodeHarness().env }),
  workspaces: async () => workspaces as never,
  apiBaseUrl: 'http://127.0.0.1:1',
  gatewayUrl: 'http://127.0.0.1:1/never',
  tokens,
  requireGatewayCredentials: false,
  stderr: 'ignore',
  log: () => {},
});
const signal = () => new AbortController().signal;

/* ------------------------------------------------------------------ 1. publish */

console.log('1. publish');

await test('openPr false drops gh; the default still opens a PR', () => {
  const input = { runId: 'r', worktree: '.', branch: 'zephyr/r', base: 'main', title: 't' };
  const pushOnly = publishCommands({ ...input, openPr: false }, 'body.md');
  assert.deepEqual(pushOnly, [['git', ['push', '-u', 'origin', 'zephyr/r']]]);
  assert.equal(publishCommands(input, 'body.md').at(-1)![0], 'gh');
});

/* ---------------------------------------------------- 2. bridge bound to a task */

console.log('2. permission bridge');

await test('a bridge bound to a board task denies writes outside its lease', async () => {
  const wt = await base.open('run_bridge');
  const leases = new LeaseTable({ onEvent: () => {} });
  assert.ok(leases.acquire('task_b', ['src/a/**']).ok);
  const bridge = createPermissionBridge({ harness: 'claudecode', worktree: wt.path, leases, taskId: 'task_b' });
  const req = (path: string): NativeToolRequest => ({
    harness: 'claudecode',
    toolName: 'Write',
    rawInput: { file_path: path, content: 'x' },
    sessionId: 's',
  });
  assert.equal((await bridge.decide(req('src/b/y.ts'))).verdict, 'deny');
  assert.match((await bridge.decide(req('src/b/y.ts'))).reason, /lease/);
  assert.equal((await bridge.decide(req('src/a/x.ts'))).verdict, 'allow');
  await base.finish('run_bridge', 'cancelled', { keepBranch: false });
});

/* ------------------------------------------------------- 3 + 4. runner, executor */

console.log('3. attach mode and the runner');

await test('runs in the attached worktree; checkpoints use its id; opens nothing', async () => {
  const ws = await base.open('run_task_v2');
  opened.length = 0;
  checkpointed.length = 0;
  const r = await runClaudeCodeInWorktree(cc, {
    runId: 'run_task',
    stepId: 'step_1',
    workspace: { runId: 'run_task_v2', path: ws.path, branch: ws.branch },
    goal: 'write:src/hello.ts=export const hi = 1;',
    signal: signal(),
    pollMs: 20,
  });
  assert.equal(r.status, 'done', r.detail);
  assert.match(r.text, /wrote src\/hello.ts/);
  assert.equal(await readFile(join(ws.path, 'src', 'hello.ts'), 'utf8'), 'export const hi = 1;');
  assert.deepEqual(opened, [], 'no workspace opened for the run');
  assert.deepEqual(checkpointed, ['run_task_v2']);
  assert.equal(cc.attachments.size, 0, 'detached afterwards');
  assert.equal(tokens.resolve(minted.at(-1)!), null, 'hook token revoked');
  await base.finish('run_task_v2', 'cancelled', { keepBranch: false });
});

await test('a scripted failure comes back as failed with the reason', async () => {
  const ws = await base.open('run_fail');
  const r = await runClaudeCodeInWorktree(cc, {
    runId: 'run_fail',
    stepId: 's',
    workspace: { runId: 'run_fail', path: ws.path, branch: ws.branch },
    goal: 'error',
    signal: signal(),
    pollMs: 20,
  });
  assert.equal(r.status, 'failed');
  assert.match(r.detail ?? '', /scripted failure/);
  await base.finish('run_fail', 'cancelled', { keepBranch: false });
});

await test('cancelling mid-turn tears Claude Code down', async () => {
  const ws = await base.open('run_cancel');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const r = await runClaudeCodeInWorktree(cc, {
    runId: 'run_cancel',
    stepId: 's',
    workspace: { runId: 'run_cancel', path: ws.path, branch: ws.branch },
    goal: 'slow',
    signal: ac.signal,
    pollMs: 20,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.detail, 'cancelled');
  assert.equal(tokens.resolve(minted.at(-1)!), null, 'hook token revoked');
  assert.equal(cc.attachments.size, 0);
  await base.finish('run_cancel', 'cancelled', { keepBranch: false });
});

await test('a write outside the task lease is denied and not written', async () => {
  const ws = await base.open('run_lease');
  const leases = new LeaseTable({ onEvent: () => {} });
  assert.ok(leases.acquire('task_l', ['src/a/**']).ok);
  const r = await runClaudeCodeInWorktree(cc, {
    runId: 'run_lease',
    stepId: 's',
    workspace: { runId: 'run_lease', path: ws.path, branch: ws.branch },
    goal: 'request:Write:nohook\n' + JSON.stringify({ file_path: 'src/b/out.ts', content: 'x' }),
    taskId: 'task_l',
    leases,
    signal: signal(),
    pollMs: 20,
  });
  assert.equal(r.status, 'done');
  assert.match(r.text, /denied:Write/);
  assert.equal(existsSync(join(ws.path, 'src', 'b', 'out.ts')), false);
  await base.finish('run_lease', 'cancelled', { keepBranch: false });
});

await test('an approval still waiting when the task ends expires instead of staying pending', async () => {
  const { createMemoryStore } = await import('../src/store/memory.js');
  const { RunBus } = await import('../src/core/bus.js');
  const { SessionStateService } = await import('../src/core/sessions/service.js');
  const { RunToolApprovalGate } = await import('../src/core/tools/approval.js');
  const store = createMemoryStore({ persistToDisk: false });
  const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
  const gate = new RunToolApprovalGate(store, bus, new SessionStateService(store, bus));
  const now = new Date().toISOString();
  await store.createRun({ id: 'run_gate', kind: 'check', title: 'gate', status: 'running', input: {}, createdAt: now, updatedAt: now });
  await store.appendStep({ id: 'step_gate', runId: 'run_gate', parentStepId: null, kind: 'harness', label: 'cc', status: 'running', startedAt: now });
  const gated = createAttachableClaudeCode({
    harness: mockPeerHarness({ harness: 'claudecode', env: claudeCodeHarness().env }),
    workspaces: async () => workspaces as never,
    apiBaseUrl: 'http://127.0.0.1:1',
    gatewayUrl: 'http://127.0.0.1:1/never',
    tokens,
    approvals: async () => gate,
    requireGatewayCredentials: false,
    stderr: 'ignore',
    log: () => {},
  });
  const ws = await base.open('run_gate');
  const { settleApproval } = await import('../src/core/approvalGate.js');

  // With no agent session (board / graph runs have none), a person's approval is
  // still waited for, and then the tool runs. This used to be a silent deny.
  const off = bus.subscribeAll((s) => {
    if (s.event.type === 'approval.requested')
      setTimeout(() => settleApproval(s.event.type === 'approval.requested' ? s.event.approval.id : '', {
        verdict: 'approved',
        action: { kind: 'tool:shell.exec', description: 'ok' },
      }), 50);
  });
  const approved = await runClaudeCodeInWorktree(gated, {
    runId: 'run_gate',
    stepId: 'step_gate',
    workspace: { runId: 'run_gate', path: ws.path, branch: ws.branch },
    goal: 'request:Bash:nohook\n' + JSON.stringify({ command: 'cat a; ls -la' }),
    signal: signal(),
    pollMs: 20,
  });
  off();
  assert.equal(approved.status, 'done');
  assert.match(approved.text, /allowed:Bash/, approved.text);

  // `a; b` classifies as unknown: it needs a person, and nobody answers.
  const r = await runClaudeCodeInWorktree(gated, {
    runId: 'run_gate',
    stepId: 'step_gate',
    workspace: { runId: 'run_gate', path: ws.path, branch: ws.branch },
    goal: 'request:Bash:nohook\n' + JSON.stringify({ command: 'cat a; ls' }),
    signal: signal(),
    pollMs: 20,
    timeoutMs: 1_500,
  });
  assert.equal(r.status, 'failed', r.text + ' ' + JSON.stringify(await store.listApprovals('run_gate')));
  assert.match(r.detail ?? '', /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const approvals = await store.listApprovals('run_gate');
  assert.equal(approvals.length, 2, 'one approval per run');
  // The first was settled directly (the approvals service would record its verdict);
  // the unanswered one must not be left pending.
  const unanswered = approvals.find((a) => (a.proposedAction as { arguments?: { command?: string } }).arguments?.command === 'cat a; ls');
  assert.equal(unanswered?.status, 'expired');
  await base.finish('run_gate', 'cancelled', { keepBranch: false });
});

console.log('4. board executor');

const makeTask = (title: string): Task => ({
  id: 'task_e',
  boardRunId: 'run_board',
  title,
  acceptance: 'tests pass',
  writeScope: ['src/**'],
  dependsOn: [],
  status: 'running',
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
});

function execCtx(task: Task, ws: { path: string; branch: string }, runId: string, steps: { n: number }): TaskExecutionContext {
  const leases = new LeaseTable({ onEvent: () => {} });
  leases.acquire(task.id, task.writeScope);
  return {
    task,
    taskRunId: runId,
    stepId: 'step_e',
    worktree: ws.path,
    workspaceRunId: runId,
    branch: ws.branch,
    leases,
    tracker: new ProgressTracker(task.id, runId),
    signal: signal(),
    emit: async () => {},
    step: async () => {
      steps.n++;
    },
    submitIntent: async () => ({ status: 'rejected', error: 'none' }),
  };
}

await test('boardTaskPrompt: title first, then acceptance, scope and the no-commit rule', () => {
  const p = boardTaskPrompt({ title: 'Add clamp', acceptance: 'tests pass', writeScope: ['src/math.js'] });
  const lines = p.split('\n');
  assert.equal(lines[0], 'Add clamp');
  assert.match(p, /Done when: tests pass/);
  assert.match(p, /only inside: src\/math\.js/);
  assert.match(p, /Do not commit, push/);
});

await test('executor: Claude Code writes, the tracker sees the file, ctx.step ran', async () => {
  const ws = await base.open('run_exec');
  const steps = { n: 0 };
  const ctx = execCtx(makeTask('write:src/clamp.js=export const clamp = 1;'), ws, 'run_exec', steps);
  const out = await claudeCodeExecutor({ claudeCode: () => cc, pollMs: 20 })(ctx);
  assert.equal(out.status, 'done', out.detail);
  assert.ok(ctx.tracker.snapshot().filesChanged >= 1, 'file observed');
  assert.ok(steps.n >= 1, 'progress published');
  assert.equal(ctx.tracker.snapshot().turns, 1);
  await base.finish('run_exec', 'cancelled', { keepBranch: false });
});

await test('parseIntents: valid lines become intents, malformed ones are errors, prose is ignored', () => {
  const ok = parseIntents(
    'Done.\nZEPHYR_INTENT {"kind":"export_symbol","path":"src/index.js","payload":{"from":"./math.js","symbols":["clamp"]},"description":"export clamp"}\n',
  );
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.intents, [
    { kind: 'export_symbol', path: 'src/index.js', payload: { from: './math.js', symbols: ['clamp'] }, description: 'export clamp' },
  ]);
  assert.equal(parseIntents('ZEPHYR_INTENT {"kind":"export_symbol"').errors.length, 1, 'truncated JSON');
  assert.equal(parseIntents('ZEPHYR_INTENT {"kind":"delete_repo","path":"x","payload":{},"description":"x"}').errors.length, 1);
  // The prompt's own examples never parse as a request, even when echoed back.
  const echoed = parseIntents(boardTaskPrompt({ title: 't', acceptance: 'a', writeScope: ['src/a.js'] }));
  assert.deepEqual(echoed, { intents: [], errors: [] });
});

await test('executor: a ZEPHYR_INTENT line is submitted; a rejected one fails the task', async () => {
  const intent = { kind: 'export_symbol', path: 'src/index.js', payload: { from: './math.js', symbols: ['clamp'] }, description: 'export clamp' };
  const ws = await base.open('run_intent');
  const ctx = execCtx(makeTask('say:ZEPHYR_INTENT ' + JSON.stringify(intent)), ws, 'run_intent', { n: 0 });
  const submitted: unknown[] = [];
  ctx.submitIntent = async (sub) => {
    submitted.push(sub);
    return { status: 'applied' };
  };
  const out = await claudeCodeExecutor({ claudeCode: () => cc, pollMs: 20 })(ctx);
  assert.equal(out.status, 'done', out.detail);
  assert.deepEqual(submitted, [intent]);

  ctx.submitIntent = async () => ({ status: 'rejected', error: 'export_symbol payload: not a relative module specifier' });
  const rejected = await claudeCodeExecutor({ claudeCode: () => cc, pollMs: 20 })(ctx);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.detail ?? '', /intent rejected: export_symbol payload/);

  const bad = execCtx(makeTask('say:ZEPHYR_INTENT {not json}'), ws, 'run_intent', { n: 0 });
  const malformed = await claudeCodeExecutor({ claudeCode: () => cc, pollMs: 20 })(bad);
  assert.equal(malformed.status, 'failed');
  assert.match(malformed.detail ?? '', /malformed ZEPHYR_INTENT/);
  await base.finish('run_intent', 'cancelled', { keepBranch: false });
});

await test('executor: a budget breach thrown by ctx.step propagates after teardown', async () => {
  const ws = await base.open('run_budget');
  const ctx = execCtx(makeTask('slow'), ws, 'run_budget', { n: 0 });
  ctx.step = async () => {
    throw new Error('over budget: test');
  };
  await assert.rejects(claudeCodeExecutor({ claudeCode: () => cc, pollMs: 20 })(ctx), /over budget/);
  assert.equal(cc.attachments.size, 0);
  assert.equal(tokens.resolve(minted.at(-1)!), null, 'hook token revoked');
  await base.finish('run_budget', 'cancelled', { keepBranch: false });
});

/* --------------------------------------------------------- 5. graph coding_task */

console.log('5. graph coding_task');

const at = '2026-11-05T00:00:00Z';
const codingGraph = (config: Record<string, unknown>, extra: Record<string, unknown> = {}): AgentGraph =>
  agentGraphSchema.parse({
    id: 'graph_coding',
    name: 'coding',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes: [{ id: 'change', type: 'coding_task', label: 'Add utilities', position: { x: 0, y: 0 }, config, ...extra }],
    edges: [],
  });

function graphCtx(run?: PlaybookContext['runCodingTask']) {
  const outputs: unknown[] = [];
  let n = 0;
  const ctx = {
    runId: 'run_graph',
    signal: signal(),
    async log() {},
    async step(spec: { label: string }, work: (s: Step) => Promise<unknown>) {
      const out = await work({ ...spec, id: 'step_' + ++n } as unknown as Step);
      outputs.push(out);
      return out;
    },
    providerFor: () => 'claudecode',
    ...(run ? { runCodingTask: run } : {}),
  } as unknown as PlaybookContext;
  return { ctx, outputs };
}

await test('schema: a coding_task needs a goal; publish defaults to none and is an enum', () => {
  const g = codingGraph({ goal: 'add clamp' });
  assert.equal((g.nodes[0] as { config: { publish: string } }).config.publish, 'none');
  assert.throws(() => codingGraph({}), /goal/);
  assert.throws(() => codingGraph({ goal: 'x', publish: 'main' }));
});

await test('interpreter: passes the resolved spec to runCodingTask and returns its result', async () => {
  const seen: CodingTaskSpec[] = [];
  const t = graphCtx(async (spec) => {
    seen.push(spec);
    return { branch: 'zephyr/x', files: ['src/math.js'], summary: 'done', toolCalls: 3, published: { status: 'pushed' } };
  });
  await runGraph(t.ctx, codingGraph({ goal: 'add clamp', publish: 'branch', base: 'main' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.goal, 'add clamp');
  assert.equal(seen[0]!.publish, 'branch');
  assert.equal(seen[0]!.base, 'main');
  assert.equal(seen[0]!.title, 'Add utilities', 'title defaults to the label');
  assert.equal(seen[0]!.nodeId, 'change');
  assert.equal(seen[0]!.stepId, 'step_1');
  assert.equal((t.outputs[0] as { branch: string }).branch, 'zephyr/x');
});

await test('interpreter: without Claude Code the step fails naming the settings', async () => {
  await assert.rejects(runGraph(graphCtx().ctx, codingGraph({ goal: 'x' })), /CLAUDECODE_MODE=live.*GIT_MODE=live/);
});

await test('interpreter: a local_only coding_task never reaches Claude Code', async () => {
  let called = false;
  const t = graphCtx(async () => {
    called = true;
    throw new Error('unreachable');
  });
  await assert.rejects(runGraph(t.ctx, codingGraph({ goal: 'x' }, { dataLabels: ['local_only'] })), /local_only/);
  assert.equal(called, false);
});

/* -------------------------------------------- 6. coding task runner end to end */

console.log('6. coding task runner');

function runner(publish: (runId: string, o: PublishOptions) => Promise<PublishResult>) {
  return createCodingTaskRunner({ claudeCode: () => cc, workspaces: async () => workspaces as never, exec: execArgv, publish, pollMs: 20 });
}
const noPublish = async (): Promise<PublishResult> => {
  throw new Error('publish must not be called');
};
const spec = (over: Partial<CodingTaskInput>) => ({
  runId: 'run_g1',
  stepId: 'step_g1',
  nodeId: 'change',
  goal: 'write:src/math.js=export const clamp = (n, a, b) => Math.min(Math.max(n, a), b);',
  publish: 'none' as const,
  title: 'Add clamp',
  signal: signal(),
  ...over,
});

await test('workspace id: <runId>_<nodeId>, hashed when it would exceed 64 chars', () => {
  assert.equal(codingWorkspaceRunId('run_abc', 'change'), 'run_abc_change');
  const long = codingWorkspaceRunId('run_0123456789abcdef', 'n'.repeat(60));
  assert.ok(long.length <= 64 && long.startsWith('run_0123456789abcdef_'));
  assert.notEqual(long, codingWorkspaceRunId('run_0123456789abcdef', 'm'.repeat(60)));
});

await test('publish none: the change is committed on the node branch, worktree closed, main untouched', async () => {
  const out = await runner(noPublish)(spec({}));
  assert.equal(out.branch, 'zephyr/run_g1_change');
  assert.deepEqual(out.files, ['src/math.js']);
  assert.deepEqual(out.published, { status: 'committed' });
  assert.match(git(repo, 'show', 'zephyr/run_g1_change:src/math.js'), /clamp/);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'zephyr/run_g1_change'), 'Add clamp');
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore, 'main untouched');
  assert.equal(existsSync(gitWorkspaces.pathOf('run_g1_change')), false, 'worktree closed');
});

await test('publish branch: publish gets the node workspace, push-only; result says pushed', async () => {
  const calls: Array<{ runId: string; o: PublishOptions }> = [];
  const out = await runner(async (runId, o) => {
    calls.push({ runId, o });
    return { status: 'published', branch: 'zephyr/' + o.workspaceRunId, diffHash: 'h', bundleId: 'b', bodyPath: 'p' };
  })(spec({ runId: 'run_g2', publish: 'branch' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.runId, 'run_g2', 'approval and events on the graph run');
  assert.equal(calls[0]!.o.workspaceRunId, 'run_g2_change');
  assert.equal(calls[0]!.o.openPr, false);
  assert.equal(calls[0]!.o.stepId, 'step_g1');
  assert.deepEqual(out.published, { status: 'pushed' });
});

await test('publish blocked: the step fails, the work stays committed on its branch', async () => {
  await assert.rejects(
    runner(async () => ({ status: 'blocked', stage: 'approval', reason: 'rejected by a person' }))(
      spec({ runId: 'run_g3', publish: 'pr' }),
    ),
    /Not published \(approval\): rejected by a person\. The work is committed on zephyr\/run_g3_change/,
  );
  assert.match(git(repo, 'show', 'zephyr/run_g3_change:src/math.js'), /clamp/);
});

await test('no change: fails, and no branch is left behind', async () => {
  await assert.rejects(runner(noPublish)(spec({ runId: 'run_g4', goal: 'complete' })), /without changing any file/);
  assert.equal(git(repo, 'branch', '--list', 'zephyr/run_g4_change'), '');
});

console.log(`\n${passed} passed`);
await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
process.exit(0);
