/**
 * Step 7 check: the task board.
 *
 *   pnpm check:board
 *
 * Offline. No harness, no model, no network.
 *
 *   1. Decomposition and waves: glob overlap, conflict graph, plan validation.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';

const { globsOverlap, scopesOverlap, planWaves, conflictEdges, DependencyCycleError } = await import(
  '../src/core/coordination/conflictGraph.js'
);
const { decompose, parsePlan, heuristicPlan, DecomposeError, requestFromPrompt, buildDecomposeUserPrompt } =
  await import('../src/core/coordination/decompose.js');
type TextModelAdapter = import('@htn/shared').TextModelAdapter;

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

function completer(replies: string[]): TextModelAdapter['complete'] & { calls: number } {
  let i = 0;
  const fn = (async () => {
    fn.calls += 1;
    const text = replies[Math.min(i++, replies.length - 1)]!;
    return {
      ok: true as const,
      data: { text, tokensIn: 10, tokensOut: 20 },
      meta: { provider: 'anthropic' as const, op: 'complete', mode: 'mock' as const, latencyMs: 0, destination: 'mock://' },
    };
  }) as unknown as TextModelAdapter['complete'] & { calls: number };
  fn.calls = 0;
  return fn;
}

console.log('1. decomposition and waves');

await test('glob overlap: ** vs a file under it, siblings, basenames, braces', () => {
  assert.equal(globsOverlap('src/**', 'src/a/x.ts'), true);
  assert.equal(globsOverlap('src/a/x.ts', 'src/**'), true);
  assert.equal(globsOverlap('src/a/**', 'src/b/**'), false);
  assert.equal(globsOverlap('src/*.ts', 'src/a.ts'), true);
  assert.equal(globsOverlap('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(globsOverlap('src/*.ts', 'src/*.css'), false);
  assert.equal(globsOverlap('src/a*.ts', 'src/*b.ts'), true);
  assert.equal(globsOverlap('**/*.test.ts', 'apps/api/x.test.ts'), true);
  assert.equal(globsOverlap('apps/{web,api}/**', 'apps/api/src/x.ts'), true);
  assert.equal(globsOverlap('apps/{web,api}/**', 'apps/docs/x.md'), false);
  // A slash-less glob matches a basename anywhere, as matchesGlob does.
  assert.equal(globsOverlap('index.ts', 'src/a/index.ts'), true);
  assert.equal(globsOverlap('README.md', 'src/**'), true);
  assert.equal(globsOverlap('src/a/x.ts', 'src/a/y.ts'), false);
  assert.equal(scopesOverlap(['a/**', 'b/x'], ['c/**', 'b/*']), true);
  assert.equal(scopesOverlap(['a/**'], ['c/**']), false);
});

await test('disjoint scopes -> one wave', () => {
  const waves = planWaves([
    { id: 'a', writeScope: ['src/a/**'], dependsOn: [] },
    { id: 'b', writeScope: ['src/b/**'], dependsOn: [] },
    { id: 'c', writeScope: ['src/c/**'], dependsOn: [] },
  ]);
  assert.deepEqual(waves, [['a', 'b', 'c']]);
});

await test('overlapping scopes -> split, plan order decides who goes first', () => {
  const nodes = [
    { id: 'a', writeScope: ['src/**'], dependsOn: [] },
    { id: 'b', writeScope: ['src/a/x.ts'], dependsOn: [] },
    { id: 'c', writeScope: ['docs/**'], dependsOn: [] },
  ];
  assert.deepEqual(conflictEdges(nodes), [['a', 'b']]);
  assert.deepEqual(planWaves(nodes), [['a', 'c'], ['b']]);
  assert.deepEqual(planWaves([nodes[1]!, nodes[0]!, nodes[2]!]), [['b', 'c'], ['a']]);
});

await test('dependency chain -> ordered waves; settled deps count as done', () => {
  const nodes = [
    { id: 'c', writeScope: ['src/c/**'], dependsOn: ['b'] },
    { id: 'b', writeScope: ['src/b/**'], dependsOn: ['a'] },
    { id: 'a', writeScope: ['src/a/**'], dependsOn: [] },
  ];
  assert.deepEqual(planWaves(nodes), [['a'], ['b'], ['c']]);
  assert.deepEqual(planWaves(nodes.slice(0, 2), ['a']), [['b'], ['c']]);
  // `deps` (a plan) works the same as `dependsOn` (a task).
  assert.deepEqual(
    planWaves([
      { id: 'x', writeScope: ['x/**'], deps: [] },
      { id: 'y', writeScope: ['y/**'], deps: ['x'] },
    ]),
    [['x'], ['y']],
  );
});

