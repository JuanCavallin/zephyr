/**
 * Step 9 check: the coding benchmark.
 *
 *   pnpm check:benchmark-coding
 *
 * Offline. No harness binary, no model, no network.
 *
 *   1. Task set: loads, every hidden test fails at base and passes after the reference fix.
 *   2. Isolation: the hidden test is unreachable from the agent's tree; leaks are caught.
 *   3. Arms differ only by the expected flags.
 *   4. Report rule on synthetic results: comparable, not comparable, insufficient.
 *   5. Runner: journal resume (torn last line), network-only retries, errors not retried.
 *   6. Mock arms end to end through the real permission bridge.
 *   7. Live vanilla agent against a fake `claude` binary; live Zephyr arms refused.
 */

process.env.PERSIST_TO_DISK = 'false';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  armDiff,
  buildCodingReport,
  CODING_ARMS,
  CODING_ARM_IDS,
  type CodingArmId,
  type CodingRunResult,
} from '@htn/shared';

const {
  loadCodingTaskSet,
  prepareRepo,
  hiddenTestOf,
  hiddenIsolationProblems,
  runHiddenTest,
  readJournal,
  pendingRuns,
  runCodingBenchmark,
  codingReportMarkdown,
  HIDDEN_DIR_NAME,
} = await import('../src/core/benchmark/coding/index.js');
const { mockCodingAgent } = await import('../src/services/benchmarkCoding.service.js');
const { liveArmProblems, parseClaudePrintJson, vanillaClaudeAgent } = await import('../src/services/benchmarkCoding.live.js');
const { createMockHarness } = await import('../src/providers/mockharness/index.js');

let failures = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log('[PASS] ' + name);
  } catch (err) {
    failures++;
    console.log('[FAIL] ' + name + '\n       ' + ((err as Error).stack ?? String(err)).split('\n').slice(0, 4).join('\n       '));
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'zephyr-bench-check-'));
const set = await loadCodingTaskSet();
const signal = new AbortController().signal;

/* ------------------------------ 1. task set ------------------------------- */

console.log('task set');
await test('loads with 20+ tasks across 3 repos and every kind', () => {
  assert.ok(set.tasks.length >= 20, String(set.tasks.length));
  assert.equal(new Set(set.tasks.map((t) => t.repo)).size, 3);
  for (const kind of ['bugfix', 'feature', 'refactor', 'ci']) assert.ok(set.tasks.some((t) => t.kind === kind), kind);
});
await test('no prompt mentions the hidden test', () => {
  for (const t of set.tasks) {
    assert.doesNotMatch(t.prompt, /hidden/i, t.id);
    assert.ok(!t.prompt.includes(hiddenTestOf(set, t).split(/[\\/]/).pop()!), t.id);
  }
});

/** Apply a reference solution with the scripted harness, everything allowed. */
async function replaySolution(task: (typeof set.tasks)[number], dir: string): Promise<void> {
  const harness = createMockHarness({ decide: async () => 'allow' });
  const pctx = { runId: 'run_check', policyRule: 'check' };
  const started = await harness.startTask({ goal: task.prompt, context: { workspaceDir: dir, script: task.solution, taskId: task.id } }, pctx);
  assert.ok(started.ok);
  for (;;) {
    const p = await harness.pollTask(started.data.taskId, pctx);
    assert.ok(p.ok);
    if (p.data.status === 'failed') throw new Error(task.id + ': reference fix failed to apply: ' + JSON.stringify(p.data));
    if (p.data.status === 'done') break;
  }
  await harness.dispose();
}

