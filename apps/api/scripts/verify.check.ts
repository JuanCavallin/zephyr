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
 *   5. Evidence bundle assembly and markdown rendering.
 *   6. Publish: full suite gate, one git.publish approval, PR body = evidence.md; an
 *      end-to-end mock-harness run over a real git worktree and a local bare remote.
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
/* ------------------------------ 5. evidence ----------------------------- */

console.log('evidence');
const { buildEvidence } = await import('../src/core/verify/evidence.js');
const { renderEvidence, GITHUB_BODY_LIMIT } = await import('../src/core/verify/render.js');
const { createEvidenceService } = await import('../src/services/evidence.service.js');
const { createMemoryStore } = await import('../src/store/memory.js');
const { evidenceBundleSchema } = await import('@htn/shared');
type RunEvent = import('@htn/shared').RunEvent;
type Run = import('@htn/shared').Run;
type EgressEvent = import('@htn/shared').EgressEvent;

const RUN = 'run_evidence';
const evidencePatch = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1111111..2222222 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1 +1,2 @@',
  '-export const add = (a, b) => a + b;',
  '+export const add = (a: number, b: number) => a + b;',
  '+export const sub = (a: number, b: number) => a - b;',
  'diff --git a/src/math.test.ts b/src/math.test.ts',
  'index 3333333..4444444 100644',
  '--- a/src/math.test.ts',
  '+++ b/src/math.test.ts',
  '@@ -1 +1,2 @@',
  ' expect(add(1, 2)).toBe(3);',
  '+expect(add(2, 2)).toBe(4);',
  'diff --git a/src/sub.test.ts b/src/sub.test.ts',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/src/sub.test.ts',
  '@@ -0,0 +1 @@',
  '+expect(sub(3, 1)).toBe(2);',
  '',
].join('\n');

const at = (s: number) => new Date(Date.UTC(2026, 10, 2, 12, 0, s)).toISOString();
function mockRunEvents(): RunEvent[] {
  const gw = (callId: string, input: number, output: number, write: number, read: number, cost?: number): RunEvent => ({
    type: 'gateway.call',
    runId: RUN,
    callId,
    model: 'claude-sonnet-5-5',
    status: 200,
    stream: true,
    usage: { inputTokens: input, outputTokens: output, cacheCreationInputTokens: write, cacheReadInputTokens: read },
    ...(cost === undefined ? {} : { costCents: cost }),
    runCacheHitRate: 0.5,
    toolUses: 1,
    at: at(5),
  });
  const approved = (approvalId: string, review: Record<string, unknown> | undefined): RunEvent =>
    ({
      type: 'tool.lifecycle',
      lifecycle: {
        id: 'tl_' + approvalId,
        runId: RUN,
        stepId: 'step_1',
        sessionStateId: 'ss_1',
        phase: 'approved',
        action: { id: 'act_' + approvalId, ...(review ? { review } : {}) },
        approvalId,
        at: at(7),
      },
    }) as unknown as RunEvent;
  const selected = [
    { id: 'src/math.test.ts', score: 0.92, fallback: false },
    { id: 'src/sub.test.ts', score: 0.81, fallback: false },
  ];
  return [
    { type: 'verify.tests', runId: RUN, phase: 'before', selected, source: 'jev', tally: { passed: 1, failed: 1, skipped: 0 }, at: at(2) },
    gw('call_1', 100, 50, 2000, 0, 1.25),
    { type: 'workspace.checkpoint', runId: RUN, turnId: 'turn_1', ref: 'refs/zephyr/checkpoints/run_evidence/1', treeHash: 'a'.repeat(40), at: at(10) },
    approved('apr_1', { protectedPath: 'src/math.test.ts', protection: 'existing-test', diff: '...' }),
    approved('apr_1', { protectedPath: 'src/math.test.ts', protection: 'existing-test', diff: '...' }),
    approved('apr_2', undefined),
    gw('call_2', 40, 30, 0, 2000),
    gw('call_other', 999, 999, 999, 999, 99),
    { type: 'workspace.checkpoint', runId: RUN, turnId: 'turn_2', ref: 'refs/zephyr/checkpoints/run_evidence/2', at: at(20) },
    { type: 'verify.tests', runId: RUN, phase: 'after', selected, source: 'jev', tally: { passed: 3, failed: 0, skipped: 1 }, at: at(25) },
  ].map((e) => (e.type === 'gateway.call' && 'callId' in e && e.callId === 'call_other' ? { ...e, runId: 'run_other' } : e)) as RunEvent[];
}
const mockEgress = [
  { destination: 'api.anthropic.com' },
  { destination: 'api.anthropic.com' },
  { destination: 'ai-gateway.vercel.sh' },
];

