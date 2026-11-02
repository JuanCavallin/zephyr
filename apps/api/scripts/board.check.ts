/**
 * Step 7 check: the task board.
 *
 *   pnpm check:board
 *
 * Offline. No harness, no model, no network.
 *
 *   1. Decomposition and waves: glob overlap, conflict graph, plan validation.
 *   2. State machine and derived progress.
 *   3. Leases: grant, deny reasons, extension, expiry, hot files, broker integration.
 *   4. Hot-file intents: typed appliers, serial integrator, concurrent package.json edits.
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
const { transition, canTransition, IllegalTransitionError, ProgressTracker, budgetBreach, TASK_TRANSITIONS } =
  await import('../src/core/coordination/stateMachine.js');
type TextModelAdapter = import('@htn/shared').TextModelAdapter;
type Task = import('@htn/shared').Task;
type RunEvent = import('@htn/shared').RunEvent;

const T0 = '2026-11-02T00:00:00.000Z';
function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    boardRunId: 'run_board',
    title: id,
    acceptance: 'tests pass',
    writeScope: ['src/' + id + '/**'],
    dependsOn: [],
    status: 'pending',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

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

console.log('2. state machine and progress');

await test('legal path pending -> ready -> running -> review -> done; events carry taskId', () => {
  let task = makeTask('t1');
  const seen: string[] = [];
  for (const to of ['ready', 'running', 'review', 'done'] as const) {
    const r = transition(task, to, { at: T0 });
    assert.equal(r.event.taskId, 't1');
    assert.equal(r.event.from, task.status);
    assert.equal(r.event.to, to);
    task = r.task;
    seen.push(task.status);
  }
  assert.deepEqual(seen, ['ready', 'running', 'review', 'done']);
});

await test('illegal transitions throw; blocked/failed need a reason; leaving blocked clears it', () => {
  const statuses = Object.keys(TASK_TRANSITIONS) as (keyof typeof TASK_TRANSITIONS)[];
  let illegal = 0;
  for (const from of statuses)
    for (const to of statuses) {
      if (canTransition(from, to)) continue;
      illegal++;
      assert.throws(
        () => transition(makeTask('t', { status: from }), to, { at: T0, reason: 'r' }),
        IllegalTransitionError,
      );
    }
  assert.ok(illegal > 20);
  assert.throws(() => transition(makeTask('t'), 'running', { at: T0 }), /cannot go from pending to running/);
  assert.throws(() => transition(makeTask('t', { status: 'done' }), 'ready', { at: T0 }), IllegalTransitionError);
  assert.throws(() => transition(makeTask('t', { status: 'running' }), 'blocked', { at: T0 }), /needs a reason/);
  const blocked = transition(makeTask('t', { status: 'running' }), 'blocked', { at: T0, reason: 'stuck' });
  assert.equal(blocked.task.reason, 'stuck');
  assert.equal(blocked.event.reason, 'stuck');
  assert.equal(transition(blocked.task, 'ready', { at: T0 }).task.reason, undefined);
});

await test('progress is derived from observations; agent text cannot set it', () => {
  const tracker = new ProgressTracker('t1', 'run_t1', 0);
  const lies: RunEvent[] = [
    { type: 'log', runId: 'run_t1', level: 'info', message: 'progress: 100% - 50/50 tests passed, 9 files changed', at: T0 },
    { type: 'harness.turn', turn: { text: 'All done! testsPassed=99 filesChanged=12' } as never },
    {
      type: 'task.progress',
      taskId: 't1',
      progress: { testsPassed: 9, testsTotal: 9, filesChanged: 9, tokens: 9, turns: 9 },
      at: T0,
    },
  ];
  for (const e of lies) assert.equal(tracker.observe(e, 1), false);
  assert.deepEqual(tracker.snapshot(), { testsPassed: 0, testsTotal: 0, filesChanged: 0, tokens: 0, turns: 0 });

  const turn = (taskId: string): RunEvent => ({
    type: 'harness.turn.ended',
    runId: 'run_t1',
    sessionId: 's',
    turnId: 'u',
    harness: 'mockharness',
    stopReason: 'end_turn',
    taskId,
    at: T0,
  });
  const call = (runId: string, inputTokens: number): RunEvent =>
    ({
      type: 'gateway.call',
      runId,
      callId: 'c',
      status: 200,
      stream: false,
      usage: { inputTokens, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      at: T0,
    }) as RunEvent;
  tracker.observe(turn('t1'), 2);
  tracker.observe(turn('other'), 2);
  tracker.observe(call('run_t1', 100), 3);
  tracker.observe(call('run_other', 999), 3);
  tracker.observe(
    {
      type: 'verify.tests',
      runId: 'run_t1',
      phase: 'after',
      selected: [],
      source: 'fallback',
      tally: { passed: 3, failed: 1, skipped: 0 },
      at: T0,
    },
    4,
  );
  tracker.observeFiles(['src/t1/a.ts', 'src/t1/b.ts', 'src/t1/a.ts'], 5);
  assert.deepEqual(tracker.snapshot(), { testsPassed: 3, testsTotal: 4, filesChanged: 2, tokens: 120, turns: 1 });
});

await test('stuck or over budget -> a breach reason', () => {
  const tracker = new ProgressTracker('t1', undefined, 0);
  assert.equal(budgetBreach(tracker, { maxTurns: 2, stuckMs: 1000 }, 500), null);
  assert.match(budgetBreach(tracker, { stuckMs: 1000 }, 5000)!, /^stuck/);
  tracker.observeTurn(5000);
  tracker.observeTurn(5000);
  tracker.observeTurn(5000);
  assert.match(budgetBreach(tracker, { maxTurns: 2, stuckMs: 1000 }, 5001)!, /over budget: 3 turns/);
  tracker.observeTokens(50, 5002);
  assert.match(budgetBreach(tracker, { maxTokens: 10 }, 5002)!, /over budget: 50 tokens/);
});

console.log('3. leases');

const { LeaseTable, isHotFile } = await import('../src/core/coordination/leases.js');
const { createPermissionBridge } = await import('../src/core/tools/permissionBridge.js');
type AuthorizationDecision = import('@htn/shared').AuthorizationDecision;
type NativeToolRequest = import('@htn/shared').NativeToolRequest;
type LeaseEvent = import('../src/core/coordination/leases.js').LeaseEvent;

function leaseTable(ttlMs = 60_000) {
  const clock = { now: Date.parse(T0) };
  const events: LeaseEvent[] = [];
  const table = new LeaseTable({ ttlMs, now: () => clock.now, onEvent: (e) => events.push(e) });
  return { table, clock, events };
}

await test('hot files are recognised and never leased', () => {
  for (const p of [
    'package.json',
    'apps/web/package.json',
    'pnpm-lock.yaml',
    'apps/api/src/api/index.ts',
    'packages/shared/src/coding.ts',
    'apps/api/src/app.ts',
  ])
    assert.equal(isHotFile(p), true, p);
  for (const p of ['src/a/x.ts', 'apps/web/src/board/Board.tsx', 'apps/api/src/core/coordination/leases.ts'])
    assert.equal(isHotFile(p), false, p);
  const { table } = leaseTable();
  const r = table.acquire('t1', ['src/a/**', 'package.json']);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'hot_file');
  assert.ok(table.acquire('t1', ['**']).ok, 'a broad glob is fine; hot files inside it are still denied');
  const d = table.checkLease('t1', 'apps/web/package.json', 'write');
  assert.equal(d.allowed, false);
  assert.equal(!d.allowed && d.reason, 'hot_file');
});

await test('grant, inside -> allow, outside / other / none -> each deny reason; reads are free', () => {
  const { table, events } = leaseTable();
  assert.ok(table.acquire('t1', ['src/a/**']).ok);
  assert.ok(table.acquire('t2', ['src/b/**']).ok);
  const overlap = table.acquire('t3', ['src/**']);
  assert.equal(overlap.ok, false);
  assert.deepEqual(!overlap.ok && overlap.heldBy, ['t1', 't2']);

  assert.equal(table.checkLease('t1', 'src/a/x.ts', 'write').allowed, true);
  const reason = (d: ReturnType<typeof table.checkLease>) => (d.allowed ? 'allowed' : d.reason);
  assert.equal(reason(table.checkLease('t1', 'src/c/x.ts', 'write')), 'outside_lease');
  const other = table.checkLease('t1', 'src/b/y.ts', 'write');
  assert.equal(reason(other), 'held_by_other');
  assert.equal(!other.allowed && other.heldBy, 't2');
  assert.equal(reason(table.checkLease('t9', 'src/z.ts', 'write')), 'no_lease');
  assert.equal(reason(table.checkLease('t1', '../etc/passwd', 'write')), 'invalid_path');
  assert.equal(reason(table.checkLease('t1', 'C:\\x\\y.ts', 'write')), 'invalid_path');
  assert.equal(reason(table.checkLease('t9', 'src/b/y.ts', 'read')), 'allowed');
  assert.equal(events.filter((e) => e.type === 'lease.denied').length, 5);
  assert.equal(events.filter((e) => e.type === 'lease.granted').length, 2);
});

await test('extension: auto-granted without overlap; queued with overlap; drains on release', () => {
  const { table, events } = leaseTable();
  table.acquire('t1', ['src/a/**']);
  table.acquire('t2', ['src/b/**']);
  const free = table.requestExtension('t1', ['src/shared/util.ts']);
  assert.equal(free.status, 'granted');
  assert.equal(table.checkLease('t1', 'src/shared/util.ts', 'write').allowed, true);
  assert.equal(events.filter((e) => e.type === 'lease.extended').length, 1);

  const blocked = table.requestExtension('t1', ['src/b/shared.ts']);
  assert.equal(blocked.status, 'queued');
  if (blocked.status !== 'queued') return;
  assert.deepEqual(blocked.request.blockedBy, ['t2']);
  assert.equal(table.pending().length, 1);
  assert.equal(table.checkLease('t1', 'src/b/shared.ts', 'write').allowed, false);
  // Approving while t2 still holds it keeps it queued: two live leases never overlap.
  assert.equal(table.decideExtension(blocked.request.id, 'approve')?.status, 'queued');
  table.release('t2');
  assert.equal(table.pending().length, 0);
  assert.equal(table.checkLease('t1', 'src/b/shared.ts', 'write').allowed, true);

  table.acquire('t3', ['src/c/**']);
  const q = table.requestExtension('t3', ['src/a/**']);
  assert.equal(q.status, 'queued');
  if (q.status !== 'queued') return;
  assert.equal(table.decideExtension(q.request.id, 'reject')?.status, 'rejected');
  assert.equal(table.pending().length, 0);
  assert.equal(table.requestExtension('t9', ['src/q/**']).status, 'rejected');
  assert.equal(table.requestExtension('t3', ['pnpm-lock.yaml']).status, 'rejected');
});

await test('leases expire; renew keeps them; resume re-requests', () => {
  const { table, clock, events } = leaseTable(1000);
  table.acquire('t1', ['src/a/**']);
  table.acquire('t2', ['src/b/**']);
  clock.now += 600;
  assert.equal(table.renew('t1'), true);
  clock.now += 600; // t2 lapsed at +1000; t1 was renewed to +1600
  const d = table.checkLease('t2', 'src/b/x.ts', 'write');
  assert.equal(!d.allowed && d.reason, 'no_lease');
  assert.equal(table.checkLease('t1', 'src/a/x.ts', 'write').allowed, true);
  assert.deepEqual(
    events.filter((e) => e.type === 'lease.expired').map((e) => e.taskId),
    ['t2'],
  );
  assert.equal(table.renew('t2'), false);
  assert.ok(table.acquire('t2', ['src/b/**']).ok, 'resume re-requests the lapsed lease');
  assert.equal(table.checkLease('t2', 'src/b/x.ts', 'write').allowed, true);
  clock.now += 5000;
  assert.equal(table.live().length, 0);
});

const allowAuth = async (): Promise<AuthorizationDecision> =>
  ({
    actionId: 'check',
    recommendation: 'auto',
    finalPolicy: 'auto',
    allowed: true,
    reasonCodes: [],
    at: new Date().toISOString(),
  }) as unknown as AuthorizationDecision;
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const scratch = await mkdtemp(join(tmpdir(), 'board-check-'));

await test('the broker denies an out-of-lease edit with the lease reason; board-less writes are unchanged', async () => {
  const { table } = leaseTable();
  table.acquire('t1', ['src/a/**']);
  table.acquire('t2', ['src/b/**']);
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree: scratch,
    authorize: allowAuth,
    run: { runId: 'r', stepId: 's' },
    leases: table,
  });
  const write = (path: string, taskId?: string): NativeToolRequest =>
    ({
      harness: 'claudecode',
      toolName: 'Write',
      rawInput: { file_path: path, content: 'x' },
      sessionId: 'sess',
      ...(taskId ? { taskId } : {}),
    }) as NativeToolRequest;
  const ok = await bridge.decide(write('src/a/x.ts', 't1'));
  assert.equal(ok.verdict, 'allow');
  assert.equal(ok.lease?.allowed, true);
  const out = await bridge.decide(write('src/b/x.ts', 't1'));
  assert.equal(out.verdict, 'deny');
  assert.match(out.reason, /^lease held_by_other: .*t2/);
  const hot = await bridge.decide(write('package.json', 't1'));
  assert.equal(hot.verdict, 'deny');
  assert.match(hot.reason, /hot_file.*HotFileIntent/);
  const read = await bridge.decide({
    harness: 'claudecode',
    toolName: 'Read',
    rawInput: { file_path: 'src/b/x.ts' },
    sessionId: 'sess',
    taskId: 't1',
  } as NativeToolRequest);
  assert.equal(read.verdict, 'allow');
  assert.equal((await bridge.decide(write('src/b/x.ts'))).verdict, 'allow', 'no taskId: not a board task');
});

console.log('4. hot-file intents');

const { Integrator, worktreeFs } = await import('../src/core/coordination/integrator.js');
const { applyAddDependency, applyExportSymbol, IntentRejectedError } = await import(
  '../src/core/coordination/intents.js'
);
const { codingEventSchema } = await import('@htn/shared');
const { readFile: readText, writeFile: writeText, mkdir } = await import('node:fs/promises');

await test('add_dependency keeps indent, EOL and sorted keys; is idempotent; refuses a version change', () => {
  const crlf = '{\r\n    "name": "x",\r\n    "dependencies": {\r\n        "zod": "^4.0.0"\r\n    }\r\n}\r\n';
  const next = applyAddDependency(crlf, { name: 'express', version: '^5.1.0' });
  assert.ok(next.endsWith('}\r\n'));
  assert.ok(next.includes('\r\n    "dependencies"'), 'four-space indent kept');
  assert.deepEqual(Object.keys(JSON.parse(next).dependencies), ['express', 'zod']);
  assert.equal(applyAddDependency(next, { name: 'express', version: '^5.1.0' }), next, 'idempotent');
  assert.throws(() => applyAddDependency(next, { name: 'express', version: '^4.0.0' }), IntentRejectedError);
  assert.throws(() => applyAddDependency(next, { name: 'zod', version: '^4.0.0', dev: true }), IntentRejectedError);
  assert.throws(() => applyAddDependency(next, { name: 'x; rm -rf /', version: '1' }), IntentRejectedError);
  assert.throws(() => applyAddDependency('not json', { name: 'a', version: '1' }), IntentRejectedError);
  const dev = JSON.parse(applyAddDependency('{"name":"x"}\n', { name: 'tsx', version: '^4', dev: true }));
  assert.deepEqual(dev.devDependencies, { tsx: '^4' });
});

await test('export_symbol appends once', () => {
  const a = applyExportSymbol("export * from './a.js';\n", { from: './board.js', symbols: ['Board', 'Lane'] });
  assert.equal(a, "export * from './a.js';\nexport { Board, Lane } from './board.js';\n");
  assert.equal(applyExportSymbol(a, { from: './board.js', symbols: ['Board', 'Lane'] }), a);
  assert.equal(applyExportSymbol('', { from: './x.js' }), "export * from './x.js';\n");
  assert.throws(() => applyExportSymbol('', { from: 'lodash' }), IntentRejectedError);
});

await test('two concurrent package.json intents both land, in submission order, as valid JSON', async () => {
  const root = join(scratch, 'integration');
  await mkdir(root, { recursive: true });
  await writeText(join(root, 'package.json'), '{\n  "name": "demo",\n  "dependencies": {}\n}\n');
  const base = worktreeFs(root);
  const writes: string[] = [];
  // A slow read widens the race window: without the lock, the second intent would read
  // the file before the first wrote it and one dependency would be lost.
  const fs = {
    read: async (p: string) => {
      const v = await base.read(p);
      await new Promise((r) => setTimeout(r, 20));
      return v;
    },
    write: async (p: string, c: string) => {
      writes.push(JSON.stringify(Object.keys(JSON.parse(c).dependencies ?? {})));
      await base.write(p, c);
    },
  };
  const updates: Array<{ status: string; error?: string }> = [];
  const integrator = new Integrator({
    fs,
    onUpdate: (intent, error) => {
      assert.ok(codingEventSchema.safeParse({ type: 'intent.updated', intent, ...(error ? { error } : {}) }).success);
      updates.push({ status: intent.status, ...(error ? { error } : {}) });
    },
  });
  const [a, b, c, d] = await Promise.all([
    integrator.submit({
      taskId: 't1', path: 'package.json', kind: 'add_dependency',
      description: 'add zod@4', payload: { name: 'zod', version: '^4.0.0' },
    }),
    integrator.submit({
      taskId: 't2', path: 'package.json', kind: 'add_dependency',
      description: 'add express@5', payload: { name: 'express', version: '^5.1.0' },
    }),
    integrator.submit({
      taskId: 't3', path: 'package.json', kind: 'register_route',
      description: 'register /api/board', payload: { route: '/api/board' },
    }),
    integrator.submit({ taskId: 't3', path: 'src/a/x.ts', kind: 'other', description: 'not hot' }),
  ]);
  assert.deepEqual([a.status, b.status, c.status, d.status], ['applied', 'applied', 'rejected', 'rejected']);
  assert.deepEqual(writes, ['["zod"]', '["express","zod"]'], 'serial, in submission order');
  const pkg = JSON.parse(await readText(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { express: '^5.1.0', zod: '^4.0.0' });
  assert.match(integrator.errorOf(c.id) ?? '', /needs a person/);
  assert.match(integrator.errorOf(d.id) ?? '', /not a hot file/);
  assert.equal(updates.filter((u) => u.status === 'pending').length, 4);
  assert.equal(integrator.list({ status: 'applied' }).length, 2);
  assert.equal(integrator.list({ taskId: 't3' }).length, 2);
  await assert.rejects(
    integrator.submit({ taskId: 't1', path: '../escape.json', kind: 'other', description: 'x' }),
    IntentRejectedError,
  );
});

console.log(`\n${passed} passed`);
await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