// Parallel in small batches: each task spawns two node processes.
const baseResults = new Map<string, { base: boolean; fixed: boolean; out: string }>();
for (let i = 0; i < set.tasks.length; i += 6) {
  await Promise.all(
    set.tasks.slice(i, i + 6).map(async (task) => {
      const repo = await prepareRepo(set, task, scratch);
      try {
        const base = await runHiddenTest({ worktree: repo.dir, hiddenTest: hiddenTestOf(set, task), signal });
        await replaySolution(task, repo.dir);
        const fixed = await runHiddenTest({ worktree: repo.dir, hiddenTest: hiddenTestOf(set, task), signal });
        baseResults.set(task.id, { base: base.passed, fixed: fixed.passed, out: fixed.output });
      } finally {
        await repo.cleanup();
      }
    }),
  );
}
await test('every hidden test fails at base', () => {
  const passing = [...baseResults].filter(([, r]) => r.base).map(([id]) => id);
  assert.deepEqual(passing, []);
});
await test('every hidden test passes after the reference fix', () => {
  const failing = [...baseResults].filter(([, r]) => !r.fixed).map(([id, r]) => id + ': ' + r.out.slice(-300));
  if (failing.length) console.log(failing.join('\n---\n'));
  assert.deepEqual(failing, []);
});
await test('a hang is killed at the time limit and counts as a failure', async () => {
  const dir = join(scratch, 'hang');
  await mkdir(dir, { recursive: true });
  const hang = join(scratch, 'hang.test.mjs');
  await writeFile(hang, "import test from 'node:test';\ntest('loops', () => { for (;;) {} });\n");
  const r = await runHiddenTest({ worktree: dir, hiddenTest: hang, timeoutMs: 1500 });
  assert.equal(r.passed, false);
  assert.equal(r.timedOut, true);
});

/* ------------------------------ 2. isolation ------------------------------ */

console.log('isolation');
await test('a fresh repo has no route to the hidden test', async () => {
  for (const task of set.tasks.slice(0, 5)) {
    const repo = await prepareRepo(set, task, scratch);
    try {
      assert.deepEqual(await hiddenIsolationProblems(repo.dir, hiddenTestOf(set, task)), [], task.id);
    } finally {
      await repo.cleanup();
    }
  }
});
await test('the hidden dir is removed after the test ran', async () => {
  const task = set.tasks[0]!;
  const repo = await prepareRepo(set, task, scratch);
  try {
    await runHiddenTest({ worktree: repo.dir, hiddenTest: hiddenTestOf(set, task) });
    assert.deepEqual(await hiddenIsolationProblems(repo.dir, hiddenTestOf(set, task)), []);
  } finally {
    await repo.cleanup();
  }
});
await test('leaks are caught: copy in the tree, hidden dir present, test inside the worktree', async () => {
  const task = set.tasks[0]!;
  const hidden = hiddenTestOf(set, task);
  const repo = await prepareRepo(set, task, scratch);
  try {
    const name = hidden.split(/[\\/]/).pop()!;
    await writeFile(join(repo.dir, name), '// leaked');
    await mkdir(join(repo.dir, HIDDEN_DIR_NAME));
    await writeFile(join(repo.dir, HIDDEN_DIR_NAME, 'x.mjs'), '');
    const problems = await hiddenIsolationProblems(repo.dir, hidden);
    assert.ok(problems.some((p) => p.includes('named like')), problems.join());
    assert.ok(problems.some((p) => p.includes(HIDDEN_DIR_NAME)), problems.join());
    const inside = await hiddenIsolationProblems(repo.dir, join(repo.dir, 'src', 'x.test.mjs'));
    assert.ok(inside.some((p) => p.includes('inside the worktree')), inside.join());
  } finally {
    await repo.cleanup();
  }
});
await test('the runner refuses to run a task whose hidden test leaked', async () => {
  const leakySet = { ...set, tasks: [set.tasks[0]!] };
  const journal = join(scratch, 'leak.jsonl');
  const agent = async ({ repoDir }: { repoDir: string }) => {
    throw new Error('agent must not run; repo ' + repoDir);
  };
  // Plant a same-named file in the fixture copy by pointing the task at a hidden test
  // whose name collides with a fixture file.
  const collide = { ...set.tasks[0]!, hiddenTest: 'repos/' + set.repos[set.tasks[0]!.repo]!.dir.split('/').pop() + '/package.json' };
  const r = await runCodingBenchmark({ set: { ...leakySet, tasks: [collide] }, arms: ['vanilla'], reps: 1, mode: 'mock', agent, journal, tmpParent: scratch });
  assert.equal(r.results[0]!.status, 'error');
  assert.match(r.results[0]!.error!, /not isolated/);
});

/* -------------------------------- 3. arms --------------------------------- */

