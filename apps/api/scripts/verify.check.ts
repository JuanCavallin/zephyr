/**
 * Step 6 check: verification and evidence.
 *
 *   pnpm check:verify
 *
 * Offline. No harness, no model, no network.
 *
 *   1. Test inventory: two runners (js + pytest) in a fixture repo; import graph,
 *      name heuristic, coverage map.
 *   2. selectTests: Jev and fallback sources; unavailable Jev never shrinks the set.
 *   3. Completion verdict and flaky-vs-real.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { buildTestInventory, inventoryFromIndex, runnerFor } = await import('../src/core/verify/testInventory.js');
const { matchesGlob } = await import('../src/core/verify/glob.js');
const { resolveVerifyPolicy, DEFAULT_VERIFY_POLICY } = await import('@htn/shared');
const { selectTests, summarizePatch } = await import('../src/core/verify/testImpact.js');
const { DecisionService, fallbackCodingCompletion } = await import('../src/core/decisions/service.js');
const { create: createJev } = await import('../src/providers/jev/index.js');
type DecisionAdapter = import('@htn/shared').DecisionAdapter;
type ProviderConfig = import('../src/config.js').ProviderConfig;
type CodingCompletionInput = import('@htn/shared').CodingCompletionInput;

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

const scratch = await mkdtemp(join(tmpdir(), 'zephyr-verify-check-'));

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** Two runners: vitest-style `*.test.ts` and pytest `test_*.py`. */
const REPO: Record<string, string> = {
  'package.json': '{"name":"fixture"}\n',
  'src/util.ts': 'export const twice = (n: number) => n * 2;\n',
  'src/math.ts': "import { twice } from './util.js';\nexport function add(a: number, b: number) { return twice(a + b) / 2; }\n",
  'src/math.test.ts': "import { add } from './math.js';\nif (add(1, 2) !== 3) throw new Error('add');\n",
  'src/other.ts': 'export const other = 1;\n',
  'src/__snapshots__/math.test.ts.snap': 'exports[`add`] = 3;\n',
  'py/calc.py': 'def add(a, b):\n    return a + b\n',
  'py/orphan.py': 'def lonely():\n    return 1\n',
  'py/tests/test_calc.py': 'from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  'py/tests/test_orphan.py': 'def test_lonely():\n    assert True\n',
  '.github/workflows/ci.yml': 'on: push\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
};
const repo = join(scratch, 'repo');
await writeTree(repo, REPO);

/* -------------------------------------------------------------------------- */
/* 1. Test inventory                                                          */
/* -------------------------------------------------------------------------- */

await test('policy: defaults resolve, invalid globs are rejected', () => {
  assert.deepEqual(resolveVerifyPolicy(), DEFAULT_VERIFY_POLICY);
  assert.equal(resolveVerifyPolicy({ fullSuiteBeforePublish: true }).fullSuiteBeforePublish, true);
  assert.throws(() => resolveVerifyPolicy({ protectedGlobs: ['C:\\x'] }));
});

await test('glob: ** crosses directories, * stays in a segment, bare names match basenames', () => {
  assert.ok(matchesGlob('a/b/c.snap', '**/*.snap'));
  assert.ok(matchesGlob('c.snap', '**/*.snap'));
  assert.ok(!matchesGlob('a/b/c.ts', 'a/*.ts'));
  assert.ok(matchesGlob('a/b/c.ts', 'a/**'));
  assert.ok(matchesGlob('deep/pnpm-lock.yaml', '*.yaml'));
  assert.ok(matchesGlob('.eslintrc.json', '{.eslintrc*,eslint.config.*}'));
});

await test('inventory: discovers tests per runner from file patterns', async () => {
  const inv = await buildTestInventory(repo, DEFAULT_VERIFY_POLICY);
  assert.deepEqual(inv.runners, ['js', 'pytest']);
  assert.deepEqual(
    inv.tests.map((t) => [t.id, t.runner]),
    [
      ['py/tests/test_calc.py', 'pytest'],
      ['py/tests/test_orphan.py', 'pytest'],
      ['src/math.test.ts', 'js'],
    ],
  );
  assert.equal(inv.coverageMap, false);
  assert.equal(runnerFor('pkg/foo_test.go'), 'go');
  assert.equal(runnerFor('src/math.ts'), null);
});

await test('inventory: import graph is transitive, heuristic covers by name', async () => {
  const inv = await buildTestInventory(repo, DEFAULT_VERIFY_POLICY);
  const covers = (id: string) => inv.tests.find((t) => t.id === id)!.covers;
  assert.deepEqual(covers('src/math.test.ts'), [
    { path: 'src/math.ts', via: 'import' },
    { path: 'src/util.ts', via: 'import' },
  ]);
  assert.deepEqual(covers('py/tests/test_calc.py'), [{ path: 'py/calc.py', via: 'import' }]);
  assert.deepEqual(covers('py/tests/test_orphan.py'), [{ path: 'py/orphan.py', via: 'heuristic' }]);
});

