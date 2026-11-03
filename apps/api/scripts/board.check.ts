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
 *   5. Routing: pin beats Jev, fallback rules, Jev down -> source fallback.
 *   6. Merge queue: real git; green tasks merge, conflicts and red tests spawn fix tasks, approvals and signals.
 *   7. Service, routes and inbox: decompose-only create, edits, run ready, merge approvals in the inbox, budget -> blocked.
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
  assert.equal(read.verdict, 'allow', 'reads inside the repo ignore leases');
  const outside = await bridge.decide({
    harness: 'claudecode',
    toolName: 'Read',
    rawInput: { file_path: join(scratch, '..', 'outside.txt') },
    sessionId: 'sess',
    taskId: 't1',
  } as NativeToolRequest);
  assert.equal(outside.verdict, 'deny', 'a read outside the worktree still follows step 3');
  assert.equal(outside.lease, undefined, 'and is not a lease decision');
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

console.log('5. routing');

const { DecisionService } = await import('../src/core/decisions/service.js');
const { fallbackRoute, routeFeatures, candidateKey, isUiTask } = await import('../src/core/decisions/routing.js');
const { create: createJev } = await import('../src/providers/jev/index.js');
type ProviderConfig = import('../src/config.js').ProviderConfig;
type DecisionAdapter = import('@htn/shared').DecisionAdapter;
type Assignee = import('@htn/shared').Assignee;
type RouteCandidateInput = import('@htn/shared').RouteCandidateInput;

const routeCtx = { runId: 'run_board', policyRule: 'check' } as Parameters<DecisionAdapter['decide']>[1];
const routeEligible = { sanitizedForRemote: true, dataLabels: [] };
function candidate(a: Assignee, over: Partial<RouteCandidateInput> = {}): RouteCandidateInput {
  return { key: candidateKey(a), assignee: a, history: { done: 0, failed: 0 }, load: 0, designPreferences: 0, ...over };
}
const cheap: Assignee = { kind: 'agent', harness: 'claudecode', tier: 'cheap' };
const standard: Assignee = { kind: 'agent', harness: 'codex', tier: 'standard' };
const frontier: Assignee = { kind: 'agent', harness: 'claudecode', tier: 'frontier' };
const person: Assignee = { kind: 'human', reason: 'reviewer' };
const pool = [
  candidate(cheap),
  candidate(standard, { designPreferences: 4 }),
  candidate(frontier, { designPreferences: 1 }),
  candidate(person),
];
const jevStubAdapter = (routeTask?: DecisionAdapter['routeTask'], mode: 'live' | 'mock' = 'live') =>
  ({ id: 'jev', mode, routeTask }) as unknown as DecisionAdapter;

await test('fallback rules: small -> cheap, UI -> design preferences, failed twice -> escalate', () => {
  assert.equal(candidateKey(cheap), 'agent:claudecode:cheap');
  assert.equal(isUiTask({ title: 'wire api', writeScope: ['apps/web/src/Board.tsx'] }), true);
  assert.equal(isUiTask({ title: 'add lease table', writeScope: ['apps/api/src/x.ts'] }), false);
  const small = routeFeatures(makeTask('s', { writeScope: ['src/a.ts'] }), pool);
  assert.deepEqual(fallbackRoute(small), { assignee: cheap, rule: 'small-cheap' });
  const ui = routeFeatures(makeTask('u', { title: 'Board page layout', writeScope: ['apps/web/src/**'] }), pool);
  assert.deepEqual(fallbackRoute(ui), { assignee: standard, rule: 'ui-design-preferences' });
  const big = routeFeatures(makeTask('b', { writeScope: ['src/a/**', 'src/b/**', 'src/c/**'] }), pool);
  assert.equal(fallbackRoute(big).rule, 'standard');
  const twice = routeFeatures(makeTask('f', { writeScope: ['src/a.ts'] }), pool, 2);
  assert.deepEqual(fallbackRoute(twice, cheap), { assignee: standard, rule: 'escalate' });
  assert.deepEqual(fallbackRoute(twice, frontier).assignee, person, 'nothing above frontier -> a human');
  assert.equal(fallbackRoute(routeFeatures(makeTask('h'), [candidate(person)])).assignee.kind, 'human');
});

await test('routeTask: a pin beats Jev, and Jev is not asked', async () => {
  let asked = 0;
  const decisions = new DecisionService(
    jevStubAdapter(async () => {
      asked++;
      return {
        ok: true,
        data: { choice: candidateKey(frontier), confidence: 0.9, probabilities: {}, reasonCodes: ['jev'] },
        meta: { provider: 'jev', op: 'route_task', mode: 'live', latencyMs: 0, destination: 'gateway' },
      };
    }),
  );
  const pinned = makeTask('p', { assignee: cheap, pinned: true });
  const r = await decisions.routeTask(routeEligible, pinned, pool, routeCtx);
  assert.deepEqual(r.assignee, cheap);
  assert.equal(r.source, 'pin');
  assert.equal(asked, 0);
  const free = await decisions.routeTask(routeEligible, makeTask('q', { assignee: cheap }), pool, routeCtx);
  assert.equal(free.source, 'jev');
  assert.deepEqual(free.assignee, frontier, 'unpinned: Jev is followed');
  assert.equal(asked, 1);
});