console.log('arms');
await test('six arms, ids match', () => {
  assert.deepEqual(Object.keys(CODING_ARMS).sort(), [...CODING_ARM_IDS].sort());
});
await test('supervised differs from vanilla on every flag', () => {
  assert.deepEqual(armDiff(CODING_ARMS.vanilla, CODING_ARMS.supervised), [
    'levers.contextPack',
    'levers.schemaMin',
    'levers.shapedTools',
    'skills',
    'zephyr',
  ]);
});
await test('each leave-one-out arm differs from supervised by exactly its flag', () => {
  const expected: Record<string, string[]> = {
    'loo-L1': ['levers.shapedTools'],
    'loo-L2': ['levers.contextPack'],
    'loo-L3': ['levers.schemaMin'],
    'skills-off': ['skills'],
  };
  for (const [arm, diff] of Object.entries(expected))
    assert.deepEqual(armDiff(CODING_ARMS.supervised, CODING_ARMS[arm as CodingArmId]), diff, arm);
});

/* ------------------------------- 4. report -------------------------------- */

console.log('report rule');
function row(taskId: string, arm: CodingArmId, rep: number, passed: boolean, total: number, extra: Partial<CodingRunResult> = {}): CodingRunResult {
  return {
    taskId,
    arm,
    rep,
    mode: 'mock',
    status: 'ok',
    passed,
    hidden: { pass: passed ? 1 : 0, fail: passed ? 0 : 1, timedOut: false },
    tokens: { input: total * 0.5, output: total * 0.1, cacheRead: total * 0.4, cacheWrite: 0 },
    costUsd: total / 1e6,
    wallMs: 1000,
    approvals: 0,
    stuckBlocks: 0,
    attempts: 1,
    at: '2026-11-03T00:00:00.000Z',
    ...extra,
  };
}
function grid(arm: CodingArmId, passFn: (t: number, rep: number) => boolean, total: number, tasks = 4, reps = 3): CodingRunResult[] {
  const out: CodingRunResult[] = [];
  for (let t = 0; t < tasks; t++) for (let rep = 0; rep < reps; rep++) out.push(row('t' + t, arm, rep, passFn(t, rep), total));
  return out;
}
await test('an arm within noise of vanilla shows its saving', () => {
  const r = buildCodingReport([...grid('vanilla', () => true, 10_000), ...grid('supervised', () => true, 4_000)]);
  const sup = r.arms.find((a) => a.arm === 'supervised')!;
  assert.equal(sup.comparability, 'comparable');
  assert.ok(Math.abs(sup.savings!.totalTokens - 0.6) < 1e-9, String(sup.savings!.totalTokens));
  assert.equal(r.arms.find((a) => a.arm === 'vanilla')!.comparability, 'baseline');
});
await test('an arm below vanilla beyond noise is "not comparable" and gets no saving', () => {
  const r = buildCodingReport([...grid('vanilla', () => true, 10_000), ...grid('supervised', (_t, rep) => rep === 0, 1_000)]);
  const sup = r.arms.find((a) => a.arm === 'supervised')!;
  assert.equal(sup.comparability, 'not_comparable');
  assert.equal(sup.savings, undefined);
  assert.match(codingReportMarkdown(r), /not comparable/);
});
await test('a small pass-rate dip inside the noise bar is still comparable', () => {
  // 11/12 vs 12/12: well inside a 95% bar at n=12.
  const r = buildCodingReport([...grid('vanilla', () => true, 10_000), ...grid('supervised', (t, rep) => !(t === 0 && rep === 0), 5_000)]);
  assert.equal(r.arms.find((a) => a.arm === 'supervised')!.comparability, 'comparable');
});
await test('fewer than three runs in any cell is "insufficient"', () => {
  const r = buildCodingReport([...grid('vanilla', () => true, 10_000), ...grid('supervised', () => true, 4_000, 4, 2)]);
  const sup = r.arms.find((a) => a.arm === 'supervised')!;
  assert.equal(sup.comparability, 'insufficient');
  assert.equal(sup.savings, undefined);
});
await test('network rows are excluded and a resumed row supersedes the old one', () => {
  const rows = [
    ...grid('vanilla', () => true, 10_000),
    ...grid('supervised', () => true, 4_000),
    row('t0', 'supervised', 3, false, 1, { status: 'network' }),
  ];
  rows.push(row('t0', 'vanilla', 0, false, 10_000)); // superseding row
  const r = buildCodingReport(rows);
  const v = r.arms.find((a) => a.arm === 'vanilla')!;
  assert.equal(v.runs, 12);
  assert.equal(v.passed, 11);
  assert.equal(r.arms.find((a) => a.arm === 'supervised')!.networkExcluded, 1);
});
await test('medians and spread per metric; a lever that hurts is flagged', () => {
  const r = buildCodingReport([
    ...grid('vanilla', () => true, 10_000),
    ...grid('supervised', (_t, rep) => rep === 0, 4_000),
    ...grid('loo-L1', () => true, 6_000),
  ]);
  const l1 = r.levers.find((l) => l.arm === 'loo-L1')!;
  assert.equal(l1.verdict, 'harmful');
  const sup = r.arms.find((a) => a.arm === 'supervised')!;
  assert.equal(sup.metrics.totalTokens.median, 4_000);
  assert.ok(sup.metrics.totalTokens.p25 <= sup.metrics.totalTokens.median);
});

