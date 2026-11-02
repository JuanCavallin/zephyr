/**
 * Step 5 check: token levers.
 *
 *   pnpm check:levers
 *
 * Offline. No harness, no model, no network.
 *
 * L1 shaped tools
 *   1. Parsers: JUnit, TAP and raw (vitest, pytest, go) fixtures; tsc diagnostics.
 *   2. Digest: a 10k-line raw log digests under the cap and keeps every failing id.
 *   3. Output store: the handle returns the full failure; unknown, expired,
 *      wrong-run and unknown-test lookups are distinct errors.
 *   4. runShaped on a real child process: failing run, timeout, runaway output,
 *      cancellation, bad filter, missing command.
 *   5. Gate: raw test/build/lint shell runs are denied only for offered kinds;
 *      shaped descriptors resolve to verify/auto; broker end to end.
 *
 * L2 context pack (over a fixture git repo built in a temp dir)
 *   6. Repo index: parsing, git and plain-directory listing, tree-hash
 *      invalidation, index cache.
 *   7. Candidates: path mention, symbols, imports, covering tests, co-change.
 *   8. Pack: Jev path and fallback path, one scorer request, cache hit skips
 *      Jev, every pick a control.decided event with its source, token cap.
 *   9. DecisionService.scoreFiles fallbacks; only the sanitized objective
 *      reaches a live Jev.
 *
 * L3 schema minimization
 *  10. Task classifier and native-tool policy: deterministic, fails towards more
 *      tools, never removes Read/Grep/Glob/Bash; one list feeds both the ACP
 *      session `_meta` and the settings deny rules.
 *  11. Stable tool set: a session replayed through the gateway (step 4 replay
 *      harness) carries byte-identical `tools` on every request; a mid-run
 *      change is flagged on `gateway.call`.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionAdapter, NativeToolRequest, ToolAction, ToolLifecycleEvent } from '@htn/shared';

const { parseTestOutput, runShaped } = await import('../src/core/tools/shaped/runTests.js');
const { parseDiagnostics } = await import('../src/core/tools/shaped/parsers/diagnostics.js');
const { buildTestDigest, DEFAULT_DIGEST_CAP_TOKENS } = await import('../src/core/tools/shaped/digest.js');
const { OutputStore } = await import('../src/core/tools/shaped/outputStore.js');
const { RunWorktrees } = await import('../src/core/tools/shaped/worktrees.js');
const { registerShapedTools, offeredShapedKinds, SHAPED_TOOL_IDS, SHAPED_HARNESS_NAMES } = await import(
  '../src/core/tools/shaped/index.js'
);
const { shapedToolFor } = await import('../src/core/tools/shellClassifier.js');
const { createPermissionBridge } = await import('../src/core/tools/permissionBridge.js');
const { baselineAuthorization, DecisionService } = await import('../src/core/decisions/service.js');
const { InMemoryToolRegistry } = await import('../src/core/tools/registry.js');
const { InMemoryToolExecutorRegistry } = await import('../src/core/tools/executors.js');
const { ToolBroker, ToolBrokerError } = await import('../src/core/tools/broker.js');
const { RunBus } = await import('../src/core/bus.js');
const { SessionStateService } = await import('../src/core/sessions/service.js');
const { createMemoryStore } = await import('../src/store/memory.js');
const { resolveLevers, DEFAULT_LEVERS } = await import('@htn/shared');

type ShellPlatform = import('../src/core/tools/pathContainment.js').ShellPlatform;
type Authorizer = import('../src/core/tools/permissionBridge.js').Authorizer;

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

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', 'levers', name), 'utf8');
const scratch = await mkdtemp(join(tmpdir(), 'zephyr-levers-check-'));
const worktree = join(scratch, 'wt');
await mkdir(worktree, { recursive: true });

/** A fake test runner: argv[2] picks the behaviour, argv[3] is the filter. */
const runner = join(scratch, 'runner.mjs');
await writeFile(
  runner,
  `const [mode, filter] = process.argv.slice(2);
if (mode === 'fail') {
  console.log(' ✓ src/a.test.ts > a > works 1ms');
  console.log(' × src/a.test.ts > a > breaks 2ms');
  console.log('');
  console.log(' FAIL  src/a.test.ts > a > breaks');
  console.log('AssertionError: expected 1 to be 2');
  console.log(' ❯ src/a.test.ts:9:13');
  console.log('');
  console.log('      Tests  1 failed | 1 passed (2)');
  if (filter) console.log('filter=' + filter);
  process.exit(1);
}
if (mode === 'pass') { console.log('      Tests  3 passed (3)'); process.exit(0); }
if (mode === 'hang') { console.log(' ✓ first 1ms'); setTimeout(() => {}, 60_000); }
if (mode === 'flood') { const line = 'x'.repeat(1000) + '\\n'; const go = () => { while (process.stdout.write(line)); process.stdout.once('drain', go); }; go(); }
if (mode === 'tsc') {
  console.log("src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  console.log("src/b.ts(3,10): warning TS6133: 'x' is declared but its value is never read.");
  process.exit(2);
}
`,
  'utf8',
);
const node = process.execPath;
const override = (mode: string) => [node, runner, mode, '{filter}'];

/* -------------------------------- 1. parsers -------------------------------- */

console.log('parsers');
await test('JUnit: counts, ids with suite path, assertion from the failure message', () => {
  const p = parseTestOutput('', fixture('junit.xml'));
  assert.equal(p.format, 'junit');
  assert.deepEqual([p.total, p.passed, p.failed, p.skipped], [5, 2, 2, 1]);
  assert.deepEqual(
    p.failures.map((f) => f.id),
    ['src/cart.test.ts > cart > totals with tax', 'src/cart.test.ts > cart > applies coupon'],
  );
  assert.equal(p.failures[0]!.assertion, 'expected 10.8 to be 10.85');
  assert.match(p.failures[1]!.trace, /applyCoupon src\/cart\.ts:40:18/);
});
await test('JUnit printed to stdout is found too', () => {
  const p = parseTestOutput('some preamble\n' + fixture('junit.xml'));
  assert.equal(p.format, 'junit');
  assert.equal(p.failed, 2);
});
await test('TAP: nested subtests, YAML diagnostics, SKIP', () => {
  const p = parseTestOutput(fixture('tap.txt'));
  assert.equal(p.format, 'tap');
  assert.deepEqual([p.passed, p.failed, p.skipped], [2, 1, 1]);
  assert.deepEqual(
    p.failures.map((f) => f.id),
    ['parser > parses dates'],
  );
  assert.equal(p.failures[0]!.assertion, 'Expected values to be strictly equal');
});
await test('raw vitest: one id per failing case, assertion from the FAIL section', () => {
  const p = parseTestOutput(fixture('vitest.txt'));
  assert.equal(p.format, 'raw');
  assert.deepEqual([p.total, p.passed, p.failed], [3, 2, 1]);
  assert.deepEqual(
    p.failures.map((f) => f.id),
    ['src/math.test.ts > math > divides by zero'],
  );
  assert.match(p.failures[0]!.assertion, /AssertionError: expected \[Function\] to throw/);
  assert.match(p.failures[0]!.trace, /src\/math\.test\.ts:14:22/);
  assert.doesNotMatch(p.failures[0]!.trace, /Test Files/, 'trace stops at the rule line');
});
await test('raw pytest: node ids, E-line assertions, summary counts', () => {
  const p = parseTestOutput(fixture('pytest.txt'));
  assert.deepEqual([p.total, p.passed, p.failed], [4, 2, 2]);
  assert.deepEqual(
    p.failures.map((f) => [f.id, f.assertion]),
    [
      ['tests/test_api.py::test_create_user', 'assert 400 == 201'],
      ['tests/test_api.py::test_delete_user', 'AssertionError: user 7 not found'],
    ],
  );
  assert.match(p.failures[0]!.trace, /tests\/test_api\.py:12: AssertionError/);
});
await test('raw go: the package FAIL line is not a test; log lines become the trace', () => {
  const p = parseTestOutput(fixture('go.txt'));
  assert.deepEqual([p.total, p.passed, p.failed], [3, 2, 1]);
  assert.deepEqual(
    p.failures.map((f) => f.id),
    ['TestRoundTrip'],
  );
  assert.match(p.failures[0]!.assertion, /expected "a,b" got "a;b"/);
});
await test('output with no test lines never claims a pass', () => {
  const p = parseTestOutput('segmentation fault (core dumped)\n');
  assert.equal(p.total, 0);
  assert.equal(p.passed, 0);
});
await test('tsc diagnostics: file, line, column, code', () => {
  const { diagnostics } = parseDiagnostics(fixture('tsc.txt'));
  assert.deepEqual(
    diagnostics.map((d) => [d.id, d.severity]),
    [
      ['src/a.ts:12:5 TS2322', 'error'],
      ['src/b.ts:3:10 TS2304', 'error'],
    ],
  );
});