await test('routeTask: Jev down / unknown key / ineligible / unsupported -> rule result, source fallback', async () => {
  const task = makeTask('d', { writeScope: ['src/a.ts'] });
  const down = new DecisionService(
    jevStubAdapter(async () => ({
      ok: false,
      error: { code: 'UPSTREAM', message: 'down', retryable: true },
      meta: { provider: 'jev', op: 'route_task', mode: 'live', latencyMs: 0, destination: 'gateway' },
    })),
  );
  const r = await down.routeTask(routeEligible, task, pool, routeCtx);
  assert.equal(r.source, 'fallback');
  assert.deepEqual(r.assignee, cheap);
  assert.deepEqual(r.reasonCodes, ['jev-route-task-failed', 'route-rule-small-cheap']);
  const bogus = new DecisionService(
    jevStubAdapter(async () => ({
      ok: true,
      data: { choice: 'agent:nope:frontier', confidence: 1, probabilities: {}, reasonCodes: [] },
      meta: { provider: 'jev', op: 'route_task', mode: 'live', latencyMs: 0, destination: 'gateway' },
    })),
  );
  assert.equal((await bogus.routeTask(routeEligible, task, pool, routeCtx)).reasonCodes[0], 'jev-route-task-unknown-choice');
  const unsanitized = { sanitizedForRemote: false, dataLabels: [] };
  assert.equal((await bogus.routeTask(unsanitized, task, pool, routeCtx)).reasonCodes[0], 'remote-jev-ineligible');
  const none = new DecisionService(jevStubAdapter(undefined));
  assert.equal((await none.routeTask(routeEligible, task, pool, routeCtx)).reasonCodes[0], 'jev-route-task-unsupported');
});

await test('mock Jev routes like the rules on the clear cases', async () => {
  const decisions = new DecisionService(createJev({ mode: 'mock' } as ProviderConfig));
  const small = await decisions.routeTask(routeEligible, makeTask('s', { writeScope: ['src/a.ts'] }), pool, routeCtx);
  assert.equal(small.source, 'jev');
  assert.deepEqual(small.assignee, cheap);
  const ui = await decisions.routeTask(
    routeEligible,
    makeTask('u', { title: 'Board page', writeScope: ['apps/web/src/**'] }),
    pool,
    routeCtx,
  );
  assert.deepEqual(ui.assignee, standard);
  const failed = await decisions.routeTask(routeEligible, makeTask('f'), pool, routeCtx, 2);
  assert.ok(failed.assignee.kind === 'human' || failed.assignee.tier === 'frontier', 'escalated');
  const sum = Object.values(small.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'a distribution over every candidate');
});

console.log('6. merge queue');

const { MergeQueue, MergeQueueError } = await import('../src/core/coordination/mergeQueue.js');
const { execArgv } = await import('../src/services/publish.service.js');
const { InMemorySignalLog } = await import('../src/core/learning/signals.mock.js');
const { preferenceSignalSchema } = await import('@htn/shared');
type MergeItem = import('../src/core/coordination/mergeQueue.js').MergeItem;
type FixTaskRequest = import('../src/core/coordination/mergeQueue.js').FixTaskRequest;
type MergeQueueDeps = import('../src/core/coordination/mergeQueue.js').MergeQueueDeps;