await test('inventory: a coverage map replaces the graph for the sources it names', async () => {
  const policy = resolveVerifyPolicy({ coverageMap: { 'src/util.ts': ['py/tests/test_orphan.py'] } });
  const inv = await buildTestInventory(repo, policy);
  const covers = (id: string) => inv.tests.find((t) => t.id === id)!.covers;
  assert.equal(inv.coverageMap, true);
  assert.deepEqual(covers('src/math.test.ts'), [{ path: 'src/math.ts', via: 'import' }]);
  assert.deepEqual(covers('py/tests/test_orphan.py'), [
    { path: 'py/orphan.py', via: 'heuristic' },
    { path: 'src/util.ts', via: 'coverage' },
  ]);
});

await test('inventory: custom runners extend discovery', () => {
  const inv = inventoryFromIndex(
    {
      files: [
        { path: 'scripts/a.check.ts', exports: [], symbols: [], imports: ['../src/a.js'], doc: '', size: 1, isTest: false },
        { path: 'src/a.ts', exports: ['a'], symbols: ['a'], imports: [], doc: '', size: 1, isTest: false },
      ],
    },
    DEFAULT_VERIFY_POLICY,
    [{ id: 'check', pattern: /\.check\.ts$/ }],
  );
  assert.deepEqual(inv.tests, [{ id: 'scripts/a.check.ts', runner: 'check', covers: [{ path: 'src/a.ts', via: 'import' }] }]);
});

/* -------------------------------------------------------------------------- */
/* 2. selectTests                                                             */
/* -------------------------------------------------------------------------- */

const PATCH = [
  'diff --git a/src/util.ts b/src/util.ts',
  'index 1111111..2222222 100644',
  '--- a/src/util.ts',
  '+++ b/src/util.ts',
  '@@ -1 +1,2 @@',
  '-export const twice = (n: number) => n * 2;',
  '+export const twice = (n: number) => n + n;',
  '+export const thrice = (n: number) => n * 3;',
  'diff --git a/src/new.test.ts b/src/new.test.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.test.ts',
  '@@ -0,0 +1 @@',
  "+import './util.js';",
  'diff --git a/py/orphan.py b/py/orphan.py',
  'deleted file mode 100644',
  '--- a/py/orphan.py',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-def lonely():',
  '-    return 1',
  '',
].join('\n');

await test('summarizePatch: per-file status and line counts, sha256 hash', () => {
  const d = summarizePatch(PATCH);
  assert.deepEqual(
    d.files.map((f) => [f.path, f.status, f.insertions, f.deletions]),
    [
      ['src/util.ts', 'modified', 2, 1],
      ['src/new.test.ts', 'added', 1, 0],
      ['py/orphan.py', 'deleted', 0, 2],
    ],
  );
  assert.equal(d.insertions, 3);
  assert.equal(d.deletions, 3);
  assert.match(d.hash, /^[0-9a-f]{64}$/);
});

const jevStub = (mode: 'live' | 'mock', extra: Partial<DecisionAdapter> = {}): DecisionAdapter =>
  ({ id: 'jev', mode, capabilities: ['decision'], ...extra }) as unknown as DecisionAdapter;
const ok = <T>(data: T, op: string) => ({
  ok: true as const,
  data,
  meta: { provider: 'jev' as const, op, mode: 'live' as const, latencyMs: 0, destination: 'gateway' },
});
const fail = (op: string) => ({
  ok: false as const,
  error: { code: 'UPSTREAM' as const, message: 'down', retryable: true },
  meta: { provider: 'jev' as const, op, mode: 'live' as const, latencyMs: 0, destination: 'gateway' },
});
const ctx = { runId: 'run_verify', policyRule: 'check' } as Parameters<DecisionAdapter['decide']>[1];
const sanitized = { sanitizedForRemote: true, dataLabels: [] };
const unsanitized = { sanitizedForRemote: false, dataLabels: [] };

const inventory = await buildTestInventory(repo, DEFAULT_VERIFY_POLICY);
const utilDiff = { files: [{ path: 'src/util.ts', status: 'modified' as const, insertions: 1, deletions: 1 }] };

await test('selectTests: candidates intersect the diff plus always-run', async () => {
  const policy = resolveVerifyPolicy({ alwaysRun: ['py/tests/test_orphan.py'] });
  const sel = await selectTests(utilDiff, inventory, policy);
  assert.equal(sel.source, 'fallback');
  assert.deepEqual(sel.candidates, ['py/tests/test_orphan.py', 'src/math.test.ts']);
  assert.ok(sel.selected.every((t) => t.fallback && t.score === undefined));
});

