/**
 * Offline checks for the `zephyr` CLI (docs/cacp-09): harness and key detection with
 * fake binaries on PATH (including Windows `.cmd` shims), `run` and `hook install`
 * against a fake Zephyr API that enforces the local-control cookie, the idempotent
 * settings merge, templates, and the evidence summary.
 *
 *   pnpm --filter @htn/cli check:cli
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TASK_TEMPLATE_IDS } from '@htn/shared';
import { ApiClient } from '../src/api.js';
import { detect, findExecutable, formatDetection, parseDotenv, probeVersion, quoteWin } from '../src/detect.js';
import { installHook, mergeObserved, settingsPath, stripZephyr, uninstallHook, type ClaudeSettings } from '../src/hook.js';
import { main, type MainIo } from '../src/main.js';
import { evidencePath } from '../src/summary.js';

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

const scratch = mkdtempSync(join(tmpdir(), 'zephyr cli '));
const SECRET = 'sk-test-must-never-print-0123456789';

function capture(env: NodeJS.ProcessEnv = {}): MainIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), env };
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

const winBin = join(scratch, 'win bin');
const otherBin = join(scratch, 'other');
mkdirSync(winBin, { recursive: true });
mkdirSync(otherBin, { recursive: true });
// What npm installs on Windows: a .cmd shim. Codex as a plain .exe stand-in.
writeFileSync(join(winBin, 'claude.cmd'), '@echo off\r\necho 9.9.9 (Claude Code)\r\n');
writeFileSync(join(otherBin, 'codex.exe'), 'not really an exe');

await test('win32: finds a .cmd shim via PATHEXT, case-insensitive Path, quoted entries', () => {
  const env = { Path: `"${winBin}";${otherBin}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const claude = findExecutable('claude', { env, platform: 'win32' });
  assert.ok(claude, 'claude found');
  assert.equal(claude.path, join(winBin, 'claude.cmd'));
  assert.equal(claude.shim, true);
  const codex = findExecutable('codex', { env, platform: 'win32' });
  assert.equal(codex?.path, join(otherBin, 'codex.exe'));
  assert.equal(codex?.shim, false);
});

await test('win32: PATHEXT without .CMD does not find the shim; missing PATH finds nothing', () => {
  assert.equal(findExecutable('claude', { env: { PATH: winBin, PATHEXT: '.EXE' }, platform: 'win32' }), null);
  assert.equal(findExecutable('claude', { env: {}, platform: 'win32' }), null);
});

await test('win32: first PATH entry wins', () => {
  writeFileSync(join(otherBin, 'claude.exe'), 'x');
  const hit = findExecutable('claude', { env: { PATH: `${otherBin};${winBin}` }, platform: 'win32' });
  assert.equal(hit?.path, join(otherBin, 'claude.exe'));
  rmSync(join(otherBin, 'claude.exe'));
});

await test('posix: finds an executable file with no extension, ignores directories', () => {
  const posixBin = join(scratch, 'posixbin');
  mkdirSync(join(posixBin, 'codex'), { recursive: true }); // a directory named codex
  writeFileSync(join(posixBin, 'claude'), '#!/bin/sh\necho 1.0.0\n');
  chmodSync(join(posixBin, 'claude'), 0o755);
  // A ':'-separated PATH cannot carry a Windows drive letter: use a relative entry.
  const dir = process.platform === 'win32' ? relative(process.cwd(), posixBin) : posixBin;
  if (dir.includes(':')) return; // other drive; covered on posix hosts
  const env = { PATH: dir };
  assert.ok(findExecutable('claude', { env, platform: 'linux' }));
  assert.equal(findExecutable('codex', { env, platform: 'linux' }), null);
  assert.equal(findExecutable('claude.cmd', { env, platform: 'linux' }), null);
});

await test('parseDotenv: comments, export, quotes, trailing comments', () => {
  const parsed = parseDotenv(
    ['# a comment', 'export A=1', 'B = "two words"', "C='x # not a comment'", 'D=plain # trailing', 'not a line', 'E='].join('\r\n'),
  );
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'x # not a comment', D: 'plain', E: '' });
});

await test('detect: keys from env and .env, empty values are absent, values never printed', () => {
  const dotenv = join(scratch, '.env');
  writeFileSync(dotenv, `AI_GATEWAY_API_KEY=${SECRET}\nGEMINI_API_KEY=\n`);
  const d = detect({
    env: { Path: winBin, PATHEXT: '.CMD', anthropic_api_key: SECRET, OPENAI_API_KEY: '  ' },
    platform: 'win32',
    dotenvPath: dotenv,
  });
  const key = (n: string) => d.keys.find((k) => k.name === n)!;
  assert.deepEqual([key('ANTHROPIC_API_KEY').present, key('ANTHROPIC_API_KEY').source], [true, 'env']);
  assert.deepEqual([key('AI_GATEWAY_API_KEY').present, key('AI_GATEWAY_API_KEY').source], [true, '.env']);
  assert.equal(key('OPENAI_API_KEY').present, false, 'blank is absent');
  assert.equal(key('GEMINI_API_KEY').present, false);
  assert.equal(d.binaries.find((b) => b.name === 'claude')?.shim, true);
  assert.equal(d.binaries.find((b) => b.name === 'codex')?.path, null);
  const text = formatDetection(d, { claude: '9.9.9' });
  assert.ok(!text.includes(SECRET), 'a key value leaked into the report');
  assert.ok(!JSON.stringify(d).includes(SECRET), 'a key value leaked into the detection');
  assert.match(text, /✓ Claude Code .*claude\.cmd \(shim\), 9\.9\.9/);
  assert.match(text, /✗ Codex \(codex\) not on PATH/);
});

await test('detect: no harness at all says boards run on the mock harness', () => {
  const text = formatDetection(detect({ env: { PATH: '' }, platform: 'win32' }));
  assert.match(text, /No harness found/);
});

await test('quoteWin quotes spaces and doubles quotes', () => {
  assert.equal(quoteWin('C:\\bin\\claude.cmd'), 'C:\\bin\\claude.cmd');
  assert.equal(quoteWin('C:\\win bin\\claude.cmd'), '"C:\\win bin\\claude.cmd"');
  assert.equal(quoteWin('say "hi"'), '"say ""hi"""');
});

if (process.platform === 'win32') {
  await test('probeVersion runs a real .cmd shim in a directory with a space', async () => {
    const v = await probeVersion({ name: 'claude', path: join(winBin, 'claude.cmd'), shim: true });
    assert.equal(v, '9.9.9 (Claude Code)');
    writeFileSync(join(winBin, 'broken.cmd'), '@echo off\r\nexit /b 3\r\n');
    assert.equal(await probeVersion({ name: 'claude', path: join(winBin, 'broken.cmd'), shim: true }), null);
  });
} else {
  await test('probeVersion runs a real executable', async () => {
    const p = join(scratch, 'claude-sh');
    writeFileSync(p, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
    chmodSync(p, 0o755);
    assert.equal(await probeVersion({ name: 'claude', path: p, shim: false }), '9.9.9 (Claude Code)');
  });
}
await test('probeVersion: no path is null', async () => {
  assert.equal(await probeVersion({ name: 'codex', path: null, shim: false }), null);
});

/* -------------------------------------------------------------------------- */
/* A fake Zephyr API: same session and cookie rules as the real one           */
/* -------------------------------------------------------------------------- */