/* ------------------------------- 5. runner -------------------------------- */

console.log('runner');
const two = { ...set, tasks: set.tasks.slice(0, 2) };
const noSleep = async () => {};
await test('resume skips journalled runs and drops a torn last line', async () => {
  const journal = join(scratch, 'resume.jsonl');
  let calls = 0;
  const agent = async () => {
    calls++;
    return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, approvals: 0, stuckBlocks: 0 };
  };
  const first = await runCodingBenchmark({ set: two, arms: ['vanilla'], reps: 2, mode: 'mock', agent, journal, maxRuns: 2, tmpParent: scratch });
  assert.equal(first.ran, 2);
  await appendFile(journal, '{"taskId":"torn","ar');
  const second = await runCodingBenchmark({ set: two, arms: ['vanilla'], reps: 2, mode: 'mock', agent, journal, tmpParent: scratch });
  assert.equal(second.dropped, 1);
  assert.equal(second.skipped, 2);
  assert.equal(second.ran, 2);
  assert.equal(calls, 4, 'each (task, arm, rep) ran exactly once');
  const { results, dropped } = await readJournal(journal);
  assert.equal(dropped, 0, 'the torn line was compacted away');
  assert.equal(results.length, 4);
  assert.equal(pendingRuns(two, ['vanilla'], 2, results).length, 0);
});
await test('a network failure is retried and then journalled as "network"; resume tries it again', async () => {
  const journal = join(scratch, 'network.jsonl');
  let calls = 0;
  const agent = async () => {
    calls++;
    throw new Error('fetch failed: ECONNRESET');
  };
  const r = await runCodingBenchmark({ set: { ...two, tasks: [two.tasks[0]!] }, arms: ['vanilla'], reps: 1, mode: 'mock', agent, journal, networkRetries: 2, sleep: noSleep, tmpParent: scratch });
  assert.equal(calls, 3);
  assert.equal(r.results[0]!.status, 'network');
  assert.equal(r.results[0]!.attempts, 3);
  const plan = pendingRuns(two, ['vanilla'], 1, (await readJournal(journal)).results, [two.tasks[0]!.id]);
  assert.equal(plan.length, 1, 'a network row is pending again');
});
await test('a transient network failure then success journals one ok row', async () => {
  const journal = join(scratch, 'flaky.jsonl');
  let calls = 0;
  const agent = async () => {
    if (++calls === 1) throw new Error('socket hang up');
    return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, approvals: 0, stuckBlocks: 0 };
  };
  const r = await runCodingBenchmark({ set: { ...two, tasks: [two.tasks[0]!] }, arms: ['vanilla'], reps: 1, mode: 'mock', agent, journal, sleep: noSleep, tmpParent: scratch });
  assert.equal(calls, 2);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0]!.status, 'ok');
  assert.equal(r.results[0]!.attempts, 2);
  assert.equal(r.results[0]!.passed, false, 'the agent changed nothing, so the hidden test fails');
});
await test('any other failure is a failed run and is never retried', async () => {
  const journal = join(scratch, 'error.jsonl');
  let calls = 0;
  const agent = async () => {
    calls++;
    throw new Error('the model refused');
  };
  const r = await runCodingBenchmark({ set: { ...two, tasks: [two.tasks[0]!] }, arms: ['vanilla'], reps: 1, mode: 'mock', agent, journal, sleep: noSleep, tmpParent: scratch });
  assert.equal(calls, 1);
  assert.equal(r.results[0]!.status, 'error');
  const plan = pendingRuns(two, ['vanilla'], 1, (await readJournal(journal)).results, [two.tasks[0]!.id]);
  assert.equal(plan.length, 0, 'an error row is final');
});

/* ---------------------------- 6. mock end to end --------------------------- */