const mqGit = async (cwd: string, ...args: string[]) => {
  const r = await execArgv('git', args, { cwd });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repo whose root is the integration worktree (on `main`), plus a worktree per task. */
async function mqRepo(name: string) {
  const root = join(scratch, name);
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await mqGit(repo, 'init', '-q', '-b', 'main');
  await mqGit(repo, 'config', 'user.name', 'Zephyr Check');
  await mqGit(repo, 'config', 'user.email', 'check@zephyr.invalid');
  await mqGit(repo, 'config', 'commit.gpgsign', 'false');
  await mqGit(repo, 'config', 'core.autocrlf', 'false');
  await writeText(join(repo, 'README.md'), '# fixture\nline two\n');
  await mqGit(repo, 'add', '-A');
  await mqGit(repo, 'commit', '-q', '-m', 'init');
  const task = async (id: string, files: Record<string, string>, over: Partial<Task> = {}): Promise<MergeItem> => {
    const branch = 'zephyr/' + id;
    const worktree = join(root, 'wt-' + id);
    await mqGit(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
    for (const [p, c] of Object.entries(files)) {
      await mkdir(join(worktree, p, '..'), { recursive: true });
      await writeText(join(worktree, p), c);
    }
    return { task: makeTask(id, { status: 'review', assignee: { kind: 'agent', harness: 'codex', tier: 'cheap' }, ...over }), worktree, branch };
  };
  return { repo, task };
}

function mqDeps(repo: string, over: Partial<MergeQueueDeps> = {}) {
  const fixes: FixTaskRequest[] = [];
  const emitted: Array<{ taskId: string; outcome: string }> = [];
  const evidence: string[] = [];
  const signals = new InMemorySignalLog();
  const deps: MergeQueueDeps = {
    exec: execArgv,
    integration: { worktree: repo, branch: 'main' },
    runTests: async () => ({ passed: 3, failed: 0, failedTests: [] }),
    evidence: (item) => void evidence.push(item.task.id),
    createFixTask: (req) => {
      fixes.push(req);
      return { id: 'fix_' + req.parent.id };
    },
    signals,
    emit: (r) => {
      assert.ok(codingEventSchema.safeParse({ type: 'merge.result', ...r }).success, 'merge.result parses');
      emitted.push({ taskId: r.taskId, outcome: r.outcome });
    },
    policy: { autoMergeGreen: true },
    ...over,
  };
  return { deps, fixes, emitted, evidence, signals };
}

await test('three green tasks merge in enqueue order; each rebases onto the last', async () => {
  const { repo, task } = await mqRepo('mq-green');
  const items = [
    await task('a', { 'src/a/index.ts': 'export const a = 1;\n' }),
    await task('b', { 'src/b/index.ts': 'export const b = 2;\n' }),
    await task('c', { 'src/c/index.ts': 'export const c = 3;\n' }),
  ];
  const { deps, emitted, evidence } = mqDeps(repo);
  const queue = new MergeQueue(deps);
  const results = await Promise.all(items.map((i) => queue.enqueue(i)));
  assert.deepEqual(results.map((r) => r.outcome), ['merged', 'merged', 'merged']);
  assert.deepEqual(emitted.map((e) => e.taskId), ['a', 'b', 'c']);
  assert.deepEqual(evidence, ['a', 'b', 'c'], 'evidence attached before each merge');
  const files = (await mqGit(repo, 'ls-files')).split(/\r?\n/);
  for (const f of ['src/a/index.ts', 'src/b/index.ts', 'src/c/index.ts']) assert.ok(files.includes(f), f);
  assert.equal(await mqGit(repo, 'rev-parse', 'HEAD'), results[2]!.commit);
  const log = (await mqGit(repo, 'log', '--format=%s')).split(/\r?\n/);
  assert.deepEqual(log, ['zephyr: c', 'zephyr: b', 'zephyr: a', 'init'], 'linear history, no merge commits');
});

await test('a conflicting task produces a fix task pinned to the same agent; main untouched', async () => {
  const { repo, task } = await mqRepo('mq-conflict');
  const first = await task('d', { 'README.md': '# fixture\nline two, by d\n' });
  const second = await task('e', { 'README.md': '# fixture\nline two, by e\n' });
  const { deps, fixes, emitted } = mqDeps(repo);
  const queue = new MergeQueue(deps);
  const [rd, re] = await Promise.all([queue.enqueue(first), queue.enqueue(second)]);
  assert.equal(rd.outcome, 'merged');
  assert.equal(re.outcome, 'conflict');
  assert.equal(re.fixTaskId, 'fix_e');
  assert.match(re.detail ?? '', /conflicts in README\.md/);
  assert.equal(fixes.length, 1);
  const fix = fixes[0]!;
  assert.deepEqual(fix.assignee, second.task.assignee, 'back to the same agent');
  assert.equal(fix.pinned, true);
  assert.deepEqual(fix.context, { kind: 'conflict', files: ['README.md'], detail: re.detail });
  assert.equal(await mqGit(repo, 'rev-parse', 'HEAD'), rd.commit, 'main holds only d');
  assert.equal(await mqGit(second.worktree, 'status', '--porcelain'), '', 'rebase aborted cleanly');
  assert.deepEqual(emitted.map((e) => e.outcome), ['merged', 'conflict']);
});

await test('failing tests block the merge and spawn a fix task', async () => {
  const { repo, task } = await mqRepo('mq-red');
  const item = await task('f', { 'src/f/index.ts': 'export const f = () => { throw 1; };\n' });
  const before = await mqGit(repo, 'rev-parse', 'HEAD');
  const { deps, fixes, evidence } = mqDeps(repo, {
    runTests: async () => ({ passed: 2, failed: 1, failedTests: ['f.test.ts > f works'] }),
  });
  const r = await new MergeQueue(deps).enqueue(item);
  assert.equal(r.outcome, 'tests_failed');
  assert.equal(r.fixTaskId, 'fix_f');
  assert.deepEqual(fixes[0]!.context, { kind: 'tests_failed', failedTests: ['f.test.ts > f works'], detail: r.detail });
  assert.equal(await mqGit(repo, 'rev-parse', 'HEAD'), before, 'main did not move');
  assert.deepEqual(evidence, [], 'no evidence for a red task');
});

await test('without auto-merge: pending approval parks; approved merges; rejected and revert record signals', async () => {
  const { repo, task } = await mqRepo('mq-approval');
  const g = await task('g', { 'src/g/index.ts': 'export const g = 1;\n' });
  const h = await task('h', { 'src/h/index.ts': 'export const h = 1;\n' });
  const verdicts: Record<string, 'pending' | 'rejected'> = { g: 'pending', h: 'rejected' };
  const { deps, signals, fixes } = mqDeps(repo, {
    policy: { autoMergeGreen: false },
    approve: async (item) =>
      verdicts[item.task.id] === 'pending'
        ? { status: 'pending', approvalId: 'apr_' + item.task.id }
        : { status: 'rejected', approvalId: 'apr_' + item.task.id, comment: 'no new modules' },
  });
  const queue = new MergeQueue(deps);
  const before = await mqGit(repo, 'rev-parse', 'HEAD');
  const [rg, rh] = await Promise.all([queue.enqueue(g), queue.enqueue(h)]);
  assert.equal(rg.outcome, 'awaiting_approval');
  assert.equal(rh.outcome, 'rejected');
  assert.equal(await mqGit(repo, 'rev-parse', 'HEAD'), before, 'nothing merged without approval');
  assert.deepEqual(queue.awaiting(), [{ taskId: 'g', approvalId: 'apr_g' }]);
  const merged = await queue.resolveApproval('g', { outcome: 'approved' });
  assert.equal(merged.outcome, 'merged');
  assert.deepEqual(queue.awaiting(), []);
  await assert.rejects(queue.resolveApproval('g', { outcome: 'approved' }), MergeQueueError);

  const head = await queue.revert('g', merged.commit!);
  assert.notEqual(head, merged.commit);
  const list = signals.list();
  assert.deepEqual(
    list.map((s) => s.kind),
    ['approval', 'revert'],
  );
  for (const s of list) assert.ok(preferenceSignalSchema.safeParse(s).success, 'signal parses');
  assert.equal((list[0] as { outcome: string }).outcome, 'rejected');
  assert.equal(list[0]!.taskId, 'h');
  assert.equal(fixes.length, 0, 'a plain rejection spawns no fix');
});

await test('a revised approval records a signal and sends a fix task back', async () => {
  const { repo, task } = await mqRepo('mq-revised');
  const k = await task('k', { 'src/k/index.ts': 'export const k = 1;\n' });
  const { deps, signals, fixes } = mqDeps(repo, {
    policy: { autoMergeGreen: false },
    approve: async () => ({ status: 'pending', approvalId: 'apr_k' }),
  });
  const queue = new MergeQueue(deps);
  assert.equal((await queue.enqueue(k)).outcome, 'awaiting_approval');
  const r = await queue.resolveApproval('k', { outcome: 'revised', comment: 'rename k to kappa' });
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.fixTaskId, 'fix_k');
  assert.deepEqual(fixes[0]!.context, { kind: 'revised', comment: 'rename k to kappa', detail: 'revision requested: rename k to kappa' });
  assert.equal((signals.list()[0] as { outcome: string }).outcome, 'revised');
  // No approval gate and no auto-merge is a configuration error, not a silent merge.
  const { deps: bare } = mqDeps(repo, { policy: {} });
  const m = await task('m', { 'src/m/index.ts': 'export const m = 1;\n' });
  await assert.rejects(new MergeQueue(bare).enqueue(m), MergeQueueError);
});

console.log('7. service, routes and inbox');

const { BoardService, BoardError, mockHarnessExecutor, defaultTaskScript, BOARD_KIND, BOARD_TASK_KIND, MERGE_POLICY_RULE } = await import(
  '../src/services/tasks.service.js'
);
const { createMemoryStore } = await import('../src/store/memory.js');
const { settleApproval } = await import('../src/core/approvalGate.js');
type BoardServiceDeps = import('../src/services/tasks.service.js').BoardServiceDeps;
type BoardServiceT = InstanceType<typeof BoardService>;

const svcPool: Assignee[] = [
  { kind: 'agent', harness: 'mockharness', tier: 'cheap' },
  { kind: 'agent', harness: 'mockharness', tier: 'standard' },
];

/** A BoardService over a real git repo, the scripted harness and the mock decision model. */
async function svcBoard(name: string, request: string, over: Partial<BoardServiceDeps> = {}) {
  const { repo } = await mqRepo(name);
  const root = join(repo, '..');
  const store = createMemoryStore({ persistToDisk: false });
  const events: Array<{ runId: string; event: RunEvent }> = [];
  // The mock planner: the heuristic plan of whatever request the prompt carries.
  const model = Object.assign(
    (async (req: { prompt: string }) => {
      model.calls += 1;
      const text = JSON.stringify(heuristicPlan(requestFromPrompt(req.prompt)));
      return { ok: true, data: { text, tokensIn: 10, tokensOut: 20 }, meta: { provider: 'anthropic', op: 'complete', mode: 'mock', latencyMs: 0, destination: 'mock://' } };
    }) as unknown as TextModelAdapter['complete'],
    { calls: 0 },
  );
  const svc = new BoardService({
    store,
    emit: async (runId, event) => {
      assert.ok(codingEventSchema.safeParse(event).success || !event.type.startsWith('task.'), event.type + ' parses');
      events.push({ runId, event });
    },
    complete: model,
    decisions: new DecisionService(createJev({ mode: 'mock' } as ProviderConfig)),
    candidates: svcPool,
    openWorkspace: async (runId, base) => {
      const branch = 'zephyr/' + runId;
      const path = join(root, 'wt-' + runId);
      await mqGit(repo, 'worktree', 'add', '-q', '-b', branch, path, !base || base === 'HEAD' ? 'main' : base);
      return { path, branch };
    },
    exec: execArgv,
    runTests: async () => ({ passed: 1, failed: 0, failedTests: [] }),
    executor: mockHarnessExecutor({ authorize: allowAuth }),
    ...over,
  });
  const view = await svc.createBoard({ request });
  return { svc, store, events, repo, model, view, boardId: view.run.id };
}

const types = (events: Array<{ event: RunEvent }>, prefix: string) =>
  events.map((e) => e.event.type).filter((t) => t.startsWith(prefix));

await test('createBoard only decomposes: tasks pending, no task run, nothing on disk', async () => {
  const { store, events, view, model } = await svcBoard('svc-create', '- add parser\n- add printer\n- wire cli after 1');
  assert.equal(model.calls, 1);
  assert.equal(view.run.kind, BOARD_KIND);
  assert.equal(view.run.status, 'pending');
  assert.equal(view.tasks.length, 3);
  assert.ok(view.tasks.every((t) => t.status === 'pending' && !t.runId && !t.assignee));
  assert.deepEqual(view.tasks[2]!.dependsOn, [view.tasks[0]!.id], '"after 1" became a dependency');
  assert.equal(types(events, 'task.created').length, 3);
  assert.equal(types(events, 'task.status').length, 0, 'nothing moved');
  const runs = await store.listRuns({ limit: 100 });
  assert.deepEqual(runs.map((r) => r.kind), [BOARD_KIND], 'no board_task run until Run ready tasks');
});

await test('a failed decomposition fails the board with DECOMPOSE', async () => {
  const { view } = await svcBoard('svc-baddecomp', 'x', { complete: completer(['not json at all']) });
  // The planner falls back or fails; either way nothing ran and the board says why.
  if (view.run.status === 'failed') assert.equal(view.run.error?.code, 'DECOMPOSE');
  else assert.ok(view.tasks.length >= 1);
});

await test('editBoard: split, merge, reorder, scope, pin; cycles and started tasks refused', async () => {
  const { svc, boardId, view, events } = await svcBoard('svc-edit', '- alpha\n- beta\n- gamma');
  const [a, b, c] = view.tasks.map((t) => t.id) as [string, string, string];
  let v = await svc.editBoard(boardId, [
    { op: 'split', taskId: a, parts: [
      { title: 'alpha api', writeScope: ['src/alpha/api/**'] },
      { title: 'alpha ui', writeScope: ['src/alpha/ui/**'] },
    ] },
  ]);
  assert.equal(v.tasks.length, 4);
  assert.ok(!v.tasks.some((t) => t.id === a), 'split replaces the task');
  assert.deepEqual(v.tasks.slice(0, 2).map((t) => t.title), ['alpha api', 'alpha ui'], 'parts take its place');
  assert.ok(types(events, 'task.removed').length >= 1);

  v = await svc.editBoard(boardId, [{ op: 'merge', taskIds: [b, c], title: 'beta and gamma' }]);
  const merged = v.tasks.find((t) => t.title === 'beta and gamma')!;
  assert.ok(merged, 'merged task exists');
  assert.deepEqual([...merged.writeScope].sort(), ['src/beta/**', 'src/gamma/**']);
  assert.equal(v.tasks.length, 3);

  const ids = v.tasks.map((t) => t.id);
  v = await svc.editBoard(boardId, [{ op: 'reorder', order: [...ids].reverse() }]);
  assert.deepEqual(v.tasks.map((t) => t.id), [...ids].reverse());

  v = await svc.editBoard(boardId, [
    { op: 'scope', taskId: merged.id, writeScope: ['src/bg/**'] },
    { op: 'pin', taskId: merged.id, assignee: svcPool[1]! },
  ]);
  const pinned = v.tasks.find((t) => t.id === merged.id)!;
  assert.deepEqual(pinned.writeScope, ['src/bg/**']);
  assert.equal(pinned.pinned, true);
  assert.deepEqual(pinned.assignee, svcPool[1]);
  assert.equal(types(events, 'task.updated').length, 1, 'scope + pin on one task: one task.updated');

  const [x, y] = v.tasks.map((t) => t.id) as [string, string];
  await svc.editBoard(boardId, [{ op: 'update', taskId: x, dependsOn: [y] }]);
  const before = await svc.getBoard(boardId);
  await assert.rejects(svc.editBoard(boardId, [{ op: 'update', taskId: y, dependsOn: [x] }]), BoardError);
  assert.deepEqual(await svc.getBoard(boardId), before, 'a refused edit changes nothing');
  await assert.rejects(svc.editBoard(boardId, [{ op: 'split', taskId: 'nope', parts: [] }]), BoardError);
});

await test('runReady: each task gets its own run, branch and worktree; green tasks auto-merge; board succeeds', async () => {
  const { svc, store, events, repo, boardId } = await svcBoard('svc-run', '- one\n- two\n- three after 1');
  await svc.runReady(boardId, { concurrency: 3, autoMergeGreen: true });
  await svc.whenIdle(boardId);
  const v = await svc.getBoard(boardId);
  assert.equal(v.run.status, 'succeeded', v.run.summary ?? '');
  assert.ok(v.tasks.every((t) => t.status === 'done'), v.tasks.map((t) => t.status + ' ' + (t.reason ?? '')).join('; '));
  const runIds = v.tasks.map((t) => t.runId!);
  assert.equal(new Set(runIds).size, 3, 'one run per task');
  assert.equal(new Set(v.tasks.map((t) => t.branch)).size, 3, 'one branch per task');
  for (const id of runIds) {
    const r = await store.getRun(id);
    assert.equal(r?.kind, BOARD_TASK_KIND);
    assert.equal(r?.status, 'succeeded');
  }
  const integration = 'zephyr/' + boardId;
  const files = (await mqGit(repo, 'ls-tree', '-r', '--name-only', integration)).split(/\r?\n/);
  for (const t of v.tasks) {
    const f = t.writeScope[0]!.replace('/**', '/main.ts');
    assert.ok(files.includes(f), f + ' merged; have ' + files.join(','));
  }
  assert.equal((await mqGit(repo, 'log', '--format=%s', 'main')).split(/\r?\n/).length, 1, 'main still at init');
  const statuses = events.filter((e) => e.event.type === 'task.status').map((e) => (e.event as { to: string }).to);
  for (const s of ['ready', 'running', 'review', 'done']) assert.ok(statuses.includes(s), 'saw ' + s);
  assert.ok(types(events, 'task.progress').length > 0, 'progress streamed');
  assert.equal(types(events, 'merge.result').length, 3);
  // The dependent task started only after its dependency was done.
  const order = events
    .filter((e) => e.event.type === 'task.status')
    .map((e) => e.event as { taskId: string; to: string });
  const t1 = v.tasks[0]!.id;
  const t3 = v.tasks[2]!.id;
  const doneOne = order.findIndex((s) => s.taskId === t1 && s.to === 'done');
  const runThree = order.findIndex((s) => s.taskId === t3 && s.to === 'running');
  assert.ok(doneOne >= 0 && runThree > doneOne, 'three ran after one merged');
  await assert.rejects(svc.editBoard(boardId, [{ op: 'scope', taskId: t1, writeScope: ['x/**'] }]), BoardError);
});

await test('merge needs approval: it lands in the inbox with every other pending approval, oldest first', async () => {
  const { svc, store, boardId, repo } = await svcBoard('svc-approve', '- solo');
  // An unrelated run's pending approval is in the inbox too.
  const other = await store.createRun({
    id: 'run_other', kind: 'agent', title: 'other', status: 'awaiting_approval',
    input: {}, createdAt: T0, updatedAt: T0,
  } as never);
  await store.createApproval({
    id: 'apr_other', runId: other.id, stepId: 'step_x', question: 'Pay?', proposedAction: { kind: 'payment' },
    reversibility: 'irreversible', riskClass: 'ask_human', policyRule: 'pay', status: 'pending', createdAt: T0,
  } as never);
  const changes: number[] = [];
  const off = svc.onInboxChange(() => changes.push(1));
  await svc.runReady(boardId);
  await svc.whenIdle(boardId);
  let inbox = await svc.inbox();
  assert.deepEqual(inbox.map((i) => i.kind), ['approval', 'approval']);
  assert.equal(inbox[0]!.kind === 'approval' && inbox[0]!.approval.id, 'apr_other', 'oldest first');
  const mine = inbox[1]!;
  assert.ok(mine.kind === 'approval');
  assert.equal(mine.boardRunId, boardId);
  assert.equal(mine.approval.policyRule, MERGE_POLICY_RULE);
  assert.equal((mine.approval.proposedAction as { kind: string }).kind, 'git.publish');
  assert.ok(changes.length > 0, 'inbox listeners heard about it');
  const v = await svc.getBoard(boardId);
  assert.equal(v.tasks[0]!.status, 'review');
  assert.equal(await mqGit(repo, 'rev-parse', 'zephyr/' + boardId), await mqGit(repo, 'rev-parse', 'main'), 'not merged yet');

  // Decide it the way POST /api/approvals/:id does.
  await store.patchApproval(mine.approval.id, { status: 'approved', decidedAt: new Date().toISOString() });
  assert.ok(settleApproval(mine.approval.id, { verdict: 'approved', action: { kind: 'git.publish' } as never }));
  await new Promise((r) => setTimeout(r, 0));
  await svc.whenIdle(boardId);
  const after = await svc.getBoard(boardId);
  assert.equal(after.tasks[0]!.status, 'done');
  assert.equal(after.run.status, 'succeeded');
  inbox = await svc.inbox();
  assert.deepEqual(inbox.map((i) => i.kind === 'approval' && i.approval.id), ['apr_other']);
  off();
});

await test('over budget: the task blocks with its lease released, shows in the inbox, and resumes', async () => {
  const { svc, boardId } = await svcBoard('svc-budget', '- heavy', { budget: { maxTurns: 1 } });
  await svc.runReady(boardId, { autoMergeGreen: true });
  await svc.whenIdle(boardId);
  let v = await svc.getBoard(boardId);
  const t = v.tasks[0]!;
  assert.equal(t.status, 'blocked');
  assert.match(t.reason ?? '', /over budget/);
  assert.equal(svc.leasesOf(boardId).live().length, 0, 'lease released');
  const inbox = await svc.inbox();
  assert.ok(inbox.some((i) => i.kind === 'blocked_task' && i.taskId === t.id));
  assert.notEqual(v.run.status, 'succeeded');
  await assert.rejects(svc.resumeTask(boardId, 'nope'), BoardError);
  const resumed = await svc.resumeTask(boardId, t.id, svcPool[1]);
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.pinned, true);
  v = await svc.getBoard(boardId);
  assert.ok(['ready', 'running', 'blocked'].includes(v.tasks[0]!.status));
  await svc.whenIdle(boardId);
});

