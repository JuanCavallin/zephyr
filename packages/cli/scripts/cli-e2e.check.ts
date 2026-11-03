/**
 * End-to-end check for `zephyr run --wait` against the real API (docs/cacp-09).
 *
 * Boots two isolated copies of apps/api (own port, in-memory store, own SQLite file,
 * every provider on its mock, no keys), each against a throwaway git repo:
 *
 *   GIT_MODE=live  plan → run → --wait exits 3 on the merge approval → approve through
 *                  POST /api/approvals/:id/decide → the board succeeds and the task
 *                  branches land on the board's integration branch.
 *   GIT_MODE=mock  "Run ready tasks" is refused with 503 BOARD_UNAVAILABLE naming
 *                  GIT_MODE=live, and `zephyr run` says so and exits 1.
 *
 * Offline: no model, no network beyond 127.0.0.1. Takes a while because each API boots
 * through tsx; the boot time is printed.
 *
 *   pnpm --filter @htn/cli check:cli-e2e
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../src/api.js';
import { main, type MainIo } from '../src/main.js';
import { waitForBoard } from '../src/run.js';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/api');
const children: ChildProcess[] = [];
const scratch: string[] = [];

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

function capture(env: NodeJS.ProcessEnv): MainIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), env };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'zx-'));
  scratch.push(root);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'e2e@zephyr.local');
  git(repo, 'config', 'user.name', 'zephyr e2e');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# e2e fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => r(port));
    });
  });

/** Every setting that could point the child at a real provider or at this checkout's data. */
const INHERITED = /(_API_KEY|_MODE|_TOKEN|_SECRET|_DSN|_BASE_URL)$|^(MOCK_|ANTHROPIC_|GIT_|WORKSPACES_DIR|SQLITE_PATH|PORT$|PERSIST_)/i;

async function bootApi(gitMode: 'live' | 'mock'): Promise<{ base: string; repo: string; bootMs: number; log: string[] }> {
  const repo = tempRepo();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!INHERITED.test(k)) env[k] = v;
  Object.assign(env, {
    NODE_ENV: 'development',
    PORT: String(port),
    PERSIST_TO_DISK: 'false',
    GIT_MODE: gitMode,
    GIT_REPO_ROOT: repo,
    WORKSPACES_DIR: join(repo, '..', 'ws'),
    SQLITE_PATH: join(repo, '..', 'db.sqlite'),
    MOCK_MIN_LATENCY_MS: '0',
    MOCK_MAX_LATENCY_MS: '0',
    MOCK_FAILURE_RATE: '0',
  });
  const log: string[] = [];
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout!.on('data', (d: Buffer) => log.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => log.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  const api = new ApiClient({ base });
  while (!(await api.healthy(1_000))) {
    if (child.exitCode !== null) throw new Error(`API (${gitMode}) exited ${child.exitCode}:\n${log.join('').slice(-2000)}`);
    if (Date.now() - started > 120_000) throw new Error(`API (${gitMode}) not healthy after 120s:\n${log.join('').slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, repo, bootMs: Date.now() - started, log };
}

function stopAll() {
  for (const c of children) if (c.exitCode === null) c.kill();
}
process.on('exit', stopAll);

try {
  const [live, mock] = await Promise.all([bootApi('live'), bootApi('mock')]);
  console.log(`  api boot to healthy: live ${(live.bootMs / 1000).toFixed(1)}s, mock ${(mock.bootMs / 1000).toFixed(1)}s (in parallel)`);

  let boardId = '';
  await test('GIT_MODE=live: zephyr run --wait stops on the merge approval, exit 3', async () => {
    const io = capture({ ZEPHYR_WAIT_POLL_MS: '200', ZEPHYR_WEB: 'http://localhost:5173' });
    const code = await main(['run', 'add a greeting module', '--api', live.base, '--wait'], io);
    const out = io.lines.join('\n');
    assert.equal(code, 3, out + '\n' + io.errors.join('\n') + '\n' + live.log.join('').slice(-2000));
    boardId = /Board (run_\S+): \d+ tasks?/.exec(out)?.[1] ?? '';
    assert.ok(boardId, out);
    assert.match(out, /review\s+/);
    assert.match(out, /waiting on you/);
  });

  await test('GIT_MODE=live: approving every merge finishes the board; branches land on its integration branch', async () => {
    const api = new ApiClient({ base: live.base });
    assert.ok(boardId, 'the first test planned a board');
    let outcome = 'needs-you';
    let approved = 0;
    for (let round = 0; round < 10 && outcome === 'needs-you'; round++) {
      const inbox = await api.get<{ items: Array<{ kind: string; approval?: { id: string; status?: string } }> }>('/api/tasks/inbox');
      const pending = inbox.items.filter((i) => i.kind === 'approval' && i.approval);
      assert.ok(pending.length > 0, 'needs-you means something is in the inbox: ' + JSON.stringify(inbox).slice(0, 400));
      for (const item of pending) {
        await api.post(`/api/approvals/${item.approval!.id}/decide`, { decision: 'approved', note: 'e2e' });
        approved++;
      }
      ({ outcome } = await waitForBoard(api, boardId, { pollMs: 200, timeoutMs: 60_000 }));
    }
    assert.equal(outcome, 'succeeded', 'board outcome after ' + approved + ' approval(s)');
    const board = await api.get<{ tasks: Array<{ status: string }> }>(`/api/tasks/${boardId}`);
    assert.ok(board.tasks.every((t) => t.status === 'done'), JSON.stringify(board.tasks.map((t) => t.status)));
    const branches = git(live.repo, 'branch', '--list', 'zephyr/*', '--format=%(refname:short)').split('\n').filter(Boolean);
    assert.ok(branches.length >= 2, 'task and integration branches exist: ' + branches.join(', '));
    const ahead = branches
      .map((b) => ({ b, n: Number(git(live.repo, 'rev-list', '--count', 'main..' + b)) }))
      .sort((x, y) => y.n - x.n)[0]!;
    assert.ok(ahead.n >= board.tasks.length, `the integration branch ${ahead.b} carries every task's work (${ahead.n} commits)`);
    assert.equal(git(live.repo, 'rev-list', '--count', 'main'), '1', 'main itself is untouched');
  });

  await test('GIT_MODE=mock: run ready tasks answers 503 BOARD_UNAVAILABLE and zephyr run exits 1', async () => {
    const io = capture({});
    const code = await main(['run', 'add a greeting module', '--api', mock.base, '--wait'], io);
    assert.equal(code, 1, io.lines.join('\n'));
    assert.match(io.errors.join('\n'), /503 BOARD_UNAVAILABLE: .*GIT_MODE=live/);
  });
} finally {
  stopAll();
  await new Promise((r) => setTimeout(r, 500));
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A Windows handle still open; the OS temp dir cleans it eventually.
    }
  }
}

console.log(`\n${passed} passed`);
process.exit(0);