/* -------------------------------- 2. digest --------------------------------- */

console.log('digest');
const facts = { command: 'vitest run', exitCode: 1, timedOut: false, truncated: false, durationMs: 1 };
await test('a 10k-line log digests under the cap and keeps every failing id', () => {
  const lines: string[] = [];
  const failing: string[] = [];
  for (let i = 0; i < 10_000; i++) lines.push(` ✓ src/big.test.ts > suite ${i % 40} > case ${i} 1ms`);
  for (let i = 0; i < 60; i++) {
    const id = `src/big.test.ts > suite ${i} > fails ${i}`;
    failing.push(id);
    lines.push(` × ${id} 4ms`);
  }
  lines.push('');
  for (const id of failing) {
    lines.push(` FAIL  ${id}`, `AssertionError: expected ${id.length} to be 0`);
    for (let j = 0; j < 30; j++) lines.push(`    at frame${j} (node_modules/vitest/dist/chunk-${j}.js:${j}:1)`);
    lines.push('⎯⎯⎯⎯⎯⎯');
  }
  lines.push('      Tests  60 failed | 10000 passed (10060)');
  const raw = lines.join('\n');
  const parsed = parseTestOutput(raw);
  assert.equal(parsed.failures.length, 60);
  const { digest, text } = buildTestDigest({ parsed, raw, handle: 'out_test_x', facts });
  assert.ok(digest.rawTokens > 100_000, 'raw is large: ' + digest.rawTokens);
  assert.ok(digest.digestTokens <= DEFAULT_DIGEST_CAP_TOKENS, 'digest ' + digest.digestTokens + ' tokens');
  assert.equal(digest.failed, 60);
  assert.equal(digest.passed, 10_000);
  for (const id of failing) assert.ok(text.includes(id), 'digest keeps ' + id);
  assert.ok(text.includes('out_test_x'), 'digest carries the handle');
});
await test('a small run keeps assertion and trace', () => {
  const parsed = parseTestOutput(fixture('vitest.txt'));
  const { digest } = buildTestDigest({ parsed, raw: fixture('vitest.txt'), handle: 'h', facts });
  assert.match(digest.failures[0]!.assertion, /AssertionError/);
  assert.match(digest.failures[0]!.trace, /14:22/);
});

/* ------------------------------ 3. output store ----------------------------- */

console.log('output store');
await test('handle → full failure, raw pages, and distinct errors', () => {
  let clock = 1_000;
  const store = new OutputStore({ ttlMs: 10_000, pageChars: 10, now: () => clock });
  const full = 'AssertionError: boom\n' + 'frame\n'.repeat(200);
  const handle = store.put({
    runId: 'run_a',
    kind: 'test',
    command: 'vitest',
    raw: 'abcdefghijklmnopqrstuvwxyz',
    details: new Map([['src/a.test.ts > a > breaks', full]]),
  });
  assert.match(handle, /^out_test_[0-9a-f]{12}$/);

  const one = store.get(handle, 'run_a', 'src/a.test.ts > a > breaks');
  assert.ok(one.ok);
  assert.equal(one.text, full, 'full detail, untrimmed');
  const sub = store.get(handle, 'run_a', 'BREAKS');
  assert.ok(sub.ok, 'unique case-insensitive substring');

  const page = store.get(handle, 'run_a');
  assert.ok(page.ok);
  assert.equal(page.text, 'abcdefghij');
  assert.equal(page.nextOffset, 10);
  const page2 = store.get(handle, 'run_a', undefined, 20);
  assert.ok(page2.ok);
  assert.equal(page2.text, 'uvwxyz');
  assert.equal(page2.nextOffset, undefined);

  const codes = [
    store.get('out_test_000000000000', 'run_a'),
    store.get(handle, 'run_b'),
    store.get(handle, 'run_a', 'no such test'),
  ].map((r) => (r.ok ? 'ok' : r.code));
  assert.deepEqual(codes, ['UNKNOWN_HANDLE', 'WRONG_RUN', 'UNKNOWN_TEST']);

  clock += 10_001;
  const expired = store.get(handle, 'run_a');
  assert.equal(expired.ok ? 'ok' : expired.code, 'EXPIRED_HANDLE');
  for (const r of [...codes.map(() => expired)]) if (!r.ok) assert.ok(r.message.length > 10);
});
await test('the store is bounded: oldest handles are evicted', () => {
  const store = new OutputStore({ maxEntries: 2 });
  const put = () => store.put({ runId: 'r', kind: 'build', command: 'tsc', raw: 'x', details: new Map() });
  const first = put();
  put();
  put();
  const r = store.get(first, 'r');
  assert.equal(r.ok, false);
  if (!r.ok) assert.notEqual(r.code, 'WRONG_RUN');
});

/* -------------------------------- 4. runShaped ------------------------------ */

