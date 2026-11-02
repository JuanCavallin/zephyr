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

await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
console.log(`\nlevers: ${passed} passed`);
process.exit(0);