interface Seen {
  method: string;
  url: string;
  body: unknown;
}
const seen: Seen[] = [];
const COOKIE = 'agentos_local_control=tok123';

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
  });
}
function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

const task = (id: string, title: string, status = 'pending') => ({
  id,
  title,
  status,
  writeScope: ['src/' + id + '/**'],
  dependsOn: [],
});

const server = createServer(async (req, res) => {
  const b = await body(req);
  seen.push({ method: req.method!, url: req.url!, body: b });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === '/api/credentials/session') {
    if (req.headers.origin !== origin) return json(res, 403, { error: { code: 'FORBIDDEN', message: 'bad origin' } });
    return json(res, 200, { ok: true }, { 'Set-Cookie': COOKIE + '; HttpOnly; Path=/api; SameSite=Strict' });
  }
  if (req.method !== 'GET' && req.headers.cookie !== COOKIE)
    return json(res, 403, { error: { code: 'LOCAL_CONTROL_REQUIRED', message: 'no cookie' } });
  if (req.method === 'POST' && req.url === '/api/tasks') {
    const rb = b as { request: string; template?: string };
    if (rb.request === 'explode') return json(res, 400, { error: { code: 'VALIDATION', message: 'bad request' } });
    return json(res, 201, {
      run: { id: 'run_board1', status: 'pending' },
      tasks: [task('t1', 'Add the toggle'), task('t2', 'Persist the choice')],
      waves: [['t1'], ['t2']],
    });
  }
  if (req.method === 'POST' && req.url === '/api/tasks/run_board1/run')
    return json(res, 202, {
      run: { id: 'run_board1', status: 'running' },
      tasks: [task('t1', 'Add the toggle', 'running'), task('t2', 'Persist the choice')],
      waves: [['t1'], ['t2']],
    });
  if (req.method === 'POST' && req.url === '/api/observed/claudecode') {
    const hookUrl = `${origin}/api/hooks/claudecode/hk_${seen.length}`;
    const otel = `${origin}/api/otel/hk_${seen.length}`;
    const entry = [{ matcher: '*', hooks: [{ type: 'http', url: hookUrl, timeout: 30 }] }];
    const env = { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: otel };
    return json(res, 201, {
      runId: 'run_obs' + seen.length,
      snippet: {
        settings: {
          hooks: { PreToolUse: entry, PostToolUse: entry, Stop: entry },
          permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
          env,
        },
        env,
        hookUrl,
        otelEndpoint: otel,
      },
    });
  }
  json(res, 404, { error: { code: 'NOT_FOUND', message: req.url } });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

await test('ApiClient: session sends the API origin, keeps the cookie, posts with it', async () => {
  seen.length = 0;
  const api = new ApiClient({ base: apiBase + '/' });
  assert.equal(await api.healthy(), true);
  await api.post('/api/tasks', { request: 'x' });
  await api.post('/api/tasks', { request: 'y' });
  assert.equal(seen.filter((s) => s.url === '/api/credentials/session').length, 1, 'one session for the process');
  await assert.rejects(api.post('/api/tasks', { request: 'explode' }), /400 VALIDATION: bad request/);
  assert.equal(await new ApiClient({ base: 'http://127.0.0.1:1' }).healthy(500), false);
});

await test('zephyr run: plans and starts a board, template passes through, no concurrency unless set', async () => {
  seen.length = 0;
  const io = capture({ ZEPHYR_API: apiBase, ZEPHYR_WEB: 'http://localhost:5173/' });
  const code = await main(['run', 'add a dark mode toggle', '--template', 'polish-ui'], io);
  assert.equal(code, 0, io.errors.join('\n'));
  const create = seen.find((s) => s.url === '/api/tasks')!;
  assert.deepEqual(create.body, { request: 'add a dark mode toggle', template: 'polish-ui' });
  const run = seen.find((s) => s.url === '/api/tasks/run_board1/run')!;
  assert.deepEqual(run.body, {}, "the template's concurrency stands");
  const out = io.lines.join('\n');
  assert.match(out, /Board run_board1: 2 tasks/);
  assert.match(out, /wave 1\n\s+running\s+Add the toggle/);
  assert.match(out, /http:\/\/localhost:5173\/board\/run_board1/);
});

await test('zephyr run --plan --concurrency --private --base: creates only, sends the flags', async () => {
  seen.length = 0;
  const io = capture({ ZEPHYR_API: apiBase });
  assert.equal(await main(['run', 'fix', 'the', 'build', '--plan', '--private', '--base', 'main', '--concurrency', '2'], io), 0);
  assert.deepEqual(seen.find((s) => s.url === '/api/tasks')!.body, { request: 'fix the build', private: true, base: 'main' });
  assert.equal(seen.some((s) => s.url.endsWith('/run')), false, '--plan does not start');
  assert.match(io.lines.join('\n'), /Planned only/);

  seen.length = 0;
  assert.equal(await main(['run', 'x', '--concurrency', '2'], capture({ ZEPHYR_API: apiBase })), 0);
  assert.deepEqual(seen.find((s) => s.url.endsWith('/run'))!.body, { concurrency: 2 });
});

await test('zephyr run: usage errors exit 2, server down exits 1, API errors are printed', async () => {
  const bad = capture({ ZEPHYR_API: apiBase });
  assert.equal(await main(['run', 'x', '--template', 'nope'], bad), 2);
  assert.match(bad.errors[0]!, /Unknown template "nope"\. One of: add-feature, fix-ci/);
  assert.equal(await main(['run', 'x', '--concurrency', '9'], capture({ ZEPHYR_API: apiBase })), 2);
  assert.equal(await main(['run'], capture({ ZEPHYR_API: apiBase })), 2);
  assert.equal(await main(['run', 'x', '--bogus'], capture({ ZEPHYR_API: apiBase })), 2);
  const down = capture({ ZEPHYR_API: 'http://127.0.0.1:1' });
  assert.equal(await main(['run', 'x'], down), 1);
  assert.match(down.errors[0]!, /not running .* zephyr up/);
  const failing = capture({ ZEPHYR_API: apiBase });
  assert.equal(await main(['run', 'explode'], failing), 1);
  assert.match(failing.errors[0]!, /VALIDATION/);
});

/* -------------------------------------------------------------------------- */
/* Hook installer                                                             */
/* -------------------------------------------------------------------------- */

const project = join(scratch, 'my project');
mkdirSync(join(project, '.claude'), { recursive: true });
const userSettings: ClaudeSettings = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-guard' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
  permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(npm test)'], deny: ['Read(.env)'] },
  env: { MY_VAR: '1' },
};