await test('selectTests: Jev scores drop distant tests but never always-run or changed ones', async () => {
  const policy = resolveVerifyPolicy({ alwaysRun: ['py/tests/test_orphan.py'] });
  const diff = {
    files: [...utilDiff.files, { path: 'py/tests/test_calc.py', status: 'modified' as const, insertions: 1, deletions: 0 }],
  };
  const decisions = new DecisionService(
    jevStub('live', {
      scoreTests: async (input) =>
        ok(
          {
            scores: Object.fromEntries(input.tests.map((t) => [t.id, t.id === 'src/math.test.ts' ? 0.9 : 0])),
            reasonCodes: ['jev-test-relevance'],
          },
          'score_tests',
        ),
    }),
  );
  const sel = await selectTests(diff, inventory, policy, {
    task: 'make twice additive',
    scorer: (input) => decisions.scoreTests(sanitized, input, ctx),
  });
  assert.equal(sel.source, 'jev');
  assert.deepEqual(
    sel.selected.map((t) => [t.id, t.score, t.fallback]),
    [
      ['src/math.test.ts', 0.9, false],
      ['py/tests/test_calc.py', 0, false],
      ['py/tests/test_orphan.py', 0, false],
    ],
  );

  // A low score drops a covering-only test.
  const low = new DecisionService(
    jevStub('live', { scoreTests: async (input) => ok({ scores: Object.fromEntries(input.tests.map((t) => [t.id, 0.1])), reasonCodes: [] }, 'score_tests') }),
  );
  const dropped = await selectTests(utilDiff, inventory, DEFAULT_VERIFY_POLICY, {
    scorer: (input) => low.scoreTests(sanitized, input, ctx),
  });
  assert.deepEqual(dropped.selected, []);
  assert.deepEqual(dropped.candidates, ['src/math.test.ts']);
});

