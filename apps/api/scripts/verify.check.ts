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
 *   4. Protected paths and the permission-bridge rule.
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

/* ------------------------- 4. protected paths ------------------------- */

console.log('protected paths');
const { isProtected, protectionOf, hotFileIntentProtection } = await import('../src/core/verify/protectedPaths.js');
const { createPermissionBridge, protectedWriteDiff } = await import('../src/core/tools/permissionBridge.js');
type AuthorizationDecision = import('@htn/shared').AuthorizationDecision;
type ToolAction = import('@htn/shared').ToolAction;

await test('isProtected: defaults, run-created exemption, policy globs, protectDefaults off', () => {
  const none = new Set<string>();
  const cases: [string, string | null][] = [
    ['src/math.test.ts', 'existing-test'],
    ['tests/test_util.py', 'existing-test'],
    ['pkg/x_test.go', 'existing-test'],
    ['src/__tests__/helpers.ts', 'existing-test'],
    ['src/__snapshots__/a.test.ts.snap', 'snapshot'],
    ['.github/workflows/ci.yml', 'ci-config'],
    ['.gitlab-ci.yml', 'ci-config'],
    ['eslint.config.js', 'lint-config'],
    ['apps/web/.prettierrc.json', 'lint-config'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['apps/api/yarn.lock', 'lockfile'],
    ['src/math.ts', null],
    ['README.md', null],
  ];
  for (const [path, reason] of cases) {
    assert.equal(protectionOf(path, DEFAULT_VERIFY_POLICY, none), reason, path);
    assert.equal(isProtected(path, DEFAULT_VERIFY_POLICY, none), reason !== null, path);
  }
  const created = new Set(['src/new.test.ts', 'src/__snapshots__/new.snap', 'pnpm-lock.yaml']);
  assert.equal(isProtected('src/new.test.ts', DEFAULT_VERIFY_POLICY, created), false, 'run-created test is editable');
  assert.equal(isProtected('src/__snapshots__/new.snap', DEFAULT_VERIFY_POLICY, created), false);
  assert.equal(isProtected('pnpm-lock.yaml', DEFAULT_VERIFY_POLICY, created), true, 'lockfiles stay guarded');

  const custom = resolveVerifyPolicy({ protectedGlobs: ['migrations/**'] });
  assert.equal(protectionOf('migrations/001.sql', custom, created), 'policy-glob');
  const off = resolveVerifyPolicy({ protectDefaults: false, protectedGlobs: ['migrations/**'] });
  assert.equal(isProtected('src/math.test.ts', off, none), false);
  assert.equal(isProtected('pnpm-lock.yaml', off, none), false);
  assert.equal(isProtected('migrations/001.sql', off, none), true, 'policy globs apply without defaults');
});

await test('hot-file intent for a lockfile is still protected', () => {
  assert.equal(hotFileIntentProtection({ path: 'pnpm-lock.yaml' }, DEFAULT_VERIFY_POLICY), 'lockfile');
  assert.equal(hotFileIntentProtection({ path: 'package.json' }, DEFAULT_VERIFY_POLICY), null);
});

await test('protectedWriteDiff renders Edit, MultiEdit and Write exactly', () => {
  assert.equal(
    protectedWriteDiff('a.test.ts', { file_path: 'a.test.ts', old_string: 'expect(1)', new_string: 'expect(2)' }, 'x'),
    '--- a/a.test.ts\n+++ b/a.test.ts\n@@\n-expect(1)\n+expect(2)',
  );
  assert.equal(
    protectedWriteDiff('a.test.ts', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] }, 'x'),
    '--- a/a.test.ts\n+++ b/a.test.ts\n@@\n-a\n+b\n@@\n-c',
  );
  assert.equal(
    protectedWriteDiff('pnpm-lock.yaml', { content: 'one\ntwo\n' }, 'one\n'),
    '--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@\n-one\n+one\n+two',
  );
  const long = protectedWriteDiff('x.snap', { content: 'y'.repeat(40_000) }, null);
  assert.ok(long.length < 17_000 && long.includes('contentSha256 binds'), 'long diffs are clipped');
});

const protectedWorktree = join(scratch, 'protected');
await mkdir(join(protectedWorktree, 'src'), { recursive: true });
await writeFile(join(protectedWorktree, 'src/math.ts'), 'export const add = (a, b) => a + b;\n');
await writeFile(join(protectedWorktree, 'src/math.test.ts'), "expect(add(1, 2)).toBe(3);\n");
await writeFile(join(protectedWorktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

const allowAuth = async (): Promise<AuthorizationDecision> =>
  ({ actionId: 'check', recommendation: 'auto', finalPolicy: 'auto', allowed: true, reasonCodes: [], at: new Date().toISOString() }) as unknown as AuthorizationDecision;
function protectedBridge(runCreated = new Set<string>()) {
  const asked: ToolAction[] = [];
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree: protectedWorktree,
    authorize: allowAuth,
    run: { runId: 'run_prot', stepId: 'step_prot' },
    approvals: {
      async request({ action }) {
        asked.push(action);
        return { approvalId: 'apr_' + asked.length };
      },
    },
    runCreated,
  });
  return { bridge, asked, runCreated };
}
const nreq = (toolName: string, rawInput: unknown) =>
  ({ harness: 'claudecode', toolName, rawInput, sessionId: 'sess_prot' }) as import('@htn/shared').NativeToolRequest;