console.log('runShaped');
await test('a failing run: digest, handle, exit code', async () => {
  const store = new OutputStore();
  const r = await runShaped('test', { runId: 'run_1', worktree }, { store, overrides: { test: override('fail') } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.line, /^test output digested: \d+ → \d+ tokens$/);
  assert.equal(r.facts.exitCode, 1);
  assert.equal(r.facts.timedOut, false);
  assert.ok('failures' in r.digest);
  assert.deepEqual(
    r.digest.failures.map((f) => f.id),
    ['src/a.test.ts > a > breaks'],
  );
  const full = store.get(r.digest.handle, 'run_1', 'src/a.test.ts > a > breaks');
  assert.ok(full.ok);
  assert.match(full.text, /expected 1 to be 2/);
});
await test('the filter reaches the command', async () => {
  const store = new OutputStore();
  const r = await runShaped(
    'test',
    { runId: 'run_1', worktree, filter: 'src/a.test.ts' },
    { store, overrides: { test: override('fail') } },
  );
  assert.ok(r.ok);
  const raw = store.get(r.digest.handle, 'run_1');
  assert.ok(raw.ok);
  assert.ok(raw.text.includes('filter=src/a.test.ts'), raw.text);
});
await test('timeout kills the run and says the results are partial', async () => {
  const r = await runShaped(
    'test',
    { runId: 'run_1', worktree },
    { store: new OutputStore(), timeoutMs: 700, overrides: { test: override('hang') } },
  );
  assert.ok(r.ok);
  assert.equal(r.facts.timedOut, true);
  assert.match(r.text, /killed after \d+s; results are partial/);
});
await test('runaway output is killed and truncated', async () => {
  const r = await runShaped(
    'test',
    { runId: 'run_1', worktree },
    {
      store: new OutputStore(),
      maxOutputBytes: 20_000,
      killAfterBytes: 200_000,
      timeoutMs: 20_000,
      overrides: { test: override('flood') },
    },
  );
  assert.ok(r.ok);
  assert.equal(r.facts.truncated, true);
  assert.equal(r.facts.timedOut, false);
  assert.match(r.text, /too much output; results are partial/);
  assert.ok(r.digest.digestTokens <= DEFAULT_DIGEST_CAP_TOKENS);
});
await test('cancellation stops the run', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const r = await runShaped(
    'test',
    { runId: 'run_1', worktree, signal: ac.signal },
    { store: new OutputStore(), timeoutMs: 20_000, overrides: { test: override('hang') } },
  );
  assert.ok(r.ok);
  assert.match(r.text, /cancelled; results are partial/);
});
await test('a hostile filter is refused before anything runs', async () => {
  for (const filter of ['a > out.txt', 'a; rm -rf /', '$(whoami)', '--reporter=evil', 'a|b', 'a`b`']) {
    const r = await runShaped(
      'test',
      { runId: 'run_1', worktree, filter },
      { store: new OutputStore(), overrides: { test: override('fail') } },
    );
    assert.equal(r.ok, false, filter);
    if (!r.ok) assert.equal(r.code, 'BAD_FILTER', filter);
  }
});
await test('no recognisable project → NO_COMMAND, not a guess', async () => {
  const r = await runShaped('test', { runId: 'run_1', worktree }, { store: new OutputStore() });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'NO_COMMAND');
});
await test('build diagnostics: errors first, ok=false on a non-zero exit', async () => {
  const r = await runShaped('build', { runId: 'run_1', worktree }, { store: new OutputStore(), overrides: { build: override('tsc') } });
  assert.ok(r.ok);
  assert.match(r.line, /^build output digested/);
  assert.ok('diagnostics' in r.digest);
  assert.equal(r.digest.ok, false);
  assert.equal(r.digest.errors, 1);
  assert.equal(r.digest.warnings, 1);
  assert.equal(r.digest.diagnostics[0]!.id, 'src/a.ts:12:5 TS2322');
});

/* ---------------------------------- 5. gate --------------------------------- */

console.log('gate');
const shapedRows: [string, ShellPlatform, 'test' | 'build' | 'lint' | null][] = [
  ['pnpm test', 'posix', 'test'],
  ['npm test', 'posix', 'test'],
  ['npm run test -- --run', 'posix', 'test'],
  ['yarn test', 'posix', 'test'],
  ['pnpm vitest run', 'posix', 'test'],
  ['npx jest src', 'posix', 'test'],
  ['pnpm exec vitest run', 'posix', 'test'],
  ['npx -y mocha', 'posix', 'test'],
  ['npx prettier --check .', 'posix', null],
  ['pytest -q', 'posix', 'test'],
  ['python -m pytest tests', 'posix', 'test'],
  ['go test ./...', 'posix', 'test'],
  ['cargo test', 'posix', 'test'],
  ['pnpm build', 'posix', 'build'],
  ['pnpm run typecheck', 'posix', 'build'],
  ['npx tsc --noEmit', 'posix', 'build'],
  ['cargo check', 'posix', 'build'],
  ['go build ./...', 'posix', 'build'],
  ['pnpm lint', 'posix', 'lint'],
  ['npx eslint .', 'posix', 'lint'],
  ['ruff check .', 'posix', 'lint'],
  ['cargo clippy', 'posix', 'lint'],
  ['pnpm test 2>&1 | tail -50', 'posix', 'test'],
  ['ls', 'posix', null],
  ['git status', 'posix', null],
  ['cat test.ts', 'posix', null],
  ['pnpm install', 'posix', null],
  ['echo test', 'posix', null],
  ['pnpm test', 'win32', 'test'],
];
await test(`${shapedRows.length} shapedToolFor rows`, () => {
  for (const [cmd, platform, kind] of shapedRows) {
    assert.equal(shapedToolFor(cmd, platform), kind, `${cmd} (${platform})`);
  }
});
await test('offeredShapedKinds reads the exposed tool ids', () => {
  assert.deepEqual(offeredShapedKinds(undefined), []);
  assert.deepEqual(offeredShapedKinds(['fs.read']), []);
  assert.deepEqual(offeredShapedKinds([SHAPED_TOOL_IDS.test, SHAPED_TOOL_IDS.lint, 'fs.read']), ['test', 'lint']);
});
await test('levers default on; partials resolve against the defaults', () => {
  assert.deepEqual(resolveLevers(undefined), { shapedTools: true, contextPack: true, schemaMin: true });
  assert.deepEqual(resolveLevers({ shapedTools: false }), { shapedTools: false, contextPack: true, schemaMin: true });
  assert.ok(Object.isFrozen(DEFAULT_LEVERS));
});

const allowAll: Authorizer = (d, a) => baselineAuthorization(d, a, new Date().toISOString());
const req = (toolName: string, rawInput: unknown): NativeToolRequest => ({
  harness: 'claudecode',
  toolName,
  rawInput,
  sessionId: 'sess-levers',
});
await test('raw pnpm test is denied with a pointer to the shaped tool when offered', async () => {
  const events: ToolLifecycleEvent[] = [];
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree,
    platform: 'posix',
    authorize: allowAll,
    shapedTools: ['test'],
    run: { runId: 'run_gate', stepId: 'step_gate', sessionStateId: 'ss_gate' },
    onLifecycle: (e) => {
      events.push(e);
    },
  });
  const d = await bridge.decide(req('Bash', { command: 'pnpm test' }));
  assert.equal(d.verdict, 'deny');
  assert.equal(d.policy, 'deny');
  assert.match(d.reason, /use-shaped-tool/);
  assert.ok(d.reason.includes(SHAPED_HARNESS_NAMES.test), d.reason);
  const blocked = events.find((e) => e.phase === 'blocked');
  assert.ok(blocked, 'a blocked lifecycle event');
  assert.match(blocked.error?.message ?? '', /use-shaped-tool/);
});
await test('raw runs stay ordinary when the kind is not offered or the lever is off', async () => {
  const cases: [readonly ('test' | 'build' | 'lint')[] | undefined, string][] = [
    [undefined, 'pnpm test'],
    [['build'], 'pnpm test'],
    [['test'], 'pnpm lint'],
    [['test'], 'ls'],
  ];
  for (const [shapedTools, command] of cases) {
    const bridge = createPermissionBridge({
      harness: 'claudecode',
      worktree,
      platform: 'posix',
      authorize: allowAll,
      ...(shapedTools ? { shapedTools } : {}),
    });
    const d = await bridge.preview(req('Bash', { command }));
    assert.doesNotMatch(d.reason, /use-shaped-tool/, `${command} with ${JSON.stringify(shapedTools)}`);
    assert.notEqual(d.policy, 'deny', `${command} with ${JSON.stringify(shapedTools)}: ${d.reason}`);
  }
});