await test('hook install: merges into settings.local.json, keeps user settings, disables bypass', async () => {
  writeFileSync(settingsPath(project), '\uFEFF' + JSON.stringify(userSettings, null, 2));
  const io = capture({ ZEPHYR_API: apiBase });
  assert.equal(await main(['hook', 'install', '--cwd', project], io), 0, io.errors.join('\n'));
  const s = JSON.parse(readFileSync(settingsPath(project), 'utf8')) as ClaudeSettings;
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks!.PreToolUse!.length, 2, 'user hook + Zephyr hook');
  assert.equal(s.hooks!.PreToolUse![0]!.hooks[0]!.command, 'lint-guard', 'user hook first, untouched');
  assert.match(String(s.hooks!.PreToolUse![1]!.hooks[0]!.url), /\/api\/hooks\/claudecode\//);
  assert.ok(s.hooks!.PostToolUse && s.hooks!.Stop && s.hooks!.SessionStart);
  assert.equal(s.permissions!.defaultMode, 'default', 'bypass replaced');
  assert.equal(s.permissions!.disableBypassPermissionsMode, 'disable');
  assert.deepEqual(s.permissions!.allow, ['Bash(npm test)']);
  assert.deepEqual(s.permissions!.deny, ['Read(.env)']);
  assert.equal(s.env!.MY_VAR, '1');
  assert.match(s.env!.OTEL_EXPORTER_OTLP_ENDPOINT!, /\/api\/otel\//);
  assert.match(io.lines.join('\n'), /Installed Zephyr hooks .*\/runs\/run_obs/s);
});

await test('hook install twice: replaces Zephyr entries instead of stacking them', async () => {
  const io = capture({ ZEPHYR_API: apiBase });
  assert.equal(await main(['hook', 'install', '--cwd', project], io), 0);
  const s = JSON.parse(readFileSync(settingsPath(project), 'utf8')) as ClaudeSettings;
  assert.equal(s.hooks!.PreToolUse!.length, 2);
  assert.equal(s.hooks!.Stop!.length, 1);
  assert.match(io.lines[0]!, /^Replaced/);
});

await test('hook uninstall: back to the user settings, except bypass stays off', async () => {
  const io = capture();
  assert.equal(await main(['hook', 'uninstall', '--cwd', project], io), 0);
  const s = JSON.parse(readFileSync(settingsPath(project), 'utf8')) as ClaudeSettings;
  assert.deepEqual(s.hooks, userSettings.hooks);
  assert.deepEqual(s.env, userSettings.env);
  assert.equal(s.permissions!.defaultMode, 'default');
  const again = capture();
  assert.equal(await main(['hook', 'uninstall', '--cwd', project], again), 0);
  assert.match(again.lines[0]!, /^No Zephyr hooks/);
});

await test('hook install: keeps a non-bypass defaultMode; no settings file is fine; bad JSON creates no run', async () => {
  const merged = mergeObserved({ permissions: { defaultMode: 'acceptEdits' } }, {
    settings: { hooks: {} },
    env: {},
    hookUrl: '',
    otelEndpoint: '',
  });
  assert.equal(merged.permissions!.defaultMode, 'acceptEdits');
  assert.deepEqual(stripZephyr({}), {});

  const fresh = join(scratch, 'fresh');
  mkdirSync(fresh);
  const r = await installHook(new ApiClient({ base: apiBase }), { cwd: fresh });
  assert.equal(r.replaced, false);
  assert.ok(JSON.parse(readFileSync(settingsPath(fresh), 'utf8')).hooks.PreToolUse);

  const broken = join(scratch, 'broken');
  mkdirSync(join(broken, '.claude'), { recursive: true });
  writeFileSync(settingsPath(broken), '{ not json');
  seen.length = 0;
  const io = capture({ ZEPHYR_API: apiBase });
  assert.equal(await main(['hook', 'install', '--cwd', broken], io), 1);
  assert.match(io.errors[0]!, /not valid JSON/);
  assert.equal(seen.some((s) => s.url === '/api/observed/claudecode'), false, 'no run created for a bad file');
  assert.equal(readFileSync(settingsPath(broken), 'utf8'), '{ not json', 'bad file left alone');
});

/* -------------------------------------------------------------------------- */
/* Templates and summary                                                      */
/* -------------------------------------------------------------------------- */

await test('zephyr templates lists every template with its one-line explanation', async () => {
  const io = capture();
  assert.equal(await main(['templates'], io), 0);
  const out = io.lines.join('\n');
  for (const id of TASK_TEMPLATE_IDS) assert.match(out, new RegExp('^' + id + ' ', 'm'));
  assert.match(out, /concurrency 4, 20 turns, 150k tokens, auto-merges green tasks/);
});

const bundle = {
  id: 'ev_1',
  runId: 'run_task1',
  taskId: 'task_toggle',
  diff: { files: 3, insertions: 42, deletions: 7, hash: 'a'.repeat(40) },
  checkpoints: [{ turnId: 'turn_1', ref: 'refs/zephyr/cp/1', at: '2026-11-03T10:00:00.000Z' }],
  tests: {
    selected: [
      { id: 'web/toggle.test.ts', score: 0.9, fallback: false },
      { id: 'web/theme.test.ts', fallback: true },
    ],
    before: { passed: 10, failed: 1, skipped: 0 },
    after: { passed: 12, failed: 0, skipped: 0 },
    added: ['web/toggle.test.ts'],
    modified: [],
  },
  protectedPathApprovals: [],
  usage: { tokensIn: 9000, tokensOut: 1500, cacheReadTokens: 30000, cacheWriteTokens: 2000, costCents: 41, wallMs: 95_000 },
  egress: { calls: 0, destinations: [] },
  createdAt: '2026-11-03T10:05:00.000Z',
};

await test('zephyr summary: from a run id or a path, evidence only', async () => {
  const root = join(scratch, 'repo');
  const p = evidencePath('run_task1', root);
  assert.equal(p, join(root, '.data', 'evidence', 'run_task1', 'evidence.json'));
  assert.throws(() => evidencePath('../etc', root), /neither a run id/);

  const file = join(scratch, 'evidence.json');
  writeFileSync(file, JSON.stringify(bundle));
  const io = capture();
  assert.equal(await main(['summary', file], io), 0, io.errors.join('\n'));
  const out = io.lines.join('\n');
  assert.match(out, /^task_toggle: 3 files \+42\/−7, 12 tests green, 43k tokens, \$0\.410/);
  assert.match(out, /Tests before: 10 passed, 1 failed; after: 12 passed, 0 failed\./);
  assert.match(out, /Selected 2 tests \(1 by relevance score, 1 by fallback\)/);
  assert.match(out, /Network: no outbound calls\./);
  assert.ok(!/baseline/i.test(out), 'no baseline in the bundle, no saving claimed');

  writeFileSync(file, JSON.stringify({ ...bundle, diff: { ...bundle.diff, hash: 'nothex' } }));
  const bad = capture();
  assert.equal(await main(['summary', file], bad), 1);
  assert.match(bad.errors[0]!, /not an evidence bundle/);
  const missing = capture();
  assert.equal(await main(['summary', join(scratch, 'nope.json')], missing), 1);
  assert.match(missing.errors[0]!, /No evidence bundle/);
});

await test('help, unknown commands and usage', async () => {
  const io = capture();
  assert.equal(await main(['--help'], io), 0);
  assert.match(io.lines[0]!, /zephyr up/);
  assert.equal(await main([], capture()), 1);
  assert.equal(await main(['frobnicate'], capture()), 2);
  assert.equal(await main(['hook'], capture()), 2);
  assert.equal(await main(['summary'], capture()), 2);
});

await test('zephyr up --check reports and starts nothing', async () => {
  const io = capture();
  assert.equal(await main(['up', '--check', '--api', apiBase], io), 0);
  assert.match(io.lines.join('\n'), /Harnesses[\s\S]*Keys \(values are never shown\)/);
});

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed`);
