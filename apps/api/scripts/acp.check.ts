/**
 * Step 2 check: the extracted ACP client against a mock peer, and git workspaces.
 *
 *   pnpm check:acp
 *
 * 1. Mock-peer scenarios each end in a typed terminal state.
 * 2. Cancel kills the whole process tree (a grandchild the peer spawned is gone).
 * 3. The scrubbed harness env carries no provider credentials.
 * 4. Live git workspaces on a throwaway repo: create, edit, diff, checkpoint,
 *    rewind (exact bytes), dispose, keepBranch, orphan reaping.
 * 5. The mock workspace provider honours the same contract.
 * 6. End to end: the mock peer edits a live worktree turn by turn, we checkpoint
 *    each turn, rewind to turn 1, and a terminal status disposes the worktree.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { AcpClient, denyPermission } = await import('../src/providers/_acp/client.js');
const { buildHarnessEnv, scrubbedEnv } = await import('../src/providers/_acp/config.js');
const { mockPeerHarness } = await import('../src/providers/_acp/mockPeer.js');
const { hermesHarness } = await import('../src/providers/hermes/live.js');
const { createLiveGitWorkspaces, checkpointRef } = await import('../src/providers/git/live.js');
const { createMockGitWorkspaces } = await import('../src/providers/git/mock.js');
const { create: createGitAdapter } = await import('../src/providers/git/index.js');
const { createWorkspacesService } = await import('../src/services/workspaces.service.js');

type Event = import('../src/providers/_acp/client.js').AcpEvent;
type Terminal = import('../src/providers/_acp/client.js').AcpTerminal;

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

const scratch = await mkdtemp(join(tmpdir(), 'zephyr-acp-check-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ 1. ACP client ------------------------------ */

const harness = mockPeerHarness({ timeouts: { turnIdleMs: 1_500, cancelGraceMs: 300 } });
const gateway = { url: 'http://127.0.0.1:8787/v1', token: 'run-scoped-token' };

async function runScenario(
  scenario: string,
  opts: {
    cwd?: string;
    onPermission?: Parameters<typeof AcpClient.start>[0]['onPermission'];
    cancelAfterMs?: number;
    onEvent?: (e: Event) => void;
  } = {},
): Promise<{ terminal: Terminal; text: string; events: Event[]; pid: number | undefined }> {
  const cwd = opts.cwd ?? scratch;
  const env = buildHarnessEnv(harness, { cwd, gateway });
  const client = await AcpClient.start({
    harness,
    cwd,
    env,
    onPermission: opts.onPermission ?? (() => 'allow'),
    stderr: 'ignore',
    log: () => {},
  });
  const pid = client.pid;
  try {
    const session = await client.newSession({ cwd });
    const events: Event[] = [];
    const pending = session.prompt(scenario, (e) => {
      events.push(e);
      opts.onEvent?.(e);
    });
    if (opts.cancelAfterMs !== undefined) {
      setTimeout(() => void session.cancel(), opts.cancelAfterMs);
    }
    const terminal = await pending;
    const text = events.map((e) => (e.type === 'text' ? e.text : '')).join('');
    return { terminal, text, events, pid };
  } finally {
    await client.close();
  }
}

console.log('ACP client vs mock peer');

await test('complete -> completed(end_turn) with text and tool call events', async () => {
  const r = await runScenario('complete');
  assert.deepEqual(r.terminal, { kind: 'completed', stopReason: 'end_turn' });
  assert.equal(r.text, 'hello worlddone');
  const calls = r.events.filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.type === 'tool_call' && [c.toolCallId, c.isUpdate, c.status]),
    [
      ['tc-1', false, 'pending'],
      ['tc-1', true, 'completed'],
    ],
  );
});

await test('permission allowed -> the peer acts', async () => {
  const cwd = join(scratch, 'perm-allow');
  await mkdir(cwd, { recursive: true });
  let asked = 0;
  const r = await runScenario('permission', {
    cwd,
    onPermission: () => {
      asked++;
      return 'allow';
    },
  });
  assert.equal(asked, 1);
  assert.equal(r.terminal.kind, 'completed');
  assert.equal(r.text, 'allowed');
  assert.equal(await readFile(join(cwd, 'permitted.txt'), 'utf8'), 'granted');
});