const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
const worktrees = new RunWorktrees();
const toolStore = new OutputStore();
registerShapedTools(registry, executors, {
  store: toolStore,
  worktrees,
  overrides: { test: override('fail'), build: override('tsc'), lint: override('pass') },
});

await test('shaped descriptors: runners verify, test_output auto', async () => {
  const action = (toolId: string): ToolAction => ({
    id: 'act_x',
    runId: 'run_x',
    stepId: 'step_x',
    toolId,
    descriptorVersion: '1',
    operation: 'run',
    arguments: {},
    destination: 'local://zephyr/worktree',
    dataLabels: ['private'],
    createdAt: new Date().toISOString(),
  });
  for (const [id, policy] of [
    [SHAPED_TOOL_IDS.test, 'verify'],
    [SHAPED_TOOL_IDS.build, 'verify'],
    [SHAPED_TOOL_IDS.lint, 'verify'],
    [SHAPED_TOOL_IDS.output, 'auto'],
  ] as const) {
    const registered = await registry.get(id);
    assert.ok(registered, id + ' is registered');
    assert.equal(registered.descriptor.transport, 'local');
    const auth = baselineAuthorization(registered.descriptor, action(id), new Date().toISOString());
    assert.equal(auth.finalPolicy, policy, id);
  }
});

const memory = createMemoryStore();
const bus = new RunBus((runId, event) => memory.appendEvent(runId, event));
const sessions = new SessionStateService(memory, bus);
const decisionAdapter = {
  id: 'jev',
  mode: 'mock',
  capabilities: ['decision'],
  async recommendActionPolicy() {
    return {
      ok: true,
      data: { policy: 'auto', confidence: 0.99, probabilities: { auto: 0.99 }, reasonCodes: ['check-auto'] },
      meta: { provider: 'jev', op: 'recommendActionPolicy', mode: 'mock', latencyMs: 0, destination: 'mock://jev' },
    } as const;
  },
} as unknown as DecisionAdapter;
const broker = new ToolBroker(registry, executors, new DecisionService(decisionAdapter), sessions, bus, {});

async function shapedSession(runId: string) {
  const state = await sessions.create({
    runId,
    stepId: runId + '_step',
    harness: 'claudecode',
    objective: 'Fix the failing test.',
    sanitizedObjective: 'Fix the failing test.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 10 },
  });
  await sessions.beginTurn(state.id);
  await sessions.grantToolExposure(state.id, {
    modelCallId: 'call_' + runId,
    selectedToolVersions: Object.fromEntries(Object.values(SHAPED_TOOL_IDS).map((id) => [id, '1'])),
  });
  return state;
}

await test('through the broker: a run with no worktree fails closed', async () => {
  const session = await shapedSession('run_noworktree');
  await assert.rejects(
    broker.execute({ sessionStateId: session.id, toolId: SHAPED_TOOL_IDS.test, arguments: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ToolBrokerError);
      assert.equal(error.code, 'TOOL_EXECUTION_FAILED');
      assert.match(error.message, /NO_WORKTREE/);
      return true;
    },
  );
});
await test('through the broker: run_tests digests, test_output expands the handle', async () => {
  const session = await shapedSession('run_shaped');
  worktrees.bind('run_shaped', worktree);
  try {
    const result = await broker.execute({ sessionStateId: session.id, toolId: SHAPED_TOOL_IDS.test, arguments: {} });
    assert.equal(result.authorization.finalPolicy, 'verify');
    assert.equal(result.verified, true);
    assert.match(result.summary, /^test output digested: \d+ → \d+ tokens/);
    assert.ok(result.summary.includes('src/a.test.ts > a > breaks'));
    const handle = /out_test_[0-9a-f]{12}/.exec(result.summary)?.[0];
    assert.ok(handle, 'summary carries the handle');

    const detail = await broker.execute({
      sessionStateId: session.id,
      toolId: SHAPED_TOOL_IDS.output,
      arguments: { handle, testId: 'a > breaks' },
    });
    assert.equal(detail.authorization.finalPolicy, 'auto');
    assert.match(detail.summary, /expected 1 to be 2/);

    await assert.rejects(
      broker.execute({ sessionStateId: session.id, toolId: SHAPED_TOOL_IDS.output, arguments: { handle: 'out_test_ffffffffffff' } }),
      /UNKNOWN_HANDLE/,
    );

    const phases = (await memory.eventsSince('run_shaped', 0)).flatMap((s) =>
      s.event.type === 'tool.lifecycle' && s.event.lifecycle.action.toolId === SHAPED_TOOL_IDS.test
        ? [s.event.lifecycle.phase]
        : [],
    );
    assert.deepEqual(phases, ['proposed', 'policy_decided', 'executing', 'succeeded']);
  } finally {
    worktrees.unbind('run_shaped', worktree);
  }
  assert.equal(worktrees.resolve('run_shaped'), undefined);
});
await test('a handle from another run is refused', async () => {
  const a = await shapedSession('run_owner');
  const b = await shapedSession('run_other');
  worktrees.bind('run_owner', worktree);
  try {
    const result = await broker.execute({ sessionStateId: a.id, toolId: SHAPED_TOOL_IDS.build, arguments: {} });
    const handle = /out_build_[0-9a-f]{12}/.exec(result.summary)?.[0];
    assert.ok(handle);
    await assert.rejects(
      broker.execute({ sessionStateId: b.id, toolId: SHAPED_TOOL_IDS.output, arguments: { handle } }),
      /WRONG_RUN/,
    );
  } finally {
    worktrees.unbind('run_owner');
  }
});

/* -------------------------------------------------------------------------- */
/* L2: Jev-ranked context pack                                                  */
/* -------------------------------------------------------------------------- */

console.log('\nL2 context pack');

const { buildRepoIndex, parseSource, treeHash, isTestPath } = await import('../src/core/context/repoIndex.js');
const { selectCandidates, splitWords, taskTerms } = await import('../src/core/context/candidates.js');
const { buildContextPack, estimateTokens } = await import('../src/core/context/pack.js');
const { createContextPackBuilder, goalWithContextPack } = await import('../src/core/context/index.js');
const { create: createJev } = await import('../src/providers/jev/index.js');
const { execFileSync } = await import('node:child_process');
type RunEventL2 = import('@htn/shared').RunEvent;
type ControlDecisionRecordL2 = import('@htn/shared').ControlDecisionRecord;
type AgentSessionStateL2 = import('@htn/shared').AgentSessionState;
type FileScorer = import('../src/core/context/pack.js').FileScorer;
type ProviderConfigL2 = import('../src/config.js').ProviderConfig;

const repoDir = join(scratch, 'repo');
await mkdir(repoDir, { recursive: true });
const gitIn = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=check@zephyr.local', '-c', 'user.name=check', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(repoDir, path)), { recursive: true });
  await writeFile(join(repoDir, path), text, 'utf8');
}