await test('a queued lease extension shows in the inbox until decided', async () => {
  const { svc, boardId, view } = await svcBoard('svc-ext', '- left\n- right');
  const [l, r] = view.tasks.map((t) => t.id) as [string, string];
  const leases = svc.leasesOf(boardId);
  assert.ok(leases.acquire(l, ['src/left/**']).ok);
  assert.ok(leases.acquire(r, ['src/right/**']).ok);
  const req = svc.requestExtension(boardId, l, ['src/right/shared.ts']);
  const pending = (await svc.inbox()).filter((i) => i.kind === 'lease_extension');
  assert.equal(pending.length, 1, JSON.stringify(req));
  const id = pending[0]!.kind === 'lease_extension' ? pending[0]!.request.id : '';
  svc.decideExtension(boardId, id, 'reject');
  assert.equal((await svc.inbox()).filter((i) => i.kind === 'lease_extension').length, 0);
  assert.throws(() => svc.decideExtension(boardId, 'nope', 'approve'), BoardError);
});

await test('routes: POST /tasks decomposes only (201), PATCH edits, 404 / 409 / 400 mapped, run is 202', async () => {
  const express = (await import('express')).default;
  const { boardRoutes } = await import('../src/api/tasks.routes.js');
  const { svc, store } = await svcBoard('svc-routes', '- seed');
  const app = express();
  app.use(express.json());
  app.use('/api', boardRoutes(() => svc as BoardServiceT));
  app.use(((err: { status?: number; code?: string; message: string }, _req: unknown, res: { status(n: number): { json(b: unknown): void } }, _next: unknown) =>
    res.status(err.status ?? 500).json({ code: err.code, message: err.message })) as never);
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const call = (method: string, path: string, body?: unknown) =>
      fetch('http://127.0.0.1:' + port + '/api' + path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const before = (await store.listRuns({ limit: 100 })).length;
    const created = await call('POST', '/tasks', { request: '- a\n- b' });
    assert.equal(created.status, 201);
    const board = (await created.json()) as { run: { id: string }; tasks: Task[] };
    assert.equal(board.tasks.length, 2);
    assert.equal((await store.listRuns({ limit: 100 })).length, before + 1, 'only the board run exists');
    assert.ok((await store.listRuns({ limit: 100 })).every((r) => r.kind !== BOARD_TASK_KIND), 'POST /tasks starts no task');
    assert.equal((await call('GET', '/tasks/run_missing')).status, 404);
    assert.equal((await call('PATCH', '/tasks/' + board.run.id, { ops: [] })).status, 400);
    const edited = await call('PATCH', '/tasks/' + board.run.id, {
      ops: [{ op: 'update', taskId: board.tasks[0]!.id, title: 'renamed' }],
    });
    assert.equal(edited.status, 200);
    assert.equal(((await edited.json()) as { tasks: Task[] }).tasks[0]!.title, 'renamed');
    const cyc = await call('PATCH', '/tasks/' + board.run.id, {
      ops: [
        { op: 'update', taskId: board.tasks[0]!.id, dependsOn: [board.tasks[1]!.id] },
        { op: 'update', taskId: board.tasks[1]!.id, dependsOn: [board.tasks[0]!.id] },
      ],
    });
    assert.ok([400, 409].includes(cyc.status), 'cycle refused: ' + cyc.status);
    const inbox = await call('GET', '/tasks/inbox');
    assert.equal(inbox.status, 200);
    assert.ok(Array.isArray(((await inbox.json()) as { items: unknown[] }).items));
    const ran = await call('POST', '/tasks/' + board.run.id + '/run', { autoMergeGreen: true });
    assert.equal(ran.status, 202);
    await svc.whenIdle(board.run.id);
    assert.equal((await svc.getBoard(board.run.id)).run.status, 'succeeded');
  } finally {
    server.close();
  }
});