await test('permission denied -> the peer does not act', async () => {
  const cwd = join(scratch, 'perm-deny');
  await mkdir(cwd, { recursive: true });
  const r = await runScenario('permission', { cwd, onPermission: () => 'deny' });
  assert.equal(r.terminal.kind, 'completed');
  assert.equal(r.text, 'denied');
  assert.equal(existsSync(join(cwd, 'permitted.txt')), false);
});

await test('a throwing permission handler fails closed', async () => {
  const cwd = join(scratch, 'perm-throw');
  await mkdir(cwd, { recursive: true });
  const r = await runScenario('permission', {
    cwd,
    onPermission: () => {
      throw new Error('policy engine down');
    },
  });
  assert.equal(r.text, 'denied');
  assert.equal(existsSync(join(cwd, 'permitted.txt')), false);
});

await test('denyPermission picks a reject option, else cancels', () => {
  assert.deepEqual(
    denyPermission([
      { optionId: 'a', kind: 'allow_once' },
      { optionId: 'r', kind: 'reject_once' },
    ]),
    { outcome: 'selected', optionId: 'r' },
  );
  assert.deepEqual(denyPermission([{ optionId: 'a', kind: 'allow_once' }]), { outcome: 'cancelled' });
});

await test('error -> failed(agent_error)', async () => {
  const r = await runScenario('error');
  assert.equal(r.terminal.kind, 'failed');
  assert.equal(r.terminal.kind === 'failed' && r.terminal.reason, 'agent_error');
});

await test('crash mid-turn -> failed(crashed) naming the exit code', async () => {
  const r = await runScenario('crash');
  assert.equal(r.terminal.kind, 'failed');
  assert.equal(r.terminal.kind === 'failed' && r.terminal.reason, 'crashed');
  assert.match(r.terminal.kind === 'failed' ? r.terminal.message : '', /3/);
});

await test('malformed stdout line -> failed(protocol_error)', async () => {
  const r = await runScenario('malformed');
  assert.equal(r.terminal.kind === 'failed' && r.terminal.reason, 'protocol_error');
});

await test('silent agent -> failed(timeout)', async () => {
  const r = await runScenario('hang');
  assert.equal(r.terminal.kind === 'failed' && r.terminal.reason, 'timeout');
});

await test('cancel during a turn -> cancelled', async () => {
  const r = await runScenario('slow', { cancelAfterMs: 500 });
  assert.deepEqual(r.terminal, { kind: 'cancelled' });
  assert.ok(r.text.length > 0, 'expected some chunks before the cancel');
});

await test('cancel kills the whole process tree (grandchild gone)', async () => {
  let childPid: number | undefined;
  const r = await runScenario('spawn-child', {
    cancelAfterMs: 800,
    onEvent: (e) => {
      const m = e.type === 'text' ? /child:(\d+)/.exec(e.text) : null;
      if (m) childPid = Number(m[1]);
    },
  });
  assert.deepEqual(r.terminal, { kind: 'cancelled' });
  assert.ok(childPid, 'the peer never reported its grandchild pid');
  const deadline = Date.now() + 5_000;
  while (alive(childPid!) && Date.now() < deadline) await sleep(100);
  assert.equal(alive(childPid!), false, `grandchild ${childPid} survived cancel`);
  if (r.pid) assert.equal(alive(r.pid), false, `peer ${r.pid} survived cancel`);
});

/* --------------------------- 2. scrubbed environment --------------------------- */

console.log('Harness environment');

const dirtyEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  Path: 'C:\\Windows',
  SYSTEMROOT: 'C:\\Windows',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  AI_GATEWAY_API_KEY: 'gw-secret',
  GITHUB_TOKEN: 'ghp-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
};

await test('scrubbed env drops provider keys, keeps the allowlist and the gateway', () => {
  for (const env of [
    scrubbedEnv(dirtyEnv, gateway),
    buildHarnessEnv(harness, { cwd: scratch, gateway }, dirtyEnv),
  ]) {
    for (const secret of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AI_GATEWAY_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      assert.equal(env[secret], undefined, `${secret} leaked into the harness env`);
    }
    assert.ok(!Object.values(env).some((v) => v.includes('secret')), 'a secret value leaked');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.Path, 'C:\\Windows');
    assert.equal(env.ZEPHYR_GATEWAY_URL, gateway.url);
    assert.equal(env.ZEPHYR_GATEWAY_TOKEN, gateway.token);
  }
});