await test('a cycle throws DependencyCycleError', () => {
  assert.throws(
    () =>
      planWaves([
        { id: 'a', writeScope: ['a/**'], dependsOn: ['b'] },
        { id: 'b', writeScope: ['b/**'], dependsOn: ['a'] },
      ]),
    (e: unknown) => e instanceof DependencyCycleError && e.cycle.join(',') === 'a,b,a',
  );
});

await test('parsePlan: zod validation, unknown deps, self deps, cycles, Windows paths', () => {
  const ok = parsePlan({
    tasks: [
      { id: 'a', title: 'A', acceptance: 'tests pass', writeScope: ['src/a/**'] },
      { id: 'b', title: 'B', acceptance: 'tests pass', writeScope: ['src/b/**'], deps: ['a'] },
    ],
  });
  assert.deepEqual(ok[0]!.deps, []);
  const bad = (plan: unknown, pattern: RegExp) =>
    assert.throws(() => parsePlan(plan), (e: unknown) => e instanceof DecomposeError && pattern.test(e.message));
  const t = (id: string, deps: string[] = [], writeScope = ['src/' + id + '/**']) => ({
    id,
    title: id,
    acceptance: 'ok',
    writeScope,
    deps,
  });
  bad({ tasks: [t('a', ['b']), t('b', ['a'])] }, /cycle a -> b -> a/);
  bad({ tasks: [t('a', ['a'])] }, /depends on itself/);
  bad({ tasks: [t('a', ['zzz'])] }, /unknown task zzz/);
  bad({ tasks: [t('a'), t('a')] }, /duplicate/);
  bad({ tasks: [t('a', [], ['src\\a\\**'])] }, /validation/);
  bad({ tasks: [t('a', [], ['../outside/**'])] }, /validation/);
  bad({ tasks: [t('a', [], [])] }, /validation/);
  bad({ tasks: [] }, /validation/);
});

await test('decompose: planner reply is parsed; a rejected plan gets one repair attempt', async () => {
  const good = JSON.stringify({
    tasks: [{ id: 'a', title: 'A', acceptance: 'ok', writeScope: ['src/a/**'], deps: [] }],
  });
  const cyclic = JSON.stringify({
    tasks: [
      { id: 'a', title: 'A', acceptance: 'ok', writeScope: ['src/a/**'], deps: ['b'] },
      { id: 'b', title: 'B', acceptance: 'ok', writeScope: ['src/b/**'], deps: ['a'] },
    ],
  });
  const once = completer(['```json\n' + good + '\n```']);
  const r1 = await decompose({ runId: 'run_x', request: 'do a' }, { complete: once });
  assert.equal(r1.attempts, 1);
  assert.equal(r1.tasks[0]!.id, 'a');
  const repaired = completer([cyclic, good]);
  const r2 = await decompose({ runId: 'run_x', request: 'do a' }, { complete: repaired });
  assert.equal(r2.attempts, 2);
  assert.equal(repaired.calls, 2);
  await assert.rejects(
    decompose({ runId: 'run_x', request: 'do a' }, { complete: completer([cyclic]) }),
    (e: unknown) => e instanceof DecomposeError && /cycle/.test(e.message),
  );
  await assert.rejects(
    decompose({ runId: 'run_x', request: 'do a' }, { complete: completer(['not json']) }),
    DecomposeError,
  );
});

await test('mock planner: bullets -> disjoint tasks, "after n" -> dependency, round-trips the prompt', async () => {
  const request = '- Add a login form\n- Add a profile page\n- Wire analytics after 1';
  assert.equal(requestFromPrompt(buildDecomposeUserPrompt({ request, repoFiles: ['a.ts'] })), request);
  const plan = parsePlan(heuristicPlan(request));
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[2]!.deps, [plan[0]!.id]);
  assert.deepEqual(planWaves(plan), [[plan[0]!.id, plan[1]!.id], [plan[2]!.id]]);
  // The mock text model serves the same plan through the real decompose path.
  const { create } = await import('../src/providers/anthropic/index.js');
  const { config } = await import('../src/config.js');
  const model = create({ ...config.providers.anthropic, mode: 'mock' });
  const result = await decompose({ runId: 'run_mock', request }, { complete: model.complete.bind(model) });
  assert.deepEqual(result.tasks, plan);
});

console.log(`\n${passed} passed`);