await test('learning hooks: request wording recorded; outcomes reported per task run; a throwing hook breaks nothing', async () => {
  const signals = new InMemorySignalLog();
  const calls: Array<{ taskId: string; runId?: string; outcome: string }> = [];
  const { svc, boardId } = await svcBoard('svc-learning', '- one\n- two', {
    signals,
    onTaskFinished: (t) => {
      calls.push(t);
      throw new Error('learning is down');
    },
  });
  await svc.runReady(boardId, { concurrency: 2, autoMergeGreen: true });
  await svc.whenIdle(boardId);
  const v = await svc.getBoard(boardId);
  assert.equal(v.run.status, 'succeeded', 'a throwing learning hook does not fail the board');
  const wording = signals.list().filter((s) => s.kind === 'request_wording');
  assert.equal(wording.length, 1, 'the request is recorded once');
  assert.equal(wording[0]!.runId, boardId);
  assert.ok(preferenceSignalSchema.safeParse(wording[0]).success, 'signal parses');
  assert.deepEqual(
    calls.map((c) => [c.taskId, c.runId, c.outcome]).sort(),
    v.tasks.map((t) => [t.id, t.runId, 'passed']).sort(),
    'one passed outcome per merged task, with its run',
  );

  // An executor that changes nothing fails its task, and that is reported as failed.
  const failedCalls: typeof calls = [];
  const f = await svcBoard('svc-learning-fail', '- nothing', {
    executor: mockHarnessExecutor({ authorize: allowAuth, script: () => [] }),
    onTaskFinished: (t) => failedCalls.push(t),
  });
  await f.svc.runReady(f.boardId, { autoMergeGreen: true });
  await f.svc.whenIdle(f.boardId);
  assert.deepEqual(failedCalls.map((c) => c.outcome), ['failed']);
  assert.ok(failedCalls[0]!.runId, 'the failed task run is named');
});