await test('the real mock-peer child sees no provider keys', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
    AI_GATEWAY_API_KEY: 'gw-secret',
  });
  try {
    const env = buildHarnessEnv(harness, { cwd: scratch, gateway });
    const keys = JSON.parse(
      execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
        env,
        encoding: 'utf8',
      }),
    ) as string[];
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY']) {
      assert.ok(!keys.includes(k), `${k} reached the child`);
    }
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

await test('Hermes keeps its env contract (inherits, plus its own keys)', () => {
  const env = buildHarnessEnv(
    hermesHarness,
    {
      cwd: scratch,
      gateway: { url: 'http://127.0.0.1:8787/v1', token: 'agentos-local' },
      mcp: { url: 'http://127.0.0.1:8787/mcp', token: 'mcp-token' },
      stateDir: '/profiles/x',
    },
    { PATH: '/usr/bin', SOMETHING_ELSE: '1' },
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SOMETHING_ELSE, '1');
  assert.equal(env.AGENTOS_GATEWAY_API_KEY, 'agentos-local');
  assert.equal(env.OPENAI_API_KEY, 'agentos-local');
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:8787/v1');
  assert.equal(env.HERMES_HOME, '/profiles/x');
  assert.equal(env.HERMES_ACP_SKIP_CONFIGURED_MCP, '0');
  assert.equal(env.AGENTOS_MCP_API_KEY, 'mcp-token');
});

/* ----------------------------- 3. live git workspaces ----------------------------- */

console.log('Live git workspaces');

const G = ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t'];
function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8', windowsHide: true });
}

const repo = join(scratch, 'repo');
await mkdir(repo, { recursive: true });
sh(repo, 'init', '-q', '-b', 'main');
await writeFile(join(repo, 'README.md'), 'hello\n');
await writeFile(join(repo, '.gitignore'), 'ignored.log\n');
sh(repo, 'add', '-A');
sh(repo, 'commit', '-q', '-m', 'init');
const baseSha = sh(repo, 'rev-parse', 'HEAD').trim();
const wsDir = join(scratch, 'ws');

const live = createLiveGitWorkspaces({ repoRoot: repo, workspacesDir: wsDir });
const branchExists = (b: string) => {
  try {
    sh(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + b);
    return true;
  } catch {
    return false;
  }
};
const refsUnder = (prefix: string) =>
  sh(repo, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);

// Bytes git would mangle under autocrlf, plus a NUL-laden binary blob.
const CRLF = Buffer.from('line one\r\nline two\r\n');
const BINARY = Buffer.from([0, 1, 2, 255, 13, 10, 0, 254]);

await test('invalid run ids are rejected', async () => {
  for (const bad of ['', '../escape', 'a b', 'x/y', '-rf', 'a'.repeat(65)]) {
    await assert.rejects(() => live.create(bad, 'HEAD'), /Invalid runId/);
  }
  await assert.rejects(() => live.create('okid', '--upload-pack=x'), /Invalid git revision/);
});

await test('create -> worktree at <dir>/<runId> on zephyr/<runId>', async () => {
  const { path, branch } = await live.create('run-a', 'HEAD');
  assert.equal(path, join(wsDir, 'run-a'));
  assert.equal(branch, 'zephyr/run-a');
  assert.equal(await readFile(join(path, 'README.md'), 'utf8'), 'hello\n');
  assert.ok(branchExists('zephyr/run-a'));
  assert.equal(sh(path, 'rev-parse', 'HEAD').trim(), baseSha);
  assert.match(sh(repo, 'worktree', 'list'), /run-a/);
  await assert.rejects(() => live.create('run-a', 'HEAD'), /already exists/);
});

