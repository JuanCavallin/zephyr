/**
 * Step 6 check: verification and evidence.
 *
 *   pnpm check:verify
 *
 * Offline. No harness, no model, no network.
 *
 *   1. Test inventory: two runners (js + pytest) in a fixture repo; import graph,
 *      name heuristic, coverage map.
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

await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
console.log(`\nverify: ${passed} passed`);
process.exit(0);