await test('a template presets concurrency, auto-merge, budget and policy; the user words stay the signal', async () => {
  const seen: Array<{ policy: unknown }> = [];
  const inner = mockHarnessExecutor({ authorize: allowAuth });
  const { svc } = await svcBoard('svc-template', '- unused', {
    executor: async (ctx) => {
      seen.push({ policy: ctx.policy });
      return inner(ctx);
    },
  });
  const v = await svc.createBoard({ request: '- tweak header\n- tweak footer', template: 'polish-ui' });
  assert.equal((v.run.input as { template?: string }).template, 'polish-ui');
  assert.equal((v.run.input as { request: string }).request, '- tweak header\n- tweak footer', 'the stored request is the user words');
  assert.equal(v.tasks.length, 2, 'the guidance is not planned as a task of its own');
  for (const t of v.tasks) {
    assert.doesNotMatch(t.title, /Polish the UI/);
    assert.match(t.acceptance, /\nPolish the UI: /, 'the guidance rides on each task');
  }
  await svc.runReady(v.run.id);
  await svc.whenIdle(v.run.id);
  assert.ok(seen.length >= 2, 'executor ran');
  for (const s of seen)
    assert.deepEqual(s.policy, {
      levers: { shapedTools: true, contextPack: true, schemaMin: true },
      verify: { protectDefaults: true, fullSuiteBeforePublish: false, protectedGlobs: [] },
    });
  const done = await svc.getBoard(v.run.id);
  assert.ok(done.tasks.filter((t) => t.status === 'done').length >= 2, 'polish-ui auto-merges green tasks');

  // fix-ci: a tight budget. An executor that loops past 25 turns is blocked as over budget.
  const loop = await svcBoard('svc-template-budget', '- unused', {
    executor: async (ctx) => {
      for (let i = 0; i < 30; i++) {
        ctx.tracker.observe({
          type: 'harness.turn.ended',
          runId: ctx.taskRunId,
          sessionId: 'sess_budget',
          turnId: 'turn_' + i,
          harness: 'mockharness',
          stopReason: 'end_turn',
          taskId: ctx.task.id,
          at: new Date().toISOString(),
        } as RunEvent);
        await ctx.step();
      }
      return { status: 'done' };
    },
  });
  const ci = await loop.svc.createBoard({ request: '- fix the build', template: 'fix-ci' });
  await loop.svc.runReady(ci.run.id);
  await loop.svc.whenIdle(ci.run.id);
  const blocked = (await loop.svc.getBoard(ci.run.id)).tasks.find((t) => t.status === 'blocked');
  assert.ok(blocked, 'blocked by the template budget');
  assert.match(JSON.stringify(blocked), /25/);

  // Without a template nothing changes: the service default budget and no policy.
  seen.length = 0;
  const plain = await svc.createBoard({ request: '- plain one' });
  assert.equal((plain.run.input as { template?: string }).template, undefined);
  await svc.runReady(plain.run.id, { autoMergeGreen: true });
  await svc.whenIdle(plain.run.id);
  assert.equal(seen[0]?.policy, undefined);
});