await test('edit -> diff shows the change with a sha256 hash', async () => {
  const path = live.pathOf('run-a');
  await writeFile(join(path, 'README.md'), 'hello\nworld\n');
  await writeFile(join(path, 'new.txt'), 'brand new\n');
  await writeFile(join(path, 'ignored.log'), 'noise\n');
  const d = await live.diff('run-a');
  assert.match(d.stat, /README\.md/);
  assert.match(d.stat, /new\.txt/);
  assert.doesNotMatch(d.stat, /ignored\.log/);
  assert.match(d.patch, /\+world/);
  assert.match(d.hash, /^[0-9a-f]{64}$/);
  assert.equal((await live.diff('run-a')).hash, d.hash, 'diff must be deterministic');
  // Diffing never touches the harness's own index.
  assert.equal(sh(path, 'diff', '--cached', '--name-only').trim(), '');
});

await test('checkpoint + rewind restore exact bytes (CRLF, binary, deletions)', async () => {
  const path = live.pathOf('run-a');
  await mkdir(join(path, 'sub'), { recursive: true });
  await writeFile(join(path, 'sub', 'crlf.txt'), CRLF);
  await writeFile(join(path, 'blob.bin'), BINARY);
  const c1 = await live.checkpoint('run-a', 1);
  assert.equal(c1.ref, checkpointRef('run-a', 1));
  assert.match(c1.treeHash, /^[0-9a-f]{40}$/);

  // Turn 2 trashes everything.
  await writeFile(join(path, 'sub', 'crlf.txt'), 'line one\nline two\n');
  await writeFile(join(path, 'blob.bin'), 'text now');
  await rm(join(path, 'new.txt'));
  await writeFile(join(path, 'README.md'), 'rewritten\n');
  await writeFile(join(path, 'extra.txt'), 'created after checkpoint 1\n');
  await mkdir(join(path, 'deep', 'er'), { recursive: true });
  await writeFile(join(path, 'deep', 'er', 'x.txt'), 'x');
  sh(path, 'add', 'extra.txt'); // a staged file must not survive the rewind either
  const c2 = await live.checkpoint('run-a', 2);
  assert.notEqual(c2.treeHash, c1.treeHash);

  await live.rewind('run-a', c1.ref);
  assert.deepEqual(await readFile(join(path, 'sub', 'crlf.txt')), CRLF);
  assert.deepEqual(await readFile(join(path, 'blob.bin')), BINARY);
  assert.equal(await readFile(join(path, 'new.txt'), 'utf8'), 'brand new\n');
  assert.equal(await readFile(join(path, 'README.md'), 'utf8'), 'hello\nworld\n');
  assert.equal(existsSync(join(path, 'extra.txt')), false);
  assert.equal(existsSync(join(path, 'deep', 'er', 'x.txt')), false);
  assert.equal(await readFile(join(path, 'ignored.log'), 'utf8'), 'noise\n', 'ignored files are left alone');
  assert.equal((await live.checkpoint('run-a', 3)).treeHash, c1.treeHash);

  // And forward again.
  await live.rewind('run-a', c2.ref);
  assert.equal(await readFile(join(path, 'extra.txt'), 'utf8'), 'created after checkpoint 1\n');
  assert.equal(await readFile(join(path, 'blob.bin'), 'utf8'), 'text now');

  const since = await live.diff('run-a', c1.ref);
  assert.match(since.stat, /extra\.txt/);
  assert.doesNotMatch(since.stat, /ignored\.log/);
  // Checkpoints never move the run branch.
  assert.equal(sh(path, 'rev-parse', 'HEAD').trim(), baseSha);
  assert.equal(await live.commitsAhead('run-a'), 0);
});

await test('dispose removes worktree, branch, checkpoint refs and meta (idempotent)', async () => {
  assert.ok(refsUnder('refs/zephyr/checkpoints/run-a/').length >= 3);
  await live.dispose('run-a', false);
  assert.equal(existsSync(join(wsDir, 'run-a')), false);
  assert.equal(branchExists('zephyr/run-a'), false);
  assert.deepEqual(refsUnder('refs/zephyr/checkpoints/run-a/'), []);
  assert.doesNotMatch(sh(repo, 'worktree', 'list'), /run-a/);
  assert.deepEqual(await live.list(), []);
  await live.dispose('run-a', false);
  // The main checkout was never touched.
  assert.equal(sh(repo, 'status', '--porcelain').trim(), '');
});