await test('assembly: a mock run populates every field from the trace and ledgers', () => {
  const b = buildEvidence({
    runId: RUN,
    taskId: 'task_1',
    events: mockRunEvents(),
    egress: mockEgress,
    diff: { patch: evidencePatch, hash: 'b'.repeat(64) },
    startedAt: at(0),
    endedAt: at(30),
    walkthrough: { previewUrl: 'http://localhost:5173/', steps: [{ description: 'open the calculator' }] },
    baseline: { tokensIn: 900, tokensOut: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costCents: 9, wallMs: 90_000 },
  });
  assert.ok(evidenceBundleSchema.safeParse(b).success);
  assert.match(b.id, /^evb_[0-9a-f]{16}$/);
  assert.equal(b.taskId, 'task_1');
  assert.deepEqual(b.diff, { files: 3, insertions: 4, deletions: 1, hash: 'b'.repeat(64) });
  assert.deepEqual(b.checkpoints.map((c) => c.turnId), ['turn_1', 'turn_2']);
  assert.deepEqual(b.tests.selected.map((s) => [s.id, s.score, s.fallback]), [
    ['src/math.test.ts', 0.92, false],
    ['src/sub.test.ts', 0.81, false],
  ]);
  assert.deepEqual(b.tests.before, { passed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(b.tests.after, { passed: 3, failed: 0, skipped: 1 });
  assert.deepEqual(b.tests.added, ['src/sub.test.ts']);
  assert.deepEqual(b.tests.modified, ['src/math.test.ts']);
  assert.deepEqual(b.protectedPathApprovals, [{ path: 'src/math.test.ts', approvalId: 'apr_1' }], 'deduped; non-protected approvals ignored');
  assert.deepEqual(b.usage, { tokensIn: 140, tokensOut: 80, cacheReadTokens: 2000, cacheWriteTokens: 2000, costCents: 1.25, wallMs: 30_000 });
  assert.equal(b.baseline?.tokensIn, 900);
  assert.deepEqual(b.egress, { calls: 3, destinations: ['ai-gateway.vercel.sh', 'api.anthropic.com'] });
  assert.equal(b.walkthrough?.steps.length, 1);
});

await test('assembly: missing optional sections (walkthrough, baseline, before) do not fail', () => {
  const events = mockRunEvents().filter((e) => !(e.type === 'verify.tests' && e.phase === 'before'));
  const b = buildEvidence({ runId: RUN, events, egress: [], diff: { patch: evidencePatch }, startedAt: at(0), endedAt: at(1) });
  assert.equal(b.walkthrough, undefined);
  assert.equal(b.baseline, undefined);
  assert.equal(b.tests.before, undefined);
  assert.match(b.diff.hash, /^[0-9a-f]{64}$/, 'hash falls back to sha256 of the patch');
  assert.deepEqual(b.egress, { calls: 0, destinations: [] });

  const bare = buildEvidence({ runId: RUN, events: [], egress: [], diff: { patch: '' }, startedAt: at(0), endedAt: at(0) });
  assert.deepEqual(bare.tests.after, { passed: 0, failed: 0, skipped: 0 });
  assert.deepEqual(bare.tests.selected, []);
  assert.deepEqual(bare.checkpoints, []);
});

await test('assembly: a full-suite run stands in for after; fallback selections keep their flag', () => {
  const sel = [{ id: 'src/math.test.ts', fallback: true }];
  const b = buildEvidence({
    runId: RUN,
    events: [{ type: 'verify.tests', runId: RUN, phase: 'full', selected: sel, source: 'full', tally: { passed: 9, failed: 0, skipped: 0 }, at: at(1) }],
    egress: [],
    diff: { patch: evidencePatch },
    startedAt: at(0),
    endedAt: at(2),
  });
  assert.deepEqual(b.tests.after, { passed: 9, failed: 0, skipped: 0 });
  assert.deepEqual(b.tests.selected, sel);
});

await test('service: assembleEvidence reads the store and workspace, writes evidence.json and evidence.md', async () => {
  const store = createMemoryStore({ persistToDisk: false });
  await store.createRun({ id: RUN, status: 'succeeded', createdAt: at(0), updatedAt: at(42) } as unknown as Run);
  for (const e of mockRunEvents()) await store.appendEvent(RUN, e);
  for (const [i, e] of mockEgress.entries())
    await store.appendEgress({ id: 'eg_' + i, runId: RUN, at: at(3), providerId: 'anthropic', op: 'messages', dataSpans: [], policyRule: 'r', decision: 'allowed', ...e } as EgressEvent);
  const evidenceDir = join(scratch, 'evidence');
  const service = createEvidenceService({
    store,
    workspaces: async () => ({ diff: async () => ({ stat: '', hash: 'c'.repeat(64), patch: evidencePatch }) }),
    evidenceDir,
    clock: () => at(50),
  });
  const bundle = await service.assembleEvidence(RUN);
  assert.equal(bundle.usage.wallMs, 42_000, 'a terminal run ends at updatedAt');
  assert.equal(bundle.diff.hash, 'c'.repeat(64));
  assert.equal(bundle.egress.calls, 3);

  const out = await service.produce(RUN);
  const { readFile } = await import('node:fs/promises');
  const written = JSON.parse(await readFile(out.path!, 'utf8'));
  assert.ok(evidenceBundleSchema.safeParse(written).success, 'evidence.json validates');
  assert.equal(await readFile(join(evidenceDir, RUN, 'evidence.md'), 'utf8'), out.markdown);

  const broken = createEvidenceService({
    store,
    workspaces: async () => ({ diff: async () => { throw new Error('workspace disposed'); } }),
    evidenceDir,
  });
  await assert.rejects(broken.assembleEvidence(RUN), /no diff for run/);
  await assert.rejects(service.assembleEvidence('run_missing'), /no run/);
});

function bigBundle(selectedCount: number) {
  return buildEvidence({
    runId: RUN,
    taskId: 'task_1',
    events: [
      ...mockRunEvents(),
      {
        type: 'verify.tests',
        runId: RUN,
        phase: 'after',
        selected: Array.from({ length: selectedCount }, (_, i) => ({ id: `src/generated/case_${String(i).padStart(5, '0')}.test.ts`, score: 0.5, fallback: false })),
        source: 'jev',
        tally: { passed: selectedCount, failed: 2, skipped: 0 },
        at: at(29),
      },
    ],
    egress: mockEgress,
    diff: { patch: evidencePatch },
    startedAt: at(0),
    endedAt: at(30),
  });
}

await test('render: header first, every section present when it fits', () => {
  const md = renderEvidence(buildEvidence({
    runId: RUN, taskId: 'task_1', events: mockRunEvents(), egress: mockEgress, diff: { patch: evidencePatch },
    startedAt: at(0), endedAt: at(30),
    walkthrough: { previewUrl: 'http://localhost:5173/', steps: [{ description: 'open the calculator', screenshotUrl: 'shots/1.png' }] },
  }));
  assert.ok(md.startsWith('## Zephyr evidence\n'));
  for (const needle of [
    'Run `run_evidence` · task `task_1`',
    '- **Diff:** 3 files, +4 −1',
    '- **Tests:** 3 passed, 0 failed, 1 skipped — all passing (before: 1 passed, 1 failed)',
    '- **Protected-path approvals:** 1',
    '140 in, 80 out, 2000 cache read, 2000 cache write · $0.0125 · 30.0 s',
    '- **Egress:** 3 calls to 2 destinations',
    '| `src/math.test.ts` | 0.92 | Jev |',
    '- added `src/sub.test.ts`',
    '- modified `src/math.test.ts`',
    '- `src/math.test.ts` — approval `apr_1`',
    '### Checkpoints (2)',
    '### Usage',
    '- `api.anthropic.com`',
    '### UI walkthrough',
    '([screenshot](shots/1.png))',
  ]) assert.ok(md.includes(needle), needle);
  assert.ok(!md.includes('cut for size') && !md.includes('Omitted for size'));
});

await test('render: stays under the host limit by truncating sections, never the header', () => {
  const b = bigBundle(5000);
  const full = renderEvidence(b, { limit: 10_000_000 });
  assert.ok(full.length > GITHUB_BODY_LIMIT, 'fixture overflows the GitHub limit');
  const md = renderEvidence(b);
  assert.ok(md.length <= GITHUB_BODY_LIMIT, `body ${md.length} <= ${GITHUB_BODY_LIMIT}`);
  const header = full.slice(0, full.indexOf('\n### '));
  assert.ok(md.startsWith(header), 'the header survives whole');
  assert.ok(md.includes('**2 failing**'));
  assert.match(md, /_… \d+ more lines cut for size; see `evidence.json`\._/);
  for (const small of ['- `src/math.test.ts` — approval `apr_1`', '### Usage', '- `api.anthropic.com`', '- added `src/sub.test.ts`'])
    assert.ok(md.includes(small), `a large section never pushes out a small one: ${small}`);
  assert.ok(md.trimEnd().endsWith('._'), 'footer kept');

  for (const limit of [3000, 1500, 1200]) {
    const small = renderEvidence(b, { limit });
    assert.ok(small.length <= limit, `limit ${limit}: ${small.length}`);
    assert.ok(small.startsWith(header));
  }
  const tiny = renderEvidence(b, { limit: 10 });
  assert.ok(tiny.startsWith(header), 'a limit below the header still emits the header whole');
});

// ---------------------------------------------------------------------------
// 6. Publish: full suite gate, one approval through the bridge, body = evidence.md
// ---------------------------------------------------------------------------
console.log('publish');

const { publishRun, publishCommands, displayCommand } = await import('../src/core/verify/publish.js');
const { ApprovalRejectedError } = await import('../src/core/approvalGate.js');
type PublishDeps = import('../src/core/verify/publish.js').PublishDeps;
type PublishInput = import('../src/core/verify/publish.js').PublishInput;
type CodingEvent = import('@htn/shared').CodingEvent;

const PUB_RUN = 'run_publish';
const HASH = 'd'.repeat(64);
const pubInput = (over: Partial<PublishInput> = {}): PublishInput => ({
  runId: PUB_RUN,
  worktree: scratch,
  branch: 'zephyr/' + PUB_RUN,
  base: 'main',
  title: 'Add the calculator',
  ...over,
});

function publishHarness(opts: {
  reject?: boolean;
  suite?: { passed: number; failed: number; skipped?: number; failedTests?: string[]; exitCode?: number | null };
  failExec?: string;
  dirty?: boolean;
  /** Change the worktree hash once the approval is granted. */
  driftAfterApproval?: boolean;
} = {}) {
  let hash = HASH;
  const asked: ToolAction[] = [];
  const calls: [string, string[]][] = [];
  const events: CodingEvent[] = [];
  const lifecycle: string[] = [];
  const suiteCalls: number[] = [];
  const binding = async () => ({ branch: 'zephyr/' + PUB_RUN, diffHash: hash });
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree: scratch,
    run: { runId: PUB_RUN, stepId: 'step_pub' },
    publishBinding: binding,
    approvals: {
      async request({ action }) {
        asked.push(action);
        if (opts.reject) throw new ApprovalRejectedError('apr_pub', 'not yet');
        if (opts.driftAfterApproval) hash = 'e'.repeat(64);
        return { approvalId: 'apr_pub' };
      },
    },
    onLifecycle: async (l) => {
      lifecycle.push(l.phase);
    },
  });
  const deps: PublishDeps = {
    bridge,
    sessionId: 'ses_pub',
    binding,
    evidence: async () => ({ bundleId: 'evb_1', diffHash: HASH, bodyPath: join(scratch, 'evidence.md') }),
    exec: async (file, args) => {
      calls.push([file, args]);
      if (opts.failExec && args[0] === opts.failExec) return { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' };
      return file === 'gh'
        ? { code: 0, stdout: 'Creating pull request\nhttps://github.com/acme/app/pull/7\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
    emit: async (e) => {
      events.push(e);
    },
    ...(opts.dirty !== undefined ? { dirty: async () => opts.dirty! } : {}),
    ...(opts.suite
      ? {
          runFullSuite: async () => {
            suiteCalls.push(1);
            const s = opts.suite!;
            return {
              tally: { passed: s.passed, failed: s.failed, skipped: s.skipped ?? 0 },
              ...(s.failedTests ? { failedTests: s.failedTests } : {}),
              ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
            };
          },
        }
      : {}),
  };
  return { deps, asked, calls, events, lifecycle, suiteCalls };
}

const fullSuite = { fullSuiteBeforePublish: true };

await test('publish: a failing full suite blocks before approval and before any git call', async () => {
  const h = publishHarness({ suite: { passed: 40, failed: 2, failedTests: ['src/a.test.ts', 'src/b.test.ts'], exitCode: 1 } });
  const r = await publishRun(pubInput({ policy: fullSuite }), h.deps);
  assert.equal(r.status, 'blocked');
  assert.equal(r.status === 'blocked' && r.stage, 'full-suite');
  assert.match(r.status === 'blocked' ? r.reason : '', /2 tests failing: src\/a\.test\.ts, src\/b\.test\.ts/);
  assert.deepEqual(r.fullSuite, { passed: 40, failed: 2, skipped: 0 });
  assert.equal(h.asked.length, 0, 'no approval is requested');
  assert.equal(h.calls.length, 0, 'nothing is pushed');
  const ev = h.events.find((e) => e.type === 'verify.tests');
  assert.ok(ev && ev.type === 'verify.tests');
  assert.equal(ev.phase, 'full');
  assert.equal(ev.source, 'full');
  assert.deepEqual(ev.failedTests, ['src/a.test.ts', 'src/b.test.ts']);
});

await test('publish: a runner that exits non-zero with no counted failure still blocks', async () => {
  const h = publishHarness({ suite: { passed: 0, failed: 0, exitCode: 2 } });
  const r = await publishRun(pubInput({ policy: fullSuite }), h.deps);
  assert.equal(r.status === 'blocked' && r.stage, 'full-suite');
  assert.match(r.status === 'blocked' ? r.reason : '', /exited 2/);
  assert.equal(h.calls.length, 0);
});

await test('publish: the policy needs the full suite but no runner is bound → blocked', async () => {
  const h = publishHarness();
  const r = await publishRun(pubInput({ policy: fullSuite }), h.deps);
  assert.equal(r.status === 'blocked' && r.stage, 'full-suite');
  assert.equal(h.asked.length + h.calls.length, 0);
});

await test('publish: green full suite → one git.publish approval bound to the diff, push, PR with --body-file', async () => {
  const h = publishHarness({ suite: { passed: 42, failed: 0, exitCode: 0 } });
  const r = await publishRun(pubInput({ policy: fullSuite }), h.deps);
  assert.equal(r.status, 'published', JSON.stringify(r));
  assert.ok(r.status === 'published');
  assert.equal(r.prUrl, 'https://github.com/acme/app/pull/7');
  assert.equal(r.approvalId, 'apr_pub');
  assert.equal(r.diffHash, HASH);
  assert.deepEqual(r.fullSuite, { passed: 42, failed: 0, skipped: 0 });

  assert.equal(h.asked.length, 1, 'exactly one approval');
  const action = h.asked[0]!;
  assert.equal(action.toolId, 'git.publish');
  assert.equal(action.operation, 'pr.create');
  assert.deepEqual(action.review, { operation: 'pr.create', branch: 'zephyr/' + PUB_RUN, diffHash: HASH });
  const approvedText = String((action.arguments as { command?: string }).command);
  assert.ok(approvedText.includes('git push -u origin zephyr/run_publish && gh pr create'), approvedText);
  assert.ok(approvedText.includes("--title 'Add the calculator'"), 'the title is quoted in the approved text');

  const bodyPath = join(scratch, 'evidence.md');
  assert.deepEqual(h.calls, publishCommands(pubInput(), bodyPath));
  assert.deepEqual(h.calls.map(([f, a]) => f + ' ' + a[0]), ['git push', 'gh pr']);
  const gh = h.calls[1]![1];
  assert.equal(gh[gh.indexOf('--body-file') + 1], bodyPath, 'the PR body is evidence.md');
  assert.ok(h.lifecycle.includes('awaiting_approval') && h.lifecycle.includes('approved') && h.lifecycle.includes('succeeded'));
});

await test('publish: policy off never runs the suite', async () => {
  const h = publishHarness({ suite: { passed: 0, failed: 5 } });
  const r = await publishRun(pubInput({ policy: { fullSuiteBeforePublish: false } }), h.deps);
  assert.equal(r.status, 'published');
  assert.equal(h.suiteCalls.length, 0);
  assert.equal(h.events.length, 0);
});

await test('publish: a dirty worktree is committed first, inside the same approval', async () => {
  const h = publishHarness({ dirty: true });
  const r = await publishRun(pubInput(), h.deps);
  assert.equal(r.status, 'published');
  assert.deepEqual(h.calls.map(([f, a]) => f + ' ' + a[0]), ['git add', 'git commit', 'git push', 'gh pr']);
  assert.equal(h.asked.length, 1);
  const text = String((h.asked[0]!.arguments as { command?: string }).command);
  assert.ok(text.startsWith("git add -A -- . && git commit -m 'Add the calculator' && git push"), text);
});

await test('publish: a reviewer rejection blocks with no git call', async () => {
  const h = publishHarness({ reject: true });
  const r = await publishRun(pubInput(), h.deps);
  assert.equal(r.status === 'blocked' && r.stage, 'approval');
  assert.equal(r.status === 'blocked' && r.reason, 'rejected by reviewer');
  assert.equal(h.calls.length, 0);
  assert.ok(h.lifecycle.includes('blocked'));
});

await test('publish: a diff that moves after approval is not published', async () => {
  const h = publishHarness({ driftAfterApproval: true });
  const r = await publishRun(pubInput(), h.deps);
  assert.equal(r.status === 'blocked' && r.stage, 'diff-changed');
  assert.equal(h.calls.length, 0);
});

await test('publish: a failed push stops before the PR and reports the failure', async () => {
  const h = publishHarness({ failExec: 'push' });
  const r = await publishRun(pubInput(), h.deps);
  assert.equal(r.status === 'blocked' && r.stage, 'push');
  assert.match(r.status === 'blocked' ? r.reason : '', /non-fast-forward/);
  assert.deepEqual(h.calls.map(([f]) => f), ['git']);
  assert.ok(h.lifecycle.includes('failed'));
});

await test('publish: displayCommand quotes for a POSIX shell', () => {
  assert.equal(displayCommand('git', ['push', '-u', 'origin', 'zephyr/r1']), 'git push -u origin zephyr/r1');
  assert.equal(displayCommand('gh', ['pr', 'create', '--title', "it's done"]), "gh pr create --title 'it'\\''s done'");
  assert.equal(displayCommand('gh', ['--body-file', 'C:\\tmp\\e.md']), "gh --body-file 'C:\\tmp\\e.md'");
});

// --- End to end: a mock-harness run edits code; evidence.json + evidence.md; the PR
// body is evidence.md. Real git (worktree, push to a local bare remote); `gh` stubbed.
await test('e2e: mock harness edits a worktree → evidence.json + evidence.md → push + PR body', async () => {
  const { execArgv } = await import('../src/services/publish.service.js');
  const { createLiveGitWorkspaces } = await import('../src/providers/git/live.js');
  const { createMockHarness } = await import('../src/providers/mockharness/index.js');
  const { readFile } = await import('node:fs/promises');
  const e2e = join(scratch, 'e2e');
  const origin = join(e2e, 'origin.git');
  const repoRoot = join(e2e, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const git = async (cwd: string, ...args: string[]) => {
    const r = await execArgv('git', args, { cwd });
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  await git(e2e, 'init', '--bare', '-q', origin);
  await git(repoRoot, 'init', '-q', '-b', 'main');
  await git(repoRoot, 'config', 'user.name', 'Zephyr Check');
  await git(repoRoot, 'config', 'user.email', 'check@zephyr.invalid');
  await git(repoRoot, 'config', 'commit.gpgsign', 'false');
  await writeTree(repoRoot, { 'README.md': '# fixture\n', 'src/index.ts': 'export {};\n' });
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, 'commit', '-q', '-m', 'init');
  await git(repoRoot, 'remote', 'add', 'origin', origin);

  const runId = 'run_e2e_publish';
  const workspaces = createLiveGitWorkspaces({ repoRoot, workspacesDir: join(e2e, 'workspaces') });
  const { path: worktree, branch } = await workspaces.create(runId, 'main');

  // The harness run: every tool call goes through the bridge; reads/writes are auto.
  const harnessBridge = createPermissionBridge({ harness: 'claudecode', worktree, authorize: allowAuth, run: { runId, stepId: 'step_e2e' } });
  const harness = createMockHarness({ decide: (req) => harnessBridge.handler({ ...req, harness: 'claudecode' }) });
  const hctx = { runId, policyRule: 'check' } as Parameters<typeof harness.pollTask>[1];
  const started = await harness.startTask({ goal: 'add the calculator', context: { workspaceDir: worktree, taskId: 'task_e2e' } }, hctx);
  assert.ok(started.ok);
  const taskId = (started.data as { taskId: string }).taskId;
  let status = 'running';
  for (let i = 0; i < 10 && status === 'running'; i++) {
    const p = await harness.pollTask(taskId, hctx);
    assert.ok(p.ok);
    status = (p.data as { status: string }).status;
  }
  assert.equal(status, 'done');
  assert.equal(await readFile(join(worktree, 'src/add-the-calculator.ts'), 'utf8'), '// add the calculator\nexport const done = true;\n');

  // Evidence from the run's events and the live worktree diff.
  const store = createMemoryStore({ persistToDisk: false });
  await store.createRun({ id: runId, status: 'succeeded', createdAt: at(0), updatedAt: at(20) } as unknown as Run);
  await store.appendEvent(runId, {
    type: 'verify.tests', runId, phase: 'after', selected: [{ id: 'src/index.test.ts', score: 0.81, fallback: false }],
    source: 'jev', tally: { passed: 3, failed: 0, skipped: 0 }, at: at(18),
  } as RunEvent);
  const evidenceDir = join(e2e, 'evidence');
  const service = createEvidenceService({ store, workspaces: async () => workspaces, evidenceDir });
  const liveDiff = await workspaces.diff(runId);

  // Publish with real git; `gh` is stubbed and reads the body file it is handed.
  let prBody: string | undefined;
  const binding = async () => ({ branch, diffHash: (await workspaces.diff(runId)).hash });
  const asked: ToolAction[] = [];
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree,
    run: { runId, stepId: 'step_publish' },
    publishBinding: binding,
    approvals: { async request({ action }) { asked.push(action); return { approvalId: 'apr_e2e' }; } },
  });
  const r = await publishRun(
    { runId, worktree, branch, base: 'main', title: 'Add the calculator', policy: { fullSuiteBeforePublish: false } },
    {
      bridge,
      sessionId: 'ses_e2e',
      binding,
      evidence: async () => {
        const out = await service.produce(runId);
        return { bundleId: out.bundle.id, diffHash: out.bundle.diff.hash, bodyPath: out.markdownPath! };
      },
      dirty: async () => (await git(worktree, 'status', '--porcelain', '--untracked-files=all')).trim().length > 0,
      exec: async (file, args, o) => {
        if (file !== 'gh') return execArgv(file, args, o);
        prBody = await readFile(args[args.indexOf('--body-file') + 1]!, 'utf8');
        return { code: 0, stdout: 'https://github.com/acme/fixture/pull/1\n', stderr: '' };
      },
      emit: async () => {},
    },
  );
  assert.equal(r.status, 'published', JSON.stringify(r));
  assert.ok(r.status === 'published');
  assert.equal(r.diffHash, liveDiff.hash);
  assert.equal(asked.length, 1);
  assert.equal((asked[0]!.review as { diffHash: string }).diffHash, liveDiff.hash, 'the approval binds the live diff hash');

  const json = JSON.parse(await readFile(join(evidenceDir, runId, 'evidence.json'), 'utf8'));
  assert.ok(evidenceBundleSchema.safeParse(json).success, 'evidence.json validates');
  assert.equal(json.diff.hash, liveDiff.hash);
  assert.equal(json.diff.files, 1);
  const md = await readFile(join(evidenceDir, runId, 'evidence.md'), 'utf8');
  assert.ok(md.startsWith('## Zephyr evidence\n'));
  assert.ok(md.includes('| `src/index.test.ts` | 0.81 | Jev |'));
  assert.equal(prBody, md, 'the PR body is the rendered bundle');

  // The pushed branch holds exactly the approved tree.
  const pushedTree = (await git(origin, 'rev-parse', `refs/heads/${branch}^{tree}`)).trim();
  const baseTree = (await git(origin, 'rev-parse', 'refs/heads/main^{tree}').catch(() => '')).trim();
  const committed = await git(repoRoot, 'diff', '--binary', '--full-index', 'main', pushedTree);
  assert.notEqual(pushedTree, baseTree);
  assert.equal(committed, liveDiff.patch, 'pushed diff == approved diff');

  await workspaces.dispose(runId, false).catch(() => undefined);
});

await rm(scratch, { recursive: true, force: true }).catch(() => undefined);

console.log(`\nverify: ${passed} passed`);
process.exit(0);