console.log('8. end to end (the done condition)');

await test('three tasks at once, an out-of-lease edit denied, two package.json intents land, all green merged', async () => {
  const deps: Record<string, { name: string; version: string }> = {
    parser: { name: 'zod', version: '^4.0.0' },
    printer: { name: 'express', version: '^5.1.0' },
  };
  const { svc, events, repo, boardId, view } = await svcBoard('e2e', '- add parser\n- add printer\n- add cli', {
    executor: mockHarnessExecutor({
      authorize: allowAuth,
      // The cli task also tries to write into the parser's scope: the broker must refuse it.
      script: (task) => [
        ...defaultTaskScript(task),
        ...(task.title.includes('cli') ? [{ tool: 'Write' as const, path: 'src/parser/stolen.ts', content: 'export {};\n' }] : []),
      ],
      intents: (task) => {
        const dep = Object.entries(deps).find(([k]) => task.title.includes(k))?.[1];
        return dep ? [{ path: 'package.json', kind: 'add_dependency' as const, description: 'add ' + dep.name, payload: dep }] : [];
      },
    }),
  });
  // A package.json on main for the intents to land in. The integration branch is cut at Run.
  await writeText(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {} }, null, 2) + '\n');
  await mqGit(repo, 'add', '-A');
  await mqGit(repo, 'commit', '-q', '-m', 'package.json');
  assert.equal(view.tasks.length, 3);
  assert.equal(view.waves.length, 1, 'disjoint scopes: one wave');

  await svc.runReady(boardId, { concurrency: 3, autoMergeGreen: true });
  await svc.whenIdle(boardId);
  const v = await svc.getBoard(boardId);
  assert.equal(v.run.status, 'succeeded', v.run.summary ?? '');
  assert.ok(v.tasks.every((t) => t.status === 'done'), v.tasks.map((t) => t.title + ': ' + t.status + ' ' + (t.reason ?? '')).join('; '));

  // Three at once: at some point every task was running.
  const running = new Set<string>();
  let peak = 0;
  for (const e of events) {
    if (e.event.type !== 'task.status') continue;
    const s = e.event as { taskId: string; to: string };
    if (s.to === 'running') running.add(s.taskId);
    else running.delete(s.taskId);
    peak = Math.max(peak, running.size);
  }
  assert.equal(peak, 3, 'three tasks ran concurrently');

  // The out-of-lease edit was denied and never reached any branch.
  const cli = v.tasks.find((t) => t.title.includes('cli'))!;
  const denied = events.filter((e) => e.event.type === 'lease.denied').map((e) => e.event as { taskId: string; path: string });
  assert.ok(denied.some((d) => d.taskId === cli.id && d.path.endsWith('src/parser/stolen.ts')), JSON.stringify(denied));
  const integration = 'zephyr/' + boardId;
  const files = (await mqGit(repo, 'ls-tree', '-r', '--name-only', integration)).split(/\r?\n/);
  assert.ok(!files.includes('src/parser/stolen.ts'), 'denied write not merged');

  // Both package.json intents landed, serially, in one file.
  const pkg = JSON.parse(await mqGit(repo, 'show', integration + ':package.json'));
  assert.deepEqual(pkg.dependencies, { express: '^5.1.0', zod: '^4.0.0' });
  const applied = events.filter((e) => e.event.type === 'intent.updated' && (e.event as { intent: { status: string } }).intent.status === 'applied');
  assert.equal(applied.length, 2);

  // The merge queue merged every green task.
  const merges = events.filter((e) => e.event.type === 'merge.result').map((e) => e.event as { taskId: string; outcome: string });
  assert.deepEqual(merges.map((m) => m.outcome), ['merged', 'merged', 'merged']);
  assert.equal(new Set(merges.map((m) => m.taskId)).size, 3);
  for (const t of v.tasks) {
    const f = t.writeScope[0]!.replace('/**', '/main.ts');
    assert.ok(files.includes(f), f + ' merged');
  }
});

await test('isPrivate: a private board, its tasks and its task runs are private; a public board is not', async () => {
  const { svc, boardId, view } = await svcBoard('svc-private', '- one\n- two');
  const priv = await svc.createBoard({ request: '- secret one\n- secret two', private: true });
  assert.equal(await svc.isPrivate({ runId: priv.run.id }), true);
  assert.equal(await svc.isPrivate({ taskId: priv.tasks[1]!.id }), true);
  assert.equal(await svc.isPrivate({ runId: boardId }), false);
  assert.equal(await svc.isPrivate({ taskId: view.tasks[0]!.id }), false);
  assert.equal(await svc.isPrivate({ runId: 'run_unknown' }), false);
  assert.equal(await svc.isPrivate({}), false);
  await svc.runReady(priv.run.id, { concurrency: 2, autoMergeGreen: true });
  await svc.whenIdle(priv.run.id);
  const ran = (await svc.getBoard(priv.run.id)).tasks.find((t) => t.runId);
  assert.ok(ran, 'a task ran');
  assert.equal(await svc.isPrivate({ runId: ran.runId! }), true, 'a task run of a private board');
});

console.log(`\n${passed} passed`);
await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