await test('dispose(keepBranch) keeps the branch and its commits', async () => {
  const { path } = await live.create('run-keep', 'main');
  await writeFile(join(path, 'feature.txt'), 'feature\n');
  sh(path, 'add', 'feature.txt');
  sh(path, 'commit', '-q', '-m', 'feature');
  assert.equal(await live.commitsAhead('run-keep'), 1);
  await live.checkpoint('run-keep', 1);
  await live.dispose('run-keep', true);
  assert.equal(existsSync(path), false);
  assert.ok(branchExists('zephyr/run-keep'));
  assert.deepEqual(refsUnder('refs/zephyr/checkpoints/run-keep/'), []);
  assert.match(sh(repo, 'show', 'zephyr/run-keep:feature.txt'), /feature/);
  sh(repo, 'branch', '-D', 'zephyr/run-keep');
});

await test('a crashed process leaves worktrees; a fresh one reaps them at startup', async () => {
  // "Process 1" creates two runs and dies without cleaning up.
  const p1 = createLiveGitWorkspaces({ repoRoot: repo, workspacesDir: wsDir });
  const lost = await p1.create('run-lost', 'HEAD');
  await writeFile(join(lost.path, 'wip.txt'), 'uncommitted\n');
  await p1.checkpoint('run-lost', 1);
  const committed = await p1.create('run-committed', 'HEAD');
  await writeFile(join(committed.path, 'done.txt'), 'done\n');
  sh(committed.path, 'add', 'done.txt');
  sh(committed.path, 'commit', '-q', '-m', 'done');

  // "Process 2" boots: no run is active, so everything on disk is an orphan.
  const p2 = createLiveGitWorkspaces({ repoRoot: repo, workspacesDir: wsDir });
  assert.deepEqual(await p2.list(), ['run-committed', 'run-lost']);
  const reaped = await createWorkspacesService(() => ({ ...p2 }) as never).reapOrphans();
  assert.deepEqual(reaped, [
    { runId: 'run-committed', keptBranch: true },
    { runId: 'run-lost', keptBranch: false },
  ]);
  assert.equal(existsSync(lost.path), false);
  assert.equal(existsSync(committed.path), false);
  assert.equal(branchExists('zephyr/run-lost'), false);
  assert.ok(branchExists('zephyr/run-committed'));
  assert.deepEqual(refsUnder('refs/zephyr/checkpoints/'), []);
  assert.deepEqual(await p2.list(), []);
  sh(repo, 'branch', '-D', 'zephyr/run-committed');
});

await test('reaping skips active runs and recovers a half-made workspace', async () => {
  const active = await live.create('run-active', 'HEAD');
  // A meta file with no worktree: `worktree add` died after meta was written.
  await writeFile(
    join(wsDir, '.meta', 'run-half.json'),
    JSON.stringify({ runId: 'run-half', repoRoot: repo, path: join(wsDir, 'run-half'), branch: 'zephyr/run-half', base: 'HEAD', baseCommit: baseSha, createdAt: new Date().toISOString() }),
  );
  const svc = createWorkspacesService(() => ({ ...live }) as never);
  const reaped = await svc.reapOrphans(['run-active']);
  assert.deepEqual(reaped, [{ runId: 'run-half', keptBranch: false }]);
  assert.ok(existsSync(active.path));
  assert.deepEqual(await live.list(), ['run-active']);
  await live.dispose('run-active', false);
});

await test('registry adapter: GIT_MODE=live health, disabled throws', async () => {
  const adapter = createGitAdapter({ mode: 'live', repoRoot: repo, workspacesDir: wsDir } as never);
  assert.equal(adapter.id, 'git');
  assert.deepEqual([...adapter.capabilities], ['workspace']);
  const health = await adapter.health();
  assert.equal(health.ok, true);
  const bad = createGitAdapter({ mode: 'live', repoRoot: scratch + '/nope', workspacesDir: wsDir } as never);
  assert.equal((await bad.health()).ok, false);
  const off = createGitAdapter({ mode: 'disabled' } as never);
  await assert.rejects(async () => off.create('x', 'HEAD'), /disabled/);
  assert.deepEqual(await off.list(), []);
});

/* ------------------------------- 4. mock workspaces ------------------------------- */

console.log('Mock git workspaces');