await put(
  'src/auth/session.ts',
  `/** Session lifecycle: refresh and expiry for signed-in users. */
import { signToken } from './tokens.js';
export function refreshSession(id: string) { return signToken(id); }
export const SESSION_TTL_MS = 3600_000;
`,
);
await put('src/auth/tokens.ts', `/** Token signing. */\nexport function signToken(subject: string) { return 'tok_' + subject; }\n`);
await put('src/auth/session.test.ts', `import { refreshSession } from './session.js';\nrefreshSession('a');\n`);
await put('src/auth/audit.ts', `export function auditLog(event: string) { return event; }\n`);
await put('src/billing/invoice.ts', `/** Invoices and line items. */\nexport class Invoice { total = 0; }\n`);
await put('src/util/format.ts', `export function formatMoney(cents: number) { return (cents / 100).toFixed(2); }\n`);
await put('tools/report.py', `"""Monthly report generation."""\nfrom .helpers import load\ndef build_report():\n    return load()\n`);
await put('tools/helpers.py', `def load():\n    return []\n`);
await put('README.md', '# fixture\n');
gitIn('init', '-q');
gitIn('add', '-A');
gitIn('commit', '-q', '-m', 'initial');
await put('src/auth/session.ts', readFileSync(join(repoDir, 'src/auth/session.ts'), 'utf8') + '// grace window\n');
await put('src/auth/audit.ts', `export function auditLog(event: string) { return 'audit:' + event; }\n`);
gitIn('add', '-A');
gitIn('commit', '-q', '-m', 'session audit');

const TASK = 'Fix refreshSession so an expired session in src/auth/session.ts is renewed';

await test('parseSource: TS exports, symbols, imports and doc; Python defs and relative imports', () => {
  const ts = parseSource(
    'a.ts',
    `/** Does a thing. */\nimport x from './x.js';\nexport async function go() {}\nexport { a as b, c };\nconst local = 1;\nexport interface Shape {}\n`,
  );
  assert.deepEqual([...ts.exports].sort(), ['Shape', 'b', 'c', 'go']);
  assert.ok(ts.symbols.includes('local'));
  assert.deepEqual(ts.imports, ['./x.js']);
  assert.equal(ts.doc, 'Does a thing.');
  const py = parseSource('m.py', `"""Docs here."""\nfrom .h import f\nimport os\ndef run():\n  pass\ndef _private():\n  pass\n`);
  assert.deepEqual(py.exports, ['run']);
  assert.deepEqual([...py.imports].sort(), ['.h', 'os']);
  assert.equal(py.doc, 'Docs here.');
  assert.ok(isTestPath('src/a.test.ts') && isTestPath('tests/test_x.py') && isTestPath('pkg/x_test.go'));
  assert.ok(!isTestPath('src/testing.ts'));
});

await test('task terms: paths, identifiers and camelCase words without stopwords', () => {
  const terms = taskTerms(TASK);
  assert.deepEqual(terms.paths, ['src/auth/session.ts']);
  assert.ok(terms.identifiers.has('refreshSession'));
  assert.deepEqual(splitWords('parseHTTPRequest_v2'), ['parse', 'http', 'request', 'v2']);
  assert.ok(!terms.words.has('the') && !terms.words.has('so'));
});

await test('repo index: git listing, non-source skipped, cached until the tree changes', async () => {
  const a = await buildRepoIndex(repoDir);
  assert.equal(a.git, true);
  assert.ok(a.files.some((f) => f.path === 'src/auth/session.ts'));
  assert.ok(!a.files.some((f) => f.path === 'README.md'));
  assert.strictEqual(await buildRepoIndex(repoDir), a, 'unchanged tree reuses the index');
  await put('src/util/format.ts', 'export function formatMoney() { return "edited"; }\n');
  const b = await buildRepoIndex(repoDir);
  assert.notEqual(b.treeHash, a.treeHash, 'an uncommitted edit changes the tree hash');
  gitIn('checkout', '--', 'src/util/format.ts');
  assert.equal(await treeHash(repoDir), a.treeHash, 'reverting restores the hash');
});