await test('editing an existing test needs approval carrying the exact diff (irreversible)', async () => {
  const { bridge, asked } = protectedBridge();
  const edit = nreq('Edit', { file_path: 'src/math.test.ts', old_string: 'toBe(3)', new_string: 'toBe(4)' });
  const preview = await bridge.preview(edit);
  assert.equal(preview.policy, 'ask_user');
  assert.equal(preview.verdict, 'deny', 'preview never auto-allows a protected edit');
  assert.equal(preview.exact?.descriptor.reversibility, 'irreversible');
  assert.ok(preview.authorization?.reasonCodes.includes('protected-existing-test'));

  const d = await bridge.decide(edit);
  assert.equal(d.verdict, 'allow');
  assert.equal(d.approvalId, 'apr_1');
  assert.equal(asked.length, 1);
  const review = asked[0]!.review as Record<string, unknown>;
  assert.equal(review.protectedPath, 'src/math.test.ts');
  assert.equal(review.protection, 'existing-test');
  assert.equal(review.diff, '--- a/src/math.test.ts\n+++ b/src/math.test.ts\n@@\n-toBe(3)\n+toBe(4)');
  assert.match(String(review.contentSha256), /^[0-9a-f]{64}$/);

  const other = await bridge.decide(nreq('Edit', { file_path: 'src/math.test.ts', old_string: 'toBe(3)', new_string: 'toBe(5)' }));
  assert.equal(asked.length, 2, 'a different diff is a different action and asks again');
  assert.notEqual(other.reusedGrant, true);
});

await test('adding a new test is auto and flagged; later edits to it stay auto', async () => {
  const { bridge, asked, runCreated } = protectedBridge();
  const add = await bridge.decide(nreq('Write', { file_path: 'src/math.extra.test.ts', content: 'it("adds", () => {});\n' }));
  assert.equal(add.policy, 'auto');
  assert.equal(add.verdict, 'allow');
  assert.ok(add.authorization?.reasonCodes.includes('new-test-file'), 'new tests are flagged');
  assert.ok(runCreated.has('src/math.extra.test.ts'));
  await writeFile(join(protectedWorktree, 'src/math.extra.test.ts'), 'it("adds", () => {});\n');
  const edit = await bridge.decide(nreq('Edit', { file_path: 'src/math.extra.test.ts', old_string: 'adds', new_string: 'adds two' }));
  assert.equal(edit.policy, 'auto', 'a run-created test is not pre-existing');
  assert.equal(asked.length, 0);
  const plain = await bridge.decide(nreq('Edit', { file_path: 'src/math.ts', old_string: 'a + b', new_string: 'b + a' }));
  assert.equal(plain.policy, 'auto', 'ordinary source stays auto');
  assert.ok(!plain.authorization?.reasonCodes.includes('protected-path'));
});

await test('a lockfile write applying a hot-file intent still goes through approval', async () => {
  const { bridge, asked } = protectedBridge(new Set(['pnpm-lock.yaml']));
  const intent = { id: 'hfi_1', taskId: 'task_1', path: 'pnpm-lock.yaml', kind: 'add_dependency', description: 'add dependency zod@3' };
  assert.equal(hotFileIntentProtection(intent, DEFAULT_VERIFY_POLICY), 'lockfile');
  const d = await bridge.decide(nreq('Write', { file_path: intent.path, content: 'lockfileVersion: 9\nzod: 3\n' }));
  assert.equal(d.policy, 'ask_user');
  assert.equal(asked.length, 1);
  assert.equal((asked[0]!.review as Record<string, unknown>).protection, 'lockfile');
  assert.equal(
    (asked[0]!.review as Record<string, unknown>).diff,
    '--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@\n-lockfileVersion: 9\n+lockfileVersion: 9\n+zod: 3',
  );
});

await test('a protected edit with no approval gate denies', async () => {
  const bridge = createPermissionBridge({ harness: 'claudecode', worktree: protectedWorktree, authorize: allowAuth, run: { runId: 'r', stepId: 's' } });
  const d = await bridge.decide(nreq('Edit', { file_path: 'src/math.test.ts', old_string: 'a', new_string: 'b' }));
  assert.equal(d.verdict, 'deny');
});

await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
console.log(`\nverify: ${passed} passed`);
process.exit(0);