await test('selectTests: unavailable, ineligible, failing or throwing Jev never shrinks the set', async () => {
  const policy = DEFAULT_VERIFY_POLICY;
  const baseline = (await selectTests(utilDiff, inventory, policy)).selected.map((t) => t.id);
  assert.ok(baseline.length > 0);
  const cases: [InstanceType<typeof DecisionService>, typeof sanitized][] = [
    [new DecisionService(jevStub('live')), sanitized],
    [new DecisionService(jevStub('live', { scoreTests: async () => ok({ scores: {}, reasonCodes: [] }, 'score_tests') })), unsanitized],
    [new DecisionService(jevStub('live', { scoreTests: async () => fail('score_tests') })), sanitized],
  ];
  for (const [i, [d, eligibility]] of cases.entries()) {
    const sel = await selectTests(utilDiff, inventory, policy, { scorer: (input) => d.scoreTests(eligibility, input, ctx) });
    assert.equal(sel.source, 'fallback', `case ${i}`);
    assert.deepEqual(sel.selected.map((t) => t.id), baseline);
    assert.ok(sel.reasonCodes.includes('run-every-candidate'), sel.reasonCodes.join());
  }
  const thrown = await selectTests(utilDiff, inventory, policy, {
    scorer: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(thrown.selected.map((t) => t.id), baseline);
  assert.equal(thrown.source, 'fallback');
});

await test('selectTests: the mock Jev ranks the covering test first and keeps always-run', async () => {
  const decisions = new DecisionService(createJev({ mode: 'mock' } as ProviderConfig));
  const policy = resolveVerifyPolicy({ alwaysRun: ['py/tests/test_orphan.py'] });
  const sel = await selectTests(utilDiff, inventory, policy, { scorer: (input) => decisions.scoreTests(sanitized, input, ctx) });
  assert.equal(sel.source, 'jev');
  assert.equal(sel.selected[0]!.id, 'src/math.test.ts');
  assert.ok(sel.selected.some((t) => t.id === 'py/tests/test_orphan.py'), 'always-run kept');
});

/* -------------------------------------------------------------------------- */
/* 3. Completion verdict, flaky-vs-real                                       */
/* -------------------------------------------------------------------------- */

const completion = (over: Partial<CodingCompletionInput> = {}): CodingCompletionInput => ({
  task: 'make twice additive',
  tests: { passed: 3, failed: 0, skipped: 0 },
  diff: { files: 1, insertions: 1, deletions: 1 },
  turns: 1,
  maxTurns: 4,
  pendingApprovals: 0,
  ...over,
});
const red = { passed: 0, failed: 2, skipped: 0 };

await test('completion fallback: failing tests never yield done', () => {
  for (const turns of [0, 1, 3, 4, 9]) {
    for (const files of [0, 1, 5]) {
      for (const pendingApprovals of [0, 1]) {
        const status = fallbackCodingCompletion(
          completion({ turns, pendingApprovals, diff: { files, insertions: 1, deletions: 0 }, tests: red }),
        );
        assert.notEqual(status, 'done', `turns=${turns} files=${files}`);
      }
    }
  }
  assert.equal(fallbackCodingCompletion(completion({ tests: red })), 'continue');
  assert.equal(fallbackCodingCompletion(completion({ tests: red, turns: 4 })), 'blocked');
  assert.equal(fallbackCodingCompletion(completion()), 'done');
  assert.equal(fallbackCodingCompletion(completion({ pendingApprovals: 1 })), 'blocked');
  assert.equal(fallbackCodingCompletion(completion({ diff: { files: 0, insertions: 0, deletions: 0 } })), 'continue');
});

await test('completionVerdict: Jev decides; a done over failing tests is reported unverified, not rewritten', async () => {
  const done = new DecisionService(
    jevStub('live', {
      judgeCodingCompletion: async () =>
        ok({ status: 'done' as const, confidence: 0.4, probabilities: { done: 0.4 }, reasonCodes: ['jev-coding-completion'] }, 'judge_coding_completion'),
    }),
  );
  const failing = await done.completionVerdict(sanitized, completion({ tests: { passed: 1, failed: 1, skipped: 0 } }), ctx);
  assert.equal(failing.source, 'jev');
  assert.equal(failing.status, 'done');
  assert.equal(failing.verified, false);
  assert.deepEqual(failing.verificationFailures, ['tests-failing']);
  assert.ok(failing.reasonCodes.includes('done-unverified'));
  assert.equal((await done.completionVerdict(sanitized, completion(), ctx)).verified, true);

  const mock = new DecisionService(createJev({ mode: 'mock' } as ProviderConfig));
  assert.equal((await mock.completionVerdict(sanitized, completion({ tests: red }), ctx)).status, 'continue');
  assert.equal((await mock.completionVerdict(sanitized, completion(), ctx)).status, 'done');
});

await test('completionVerdict: unsupported, ineligible and failed Jev use the fallback rule', async () => {
  const cases: [InstanceType<typeof DecisionService>, typeof sanitized, string][] = [
    [new DecisionService(jevStub('live')), sanitized, 'jev-coding-completion-unsupported'],
    [
      new DecisionService(
        jevStub('live', { judgeCodingCompletion: async () => ok({ status: 'done' as const, confidence: 1, probabilities: {}, reasonCodes: [] }, 'x') }),
      ),
      unsanitized,
      'remote-jev-ineligible',
    ],
    [
      new DecisionService(jevStub('live', { judgeCodingCompletion: async () => fail('judge_coding_completion') })),
      sanitized,
      'jev-coding-completion-failed',
    ],
  ];
  for (const [service, eligibility, reason] of cases) {
    const v = await service.completionVerdict(eligibility, completion({ tests: red }), ctx);
    assert.equal(v.source, 'fallback');
    assert.equal(v.status, 'continue');
    assert.ok(v.reasonCodes.includes(reason), v.reasonCodes.join());
    assert.equal(v.verified, false);
  }
});

await test('flakyVerdict: Jev probability from history; default treats failures as real', async () => {
  const input = { test: 'src/math.test.ts', history: ['pass', 'fail', 'pass', 'fail'] as ('pass' | 'fail')[], touchedByDiff: false };
  const mock = new DecisionService(createJev({ mode: 'mock' } as ProviderConfig));
  const flaky = await mock.flakyVerdict(sanitized, input, ctx);
  assert.equal(flaky.source, 'jev');
  assert.equal(flaky.flaky, true);
  assert.equal((await mock.flakyVerdict(sanitized, { ...input, touchedByDiff: true }, ctx)).flaky, false);

  const flakyStub = jevStub('live', { judgeFlaky: async () => ok({ flakyProbability: 0.99, reasonCodes: [] }, 'judge_flaky') });
  const cases: [InstanceType<typeof DecisionService>, typeof sanitized][] = [
    [new DecisionService(jevStub('live')), sanitized],
    [new DecisionService(jevStub('live', { judgeFlaky: async () => fail('judge_flaky') })), sanitized],
    [new DecisionService(flakyStub), unsanitized],
  ];
  for (const [service, eligibility] of cases) {
    const v = await service.flakyVerdict(eligibility, input, ctx);
    assert.deepEqual([v.flaky, v.probability, v.source], [false, 0, 'fallback']);
    assert.ok(v.reasonCodes.includes('treat-failure-as-real'));
  }
});

await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
console.log(`\nverify: ${passed} passed`);
process.exit(0);