await test('repo index without git: filesystem walk, hash tracks edits', async () => {
  const plain = join(scratch, 'plain');
  await mkdir(join(plain, 'lib'), { recursive: true });
  await mkdir(join(plain, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(plain, 'lib', 'one.ts'), 'export const one = 1;\n');
  await writeFile(join(plain, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  const index = await buildRepoIndex(plain);
  assert.equal(index.git, false);
  assert.deepEqual(
    index.files.map((f) => f.path),
    ['lib/one.ts'],
  );
  const before = index.treeHash;
  await writeFile(join(plain, 'lib', 'one.ts'), 'export const one = 11;\n');
  assert.notEqual(await treeHash(plain), before);
});

await test('candidates: path mention first, then imports, covering test, co-change; unrelated excluded', async () => {
  const repo = await buildRepoIndex(repoDir);
  const candidates = await selectCandidates(TASK, repo);
  const paths = candidates.map((c) => c.path);
  assert.equal(paths[0], 'src/auth/session.ts');
  assert.ok(candidates[0]!.reasons.includes('path-mention'));
  assert.equal(candidates[0]!.score, 1);
  const reasonsOf = (p: string) => candidates.find((c) => c.path === p)?.reasons ?? [];
  assert.ok(reasonsOf('src/auth/tokens.ts').some((r) => r.startsWith('imported-by:')));
  assert.ok(reasonsOf('src/auth/session.test.ts').includes('covering-test'));
  assert.ok(reasonsOf('src/auth/audit.ts').includes('co-changed'));
  assert.ok(!paths.includes('src/billing/invoice.ts'));
  assert.ok(!paths.includes('tools/report.py'));
  assert.deepEqual(await selectCandidates(TASK, repo), candidates, 'deterministic');
  const raws = candidates.map((c) => c.raw);
  assert.deepEqual(raws, [...raws].sort((x, y) => y - x), 'ranked by score');
});

await test('candidates: Python relative imports widen from a seed; the cap holds', async () => {
  const repo = await buildRepoIndex(repoDir);
  const candidates = await selectCandidates('build_report output is empty', repo);
  assert.equal(candidates[0]?.path, 'tools/report.py');
  assert.ok(candidates.some((c) => c.path === 'tools/helpers.py' && c.reasons.some((r) => r.startsWith('imported-by:'))));
  assert.ok((await selectCandidates(TASK, repo, 2)).length <= 2);
  assert.deepEqual(await selectCandidates('zzz qqq', repo), [], 'no signal, no candidates');
});

function recorder() {
  const events: ControlDecisionRecordL2[] = [];
  return {
    events,
    emit: (_runId: string, event: RunEventL2) => {
      if (event.type === 'control.decided') events.push(event.decision);
    },
  };
}

await test('pack fallback: no scorer -> deterministic rank, every pick a fallback decision event', async () => {
  const repo = await buildRepoIndex(repoDir);
  const rec = recorder();
  const pack = await buildContextPack(TASK, repo, {
    topK: 3,
    run: { runId: 'run_l2', stepId: 'stp_1' },
    emit: rec.emit,
    cache: new Map(),
  });
  assert.equal(pack.source, 'fallback');
  assert.equal(pack.files[0]!.path, 'src/auth/session.ts');
  assert.equal(pack.files.length, 3);
  assert.ok(pack.reasonCodes.includes('deterministic-rank-fallback'));
  assert.equal(rec.events.length, 3);
  for (const e of rec.events) {
    assert.equal(e.operation, 'select_context_files');
    assert.equal(e.source, 'fallback');
    assert.equal(e.runId, 'run_l2');
    assert.equal(e.stepId, 'stp_1');
    assert.equal(e.selectedIds.length, 1);
    assert.ok(e.candidateIds.includes(e.selectedIds[0]!));
  }
});

await test('pack via Jev: one scorer call for all candidates, Jev order wins, unrelated dropped', async () => {
  const repo = await buildRepoIndex(repoDir);
  const rec = recorder();
  const calls: Parameters<FileScorer>[0][] = [];
  const scorer: FileScorer = async (input) => {
    calls.push(input);
    return {
      scores: Object.fromEntries(
        input.files.map((f) => [f.path, f.path === 'src/auth/tokens.ts' ? 1 : f.path === 'src/auth/session.ts' ? 0.66 : 0]),
      ),
      reasonCodes: ['jev-file-relevance'],
    };
  };
  const pack = await buildContextPack(TASK, repo, { scorer, run: { runId: 'run_l2' }, emit: rec.emit, cache: new Map() });
  assert.equal(calls.length, 1, 'a single request');
  assert.ok(calls[0]!.files.length > 2);
  assert.ok(calls[0]!.files.some((f) => f.summary.includes('refreshSession')), 'summaries carry exports');
  assert.ok(!calls[0]!.files.some((f) => f.summary.includes("'tok_'")), 'never file contents');
  assert.equal(pack.source, 'jev');
  assert.deepEqual(
    pack.files.map((f) => f.path),
    ['src/auth/tokens.ts', 'src/auth/session.ts'],
  );
  assert.equal(rec.events.length, 2);
  assert.ok(rec.events.every((e) => e.source === 'jev'));
  assert.equal(rec.events[0]!.confidence, 1);
});

await test('pack cache: same task and tree skip Jev; a fallback is not cached', async () => {
  const repo = await buildRepoIndex(repoDir);
  const cache = new Map();
  let calls = 0;
  const scorer: FileScorer = async (input) => {
    calls++;
    return {
      scores: Object.fromEntries(input.files.map((f, i) => [f.path, i === 0 ? 1 : 0.5])),
      reasonCodes: ['jev-file-relevance'],
    };
  };
  const first = await buildContextPack(TASK, repo, { scorer, cache });
  const rec = recorder();
  const second = await buildContextPack(TASK, repo, { scorer, cache, run: { runId: 'run_cache' }, emit: rec.emit });
  assert.equal(calls, 1, 'the cache hit made no scorer call');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.prompt, first.prompt);
  assert.ok(rec.events.length > 0);
  assert.ok(rec.events.every((e) => e.source === 'jev' && e.reasonCodes.includes('context-pack-cache-hit')));
  await buildContextPack('a different task about refreshSession', repo, { scorer, cache });
  assert.equal(calls, 2, 'a different task misses');

  let nullCalls = 0;
  const unavailable: FileScorer = async () => {
    nullCalls++;
    return { scores: null, reasonCodes: ['remote-jev-ineligible', 'deterministic-rank-fallback'] };
  };
  const fallbackCache = new Map();
  await buildContextPack(TASK, repo, { scorer: unavailable, cache: fallbackCache });
  const again = await buildContextPack(TASK, repo, { scorer: unavailable, cache: fallbackCache });
  assert.equal(nullCalls, 2);
  assert.equal(again.cached, false);
  assert.equal(again.source, 'fallback');
  assert.deepEqual(again.reasonCodes, ['remote-jev-ineligible', 'deterministic-rank-fallback']);
});

await test('pack: a throwing scorer degrades to the deterministic rank', async () => {
  const repo = await buildRepoIndex(repoDir);
  const pack = await buildContextPack(TASK, repo, {
    scorer: async () => {
      throw new Error('gateway down');
    },
    cache: new Map(),
  });
  assert.equal(pack.source, 'fallback');
  assert.equal(pack.files[0]!.path, 'src/auth/session.ts');
  assert.ok(pack.reasonCodes.some((c) => c.startsWith('context-scorer-threw:gateway down')));
});

await test('pack prompt: map plus full text of the top files, always under the token cap', async () => {
  const repo = await buildRepoIndex(repoDir);
  const roomy = await buildContextPack(TASK, repo, { cache: new Map() });
  assert.match(roomy.prompt, /^Repository context/);
  assert.ok(roomy.prompt.includes('- src/auth/session.ts — Session lifecycle'));
  assert.ok(roomy.prompt.includes('--- src/auth/session.ts ---\n/** Session lifecycle'), 'top file inlined');
  assert.equal(roomy.tokens, estimateTokens(roomy.prompt));
  assert.ok((roomy.prompt.match(/^--- /gm) ?? []).length <= 3, 'at most three files inlined');
  for (const cap of [40, 80, 160]) {
    const tight = await buildContextPack(TASK, repo, { tokenCap: cap, cache: new Map() });
    assert.ok(tight.tokens <= cap, `prompt ${tight.tokens} tokens under cap ${cap}`);
  }
  const mapOnly = await buildContextPack(TASK, repo, { tokenCap: 80, cache: new Map() });
  assert.ok(!mapOnly.prompt.includes('\n--- '), 'no file fits, none inlined, none truncated');
  const empty = await buildContextPack('zzz qqq', repo, { cache: new Map() });
  assert.equal(empty.prompt, '');
  assert.deepEqual(empty.reasonCodes, ['no-candidate-files']);
  assert.equal(goalWithContextPack('do it', empty), 'do it');
  assert.equal(goalWithContextPack('do it', { prompt: 'CTX' }), 'CTX\n\nTask:\ndo it');
  assert.equal(goalWithContextPack('do it', null), 'do it');
});

const okL2 = <T>(data: T, op: string) => ({
  ok: true as const,
  data,
  meta: { provider: 'jev' as const, op, mode: 'live' as const, latencyMs: 0, destination: 'gateway' },
});
function jevStub(mode: 'live' | 'mock', scoreFiles?: DecisionAdapter['scoreFiles']): DecisionAdapter {
  return { id: 'jev', mode, capabilities: ['decision'], ...(scoreFiles ? { scoreFiles } : {}) } as unknown as DecisionAdapter;
}
const callCtx = { runId: 'run_l2', policyRule: 'check' } as Parameters<NonNullable<DecisionAdapter['scoreFiles']>>[1];
const twoFiles = {
  task: 'refresh session',
  files: [
    { path: 'a.ts', summary: 'session' },
    { path: 'b.ts', summary: '' },
  ],
};
const sanitized = { sanitizedForRemote: true, dataLabels: [] };

await test('DecisionService.scoreFiles: unsupported, ineligible and failed calls fall back', async () => {
  assert.deepEqual(await new DecisionService(jevStub('live')).scoreFiles(sanitized, twoFiles, callCtx), {
    scores: null,
    reasonCodes: ['jev-score-files-unsupported', 'deterministic-rank-fallback'],
  });
  let called = false;
  const live = new DecisionService(
    jevStub('live', (async () => {
      called = true;
      return okL2({ scores: { 'a.ts': 1 }, reasonCodes: ['jev-file-relevance'] }, 'score_files');
    }) as never),
  );
  for (const state of [
    { sanitizedForRemote: false, dataLabels: [] },
    { sanitizedForRemote: true, dataLabels: ['secret'] },
    { sanitizedForRemote: true, dataLabels: ['local_only'] },
  ]) {
    assert.deepEqual(await live.scoreFiles(state as never, twoFiles, callCtx), {
      scores: null,
      reasonCodes: ['remote-jev-ineligible', 'deterministic-rank-fallback'],
    });
  }
  assert.equal(called, false, 'nothing leaves for an ineligible state');
  const failing = new DecisionService(
    jevStub('live', (async () => ({
      ok: false as const,
      error: { code: 'UPSTREAM', message: 'boom', retryable: true },
      meta: { provider: 'jev', op: 'score_files', mode: 'live', latencyMs: 0, destination: 'gateway' },
    })) as never),
  );
  assert.deepEqual(await failing.scoreFiles(sanitized, twoFiles, callCtx), {
    scores: null,
    reasonCodes: ['jev-score-files-failed', 'deterministic-rank-fallback'],
  });
});

await test('DecisionService.scoreFiles: scores clamped, non-candidates dropped, missing -> 0', async () => {
  const svc = new DecisionService(
    jevStub('live', (async () =>
      okL2({ scores: { 'a.ts': 1.7, 'z.ts': 1, 'b.ts': Number.NaN }, reasonCodes: ['jev-file-relevance'] }, 'score_files')) as never),
  );
  assert.deepEqual(await svc.scoreFiles(sanitized, twoFiles, callCtx), {
    scores: { 'a.ts': 1, 'b.ts': 0 },
    reasonCodes: ['jev-file-relevance'],
  });
  assert.deepEqual(await svc.scoreFiles(sanitized, { task: 't', files: [] }, callCtx), {
    scores: {},
    reasonCodes: ['no-candidate-files'],
  });
});

await test('mock Jev adapter scores files deterministically from task overlap', async () => {
  const jev = createJev({ mode: 'mock' } as ProviderConfigL2);
  const result = await jev.scoreFiles!(
    {
      task: 'refresh the session token',
      files: [
        { path: 'src/auth/session.ts', summary: 'exports refreshSession' },
        { path: 'src/billing/invoice.ts', summary: 'exports Invoice' },
      ],
    },
    callCtx,
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.data.scores['src/auth/session.ts']! > result.data.scores['src/billing/invoice.ts']!);
  assert.equal(result.data.scores['src/billing/invoice.ts'], 0);
});

await test('builder: Jev sees the sanitized objective; no session or a secret label means fallback', async () => {
  const seen: string[] = [];
  const adapter = jevStub('live', (async (input: { task: string; files: { path: string }[] }) => {
    seen.push(input.task);
    return okL2(
      { scores: Object.fromEntries(input.files.map((f) => [f.path, 1])), reasonCodes: ['jev-file-relevance'] },
      'score_files',
    );
  }) as never);
  const session = (labels: string[]) =>
    ({
      context: [],
      objective: TASK,
      sanitizedObjective: 'Renew expired sessions in the auth module',
      dataLabels: labels,
    }) as unknown as AgentSessionStateL2;
  const rec = recorder();
  const build = (labels: string[] | null) =>
    createContextPackBuilder({
      decisions: new DecisionService(adapter),
      sessions: { get: async () => (labels ? session(labels) : null) },
      emit: rec.emit,
      options: { cache: new Map() },
    });
  const noSession = await build(null)({ task: TASK, worktree: repoDir }, { ...callCtx, sessionStateId: 'ses_x' });
  assert.equal(noSession.source, 'fallback');
  assert.equal(seen.length, 0);
  const secret = await build(['secret'])({ task: TASK, worktree: repoDir }, { ...callCtx, sessionStateId: 'ses_x' });
  assert.equal(secret.source, 'fallback');
  assert.equal(seen.length, 0);
  const clean = await build([])({ task: TASK, worktree: repoDir }, { ...callCtx, stepId: 'stp_9', sessionStateId: 'ses_x' });
  assert.equal(clean.source, 'jev');
  assert.deepEqual(seen, ['Renew expired sessions in the auth module'], 'the raw task never left');
  assert.ok(rec.events.some((e) => e.source === 'jev' && e.stepId === 'stp_9'));
  assert.ok(rec.events.some((e) => e.source === 'fallback'));
});

/* -------------------------------------------------------------------------- */
/* L3 schema minimization                                                     */
/* -------------------------------------------------------------------------- */

console.log('\nL3 schema minimization');

const { classifyTask, nativeToolPolicy, claudeCodeSessionMeta, NATIVE_TOOL_GROUPS } = await import(
  '../src/core/tools/toolPolicy.js'
);
const { claudeCodeSettings } = await import('../src/providers/claudecode/settings.js');
const { ToolSetTracker, toolsText, hashTools } = await import('../src/core/modelGateway/toolSet.js');
const { AnthropicMessagesGateway } = await import('../src/core/modelGateway/messages.js');
const { GatewayRunTokenStore } = await import('../src/core/modelGateway/runTokens.js');
const { createReplayer, readAll, bytes } = await import('../src/core/modelGateway/replay/replayer.js');
const fx = await import('../src/core/modelGateway/replay/fixtures.js');
const { parseRunEvent } = await import('@htn/shared');

/** Tools L3 must never take away: without them an agent cannot read or run anything. */
const ALWAYS_KEPT = ['Bash', 'Glob', 'Grep', 'LS', 'Read', 'TodoWrite'];

await test('classifier: edit verbs win, questions are read, ambiguity is edit', () => {
  assert.equal(classifyTask('Fix refreshSession so an expired session is renewed').taskClass, 'edit');
  assert.equal(classifyTask('Explain how the session cache is invalidated').taskClass, 'read');
  assert.equal(classifyTask('Where is the invoice total computed?').taskClass, 'read');
  assert.equal(classifyTask('Review src/auth and fix anything unsafe').taskClass, 'edit', 'read + edit = edit');
  assert.equal(classifyTask('the session thing').taskClass, 'edit', 'no signal falls towards more tools');
  assert.equal(classifyTask('Rename parseRow to parseRecord').taskClass, 'edit');
});

await test('classifier: web and notebook needs come from the task text only', () => {
  assert.equal(classifyTask('Rename a helper in the webpack config').needsWeb, false, 'webpack is not the web');
  assert.equal(classifyTask('Update the client to match https://example.com/api').needsWeb, true);
  assert.equal(classifyTask('Look up the latest zod release notes online and upgrade').needsWeb, true);
  assert.equal(classifyTask('Fix the plot in analysis.ipynb').needsNotebook, true);
  assert.equal(classifyTask('Fix the plot in analysis.py').needsNotebook, false);
});

await test('policy: a pure refactor loses web, notebook, subagent and plan tools, keeps the rest', () => {
  const p = nativeToolPolicy('Refactor the billing module into smaller functions');
  assert.equal(p.taskClass, 'edit');
  assert.deepEqual(p.disallowedTools, ['ExitPlanMode', 'NotebookEdit', 'Task', 'WebFetch', 'WebSearch']);
  assert.equal(p.strictMcpConfig, true);
  for (const kept of [...ALWAYS_KEPT, 'Edit', 'MultiEdit', 'Write']) assert.ok(!p.disallowedTools.includes(kept), kept);
});

await test('policy: read tasks also lose the write tools; web and notebook tasks keep theirs', () => {
  const read = nativeToolPolicy('Explain why the session cache misses on refresh');
  for (const t of NATIVE_TOOL_GROUPS.write) assert.ok(read.disallowedTools.includes(t), t);
  for (const kept of ALWAYS_KEPT) assert.ok(!read.disallowedTools.includes(kept), kept);
  const web = nativeToolPolicy('Update the client to match https://example.com/api');
  assert.ok(!web.disallowedTools.includes('WebFetch') && !web.disallowedTools.includes('WebSearch'));
  const nb = nativeToolPolicy('Fix the plot in analysis.ipynb');
  assert.ok(!nb.disallowedTools.includes('NotebookEdit'));
  for (const t of NATIVE_TOOL_GROUPS.always) assert.ok(nb.disallowedTools.includes(t), 'always off: ' + t);
});

await test('policy: same task, same bytes; sorted and unique; the fingerprint tracks the set', () => {
  const task = 'Fix refreshSession so an expired session in src/auth/session.ts is renewed';
  const first = JSON.stringify(nativeToolPolicy(task));
  for (let i = 0; i < 50; i += 1) assert.equal(JSON.stringify(nativeToolPolicy(task)), first);
  const p = nativeToolPolicy(task);
  assert.deepEqual(p.disallowedTools, [...new Set(p.disallowedTools)].sort());
  assert.match(p.fingerprint, /^[0-9a-f]{12}$/);
  assert.notEqual(nativeToolPolicy('Explain the auth flow').fingerprint, p.fingerprint);
  assert.equal(nativeToolPolicy('Refactor billing').fingerprint, nativeToolPolicy('Rename the auth helpers').fingerprint);
});

await test('policy is applied twice from one list: ACP session _meta and settings deny rules', () => {
  const p = nativeToolPolicy('Refactor the billing module');
  const meta = claudeCodeSessionMeta(p) as {
    claudeCode: { options: { disallowedTools: string[]; extraArgs: Record<string, null> } };
  };
  assert.deepEqual(meta.claudeCode.options.disallowedTools, p.disallowedTools);
  assert.deepEqual(meta.claudeCode.options.extraArgs, { 'strict-mcp-config': null });
  meta.claudeCode.options.disallowedTools.push('Bash');
  assert.ok(!p.disallowedTools.includes('Bash'), 'the meta holds a copy');
  const s = claudeCodeSettings({ hookUrl: 'http://127.0.0.1:1/h', deny: p.disallowedTools });
  assert.deepEqual(s.permissions.deny, p.disallowedTools);
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(claudeCodeSettings({ hookUrl: 'http://127.0.0.1:1/h' }).permissions.deny, undefined);
  assert.equal(claudeCodeSettings({ hookUrl: 'http://127.0.0.1:1/h', deny: [] }).permissions.deny, undefined);
});

await test('levers: schemaMin defaults on and can be switched off on its own', () => {
  assert.equal(DEFAULT_LEVERS.schemaMin, true);
  assert.deepEqual(resolveLevers({ schemaMin: false }), { shapedTools: true, contextPack: true, schemaMin: false });
});

await test('tool-set tracker: exact bytes, per run and model; tool-less calls are not tracked', () => {
  const t = new ToolSetTracker();
  const raw = toolsText(fx.TURN1_REQUEST)!;
  assert.ok(raw.startsWith('[{"name": "Read"') && raw.endsWith(']'));
  assert.equal(toolsText('{"model":"m","messages":[]}'), undefined);
  assert.equal(toolsText('{"model":"m","tools":[],"messages":[]}'), undefined);
  const a = t.observe('run_a', 'm', fx.TURN1_REQUEST)!;
  assert.deepEqual(a, { hash: hashTools(raw), names: ['Read', 'Bash'], changed: false });
  assert.equal(t.observe('run_a', 'm', fx.TURN2_REQUEST)!.changed, false, 'same tools, longer transcript');
  const reformatted = fx.TURN2_REQUEST.replace(raw, JSON.stringify(JSON.parse(raw)));
  assert.equal(t.observe('run_a', 'm', reformatted)!.changed, true, 'whitespace alone breaks the cache prefix');
  assert.equal(t.observe('run_a', 'small', reformatted)!.changed, false, 'another model is its own baseline');
  assert.equal(t.observe('run_b', 'm', reformatted)!.changed, false, 'another run is its own baseline');
  assert.equal(t.observe('run_a', 'm', '{"model":"m","messages":[]}'), undefined);
  const [main] = t.run('run_a').filter((r) => r.model === 'm');
  assert.equal(main!.requests, 3);
  assert.equal(main!.changes, 1);
  t.forget('run_a');
  assert.deepEqual(t.run('run_a'), []);
});

/**
 * The step 4 replay harness: a whole session through the gateway, every request
 * recorded at the fake upstream. The L3 promise is that the `tools` bytes are
 * identical on every request in the run.
 */
async function replaySession(bodies: string[]) {
  const replay = createReplayer(
    bodies.map((_, i) => ({
      status: 200,
      headers: fx.STREAM_HEADERS,
      body: i === 0 ? fx.TURN1_STREAM : fx.TURN2_STREAM,
    })),
  );
  const tokens = new GatewayRunTokenStore();
  const events: import('@htn/shared').RunEvent[] = [];
  const gateway = new AnthropicMessagesGateway({
    upstream: replay.upstream,
    tokens,
    emit: (_runId, event) => {
      events.push(parseRunEvent(event));
    },
  });
  const runId = 'run_l3_' + bodies.length + '_' + events.length + Math.random().toString(36).slice(2, 8);
  const token = tokens.mint({ runId, harness: 'claudecode', budget: {} });
  for (const body of bodies) {
    const reply = await gateway.messages({
      path: '/v1/messages',
      search: '',
      body: bytes(body),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    });
    assert.equal(reply.status, 200);
    await readAll(reply.body);
  }
  const calls = events.filter(
    (e): e is Extract<import('@htn/shared').RunEvent, { type: 'gateway.call' }> => e.type === 'gateway.call',
  );
  return { gateway, replay, calls, runId };
}

await test('stable tool set: every gateway request in a replayed run carries identical tool bytes', async () => {
  const sideCall = JSON.stringify({ ...JSON.parse(fx.TURN1_REQUEST), model: 'claude-haiku-5-5', tools: undefined });
  const { gateway, replay, calls, runId } = await replaySession([
    fx.TURN1_REQUEST,
    fx.TURN2_REQUEST,
    sideCall,
    fx.TURN2_REQUEST,
  ]);
  const withTools = replay.requests.map((r) => toolsText(r.text)).filter((t): t is string => t !== undefined);
  assert.equal(withTools.length, 3);
  assert.ok(withTools.every((t) => t === withTools[0]), 'byte-identical tools at the upstream');
  assert.equal(calls.length, 4);
  const hashes = calls.filter((c) => c.toolsHash).map((c) => c.toolsHash);
  assert.deepEqual(hashes, [hashTools(withTools[0]!), hashTools(withTools[0]!), hashTools(withTools[0]!)]);
  assert.ok(calls.every((c) => c.toolSetChanged !== true));
  assert.equal(calls[2]!.toolsHash, undefined, 'the tool-less side call is not tracked');
  const [set] = gateway.toolSets.run(runId);
  assert.equal(set!.changes, 0);
  assert.deepEqual(set!.names, ['Read', 'Bash']);
});

await test('stable tool set: a mid-run change is flagged on the call that broke it', async () => {
  const raw = toolsText(fx.TURN2_REQUEST)!;
  const reordered = JSON.parse(raw) as unknown[];
  reordered.reverse();
  const drifted = fx.TURN2_REQUEST.replace(raw, JSON.stringify(reordered));
  const { gateway, calls, runId } = await replaySession([fx.TURN1_REQUEST, drifted, fx.TURN2_REQUEST]);
  assert.deepEqual(
    calls.map((c) => c.toolSetChanged),
    [false, true, false],
  );
  assert.equal(gateway.toolSets.run(runId)[0]!.changes, 1);
});

await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
console.log(`\nlevers: ${passed} passed`);
process.exit(0);