await test('mock: create, diff, checkpoint, rewind exact bytes, dispose', async () => {
  const mock = createMockGitWorkspaces();
  await assert.rejects(() => mock.create('../x', 'HEAD'), /Invalid runId/);
  const { path, branch } = await mock.create('m1', 'HEAD');
  assert.equal(branch, 'zephyr/m1');
  assert.equal(mock.pathOf('m1'), path);
  await mkdir(join(path, 'sub'), { recursive: true });
  await writeFile(join(path, 'sub', 'crlf.txt'), CRLF);
  await writeFile(join(path, 'blob.bin'), BINARY);
  const d = await mock.diff('m1');
  assert.match(d.stat, /sub\/crlf\.txt/);
  assert.match(d.hash, /^[0-9a-f]{64}$/);
  const c1 = await mock.checkpoint('m1', 1);
  assert.equal(c1.ref, checkpointRef('m1', 1));
  await writeFile(join(path, 'sub', 'crlf.txt'), 'changed');
  await rm(join(path, 'blob.bin'));
  await writeFile(join(path, 'extra.txt'), 'extra');
  assert.match((await mock.diff('m1', c1.ref)).stat, /extra\.txt/);
  await mock.rewind('m1', c1.ref);
  assert.deepEqual(await readFile(join(path, 'sub', 'crlf.txt')), CRLF);
  assert.deepEqual(await readFile(join(path, 'blob.bin')), BINARY);
  assert.equal(existsSync(join(path, 'extra.txt')), false);
  assert.equal((await mock.checkpoint('m1', 2)).treeHash, c1.treeHash);
  assert.deepEqual(await mock.list(), ['m1']);
  await mock.dispose('m1', false);
  assert.equal(existsSync(path), false);
  assert.deepEqual(await mock.list(), []);
});

await test('service: finish disposes only on a terminal status', async () => {
  const mock = createMockGitWorkspaces();
  const svc2 = createWorkspacesService(() => mock as never);
  const { path } = await svc2.open('s1');
  assert.equal(await svc2.finish('s1', 'running'), false);
  assert.ok(existsSync(path));
  assert.equal(await svc2.finish('s1', 'cancelled'), true);
  assert.equal(existsSync(path), false);
});

/* --------------------------------- 5. end to end --------------------------------- */

console.log('End to end: mock harness in a live worktree');

await test('turns are checkpointed, rewind restores turn 1, failure disposes', async () => {
  const svc = createWorkspacesService(() => ({ ...live }) as never);
  const runId = 'e2e-run';
  const { path } = await svc.open(runId);

  const client = await AcpClient.start({
    harness,
    cwd: path,
    env: buildHarnessEnv(harness, { cwd: path, gateway }),
    onPermission: () => 'deny',
    stderr: 'ignore',
    log: () => {},
  });
  try {
    const session = await client.newSession({ cwd: path });
    const t1 = await session.prompt('write:notes.md=first draft');
    assert.equal(t1.kind, 'completed');
    const cp1 = await svc.checkpointTurn(runId);
    assert.equal(cp1.turn, 1);

    const t2 = await session.prompt('write:notes.md=second draft');
    assert.equal(t2.kind, 'completed');
    assert.equal((await session.prompt('write:src/extra.ts=export {}')).kind, 'completed');
    const cp2 = await svc.checkpointTurn(runId);
    assert.equal(cp2.turn, 2);
    assert.equal(await readFile(join(path, 'notes.md'), 'utf8'), 'second draft');

    const permission = await session.prompt('permission');
    assert.equal(permission.kind, 'completed');
    assert.equal(existsSync(join(path, 'permitted.txt')), false, 'denied permission must not write');

    const diff = await svc.diff(runId);
    assert.match(diff.stat, /notes\.md/);
    assert.match(diff.stat, /src\/extra\.ts/);

    await svc.rewind(runId, cp1.ref);
    assert.equal(await readFile(join(path, 'notes.md'), 'utf8'), 'first draft');
    assert.equal(existsSync(join(path, 'src', 'extra.ts')), false);
  } finally {
    await client.close();
  }

  assert.equal(await svc.finish(runId, 'failed'), true);
  assert.equal(existsSync(path), false);
  assert.equal(branchExists('zephyr/' + runId), false);
  assert.deepEqual(refsUnder('refs/zephyr/checkpoints/'), []);
});

await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(`\ncheck:acp — ${passed} passed`);
process.exit(0);