console.log('mock arms end to end');
await test('every arm, 3 reps, on a task subset: all pass, report is mock and comparable', async () => {
  const journal = join(scratch, 'e2e.jsonl');
  const subset = ['strkit', 'statkit', 'taskq'].map((repo) => set.tasks.find((t) => t.repo === repo && t.kind !== 'ci')!.id);
  subset.push(set.tasks.find((t) => t.kind === 'ci')!.id);
  const r = await runCodingBenchmark({
    set,
    arms: [...CODING_ARM_IDS],
    reps: 3,
    mode: 'mock',
    agent: mockCodingAgent(),
    journal,
    taskIds: subset,
    concurrency: 4,
    tmpParent: scratch,
  });
  assert.equal(r.ran, subset.length * CODING_ARM_IDS.length * 3);
  const failed = r.results.filter((x) => !x.passed).map((x) => `${x.taskId}/${x.arm}: ${x.error}`);
  assert.deepEqual(failed, []);
  const report = buildCodingReport(r.results);
  assert.equal(report.mode, 'mock');
  for (const a of report.arms) assert.ok(a.comparability === 'baseline' || a.comparability === 'comparable', a.arm + ' ' + a.comparability);
  // L1 on: raw `npm test` is redirected to the shaped tool, through the bridge.
  const sup = r.results.find((x) => x.arm === 'supervised')!;
  assert.match(sup.detail ?? '', /[1-9]\d* shaped-tool redirect/);
  const l1Off = r.results.find((x) => x.arm === 'loo-L1')!;
  assert.match(l1Off.detail ?? '', / 0 shaped-tool redirect/);
  assert.equal(r.results.find((x) => x.arm === 'vanilla')!.approvals, 0, 'vanilla never asks');
  assert.match(codingReportMarkdown(report), /Mock rows present/);
});

/* --------------------------- 7. live, fake binary -------------------------- */

console.log('live agent (fake binary)');
await test('parses claude -p JSON usage and cost', () => {
  const p = parseClaudePrintJson(
    'noise\n' +
      JSON.stringify({ type: 'result', is_error: false, num_turns: 4, result: 'done', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }),
  );
  assert.deepEqual(p.tokens, { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 });
  assert.equal(p.costUsd, 0.0123);
  assert.equal(p.turns, 4);
});
await test('vanilla live agent runs the binary in the repo and journals its usage', async () => {
  const fake = join(scratch, 'fake-claude.mjs');
  await writeFile(
    fake,
    [
      "import { writeFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "if (args[0] !== '-p' || !args.includes('--output-format')) process.exit(3);",
      "writeFileSync('argv.json', JSON.stringify(args));",
      "console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: 2, result: 'ok', total_cost_usd: 0.5, usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }));",
    ].join('\n'),
  );
  const task = set.tasks[0]!;
  const repo = await prepareRepo(set, task, scratch);
  try {
    const out = await vanillaClaudeAgent({ binary: fake })({ set, task, arm: CODING_ARMS.vanilla, rep: 0, repoDir: repo.dir, signal });
    assert.deepEqual(out.tokens, { input: 7, output: 9, cacheRead: 100, cacheWrite: 5 });
    assert.equal(out.costUsd, 0.5);
    const argv = JSON.parse(await readFile(join(repo.dir, 'argv.json'), 'utf8')) as string[];
    assert.equal(argv[1], task.prompt, 'the task prompt is passed as is');
    assert.ok(argv.includes('--permission-mode'));
  } finally {
    await repo.cleanup();
  }
});
await test('a missing binary is an error the runner does not retry', async () => {
  const journal = join(scratch, 'nobin.jsonl');
  const r = await runCodingBenchmark({
    set: { ...set, tasks: [set.tasks[0]!] },
    arms: ['vanilla'],
    reps: 1,
    mode: 'live',
    agent: vanillaClaudeAgent({ binary: join(scratch, 'does-not-exist.mjs') }),
    journal,
    sleep: noSleep,
    tmpParent: scratch,
  });
  assert.equal(r.results[0]!.status, 'error');
  assert.equal(r.results[0]!.attempts, 1);
});
await test('live Zephyr arms are refused up front, vanilla is allowed', () => {
  assert.deepEqual(liveArmProblems(['vanilla']), []);
  const p = liveArmProblems(['vanilla', 'supervised', 'loo-L1']);
  assert.equal(p.length, 2);
  assert.match(p[0]!, /^supervised:/);
});

await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
console.log(failures ? `\n${failures} failure(s)` : '\nall coding-benchmark checks passed');
process.exit(failures ? 1 : 0);
