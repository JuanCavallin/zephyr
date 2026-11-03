/**
 * Coding benchmark CLI (docs/cacp-09-benchmark-cli-demo.md).
 *
 *   pnpm --filter @htn/api benchmark:coding                       # mock, every arm, 3 reps
 *   pnpm --filter @htn/api benchmark:coding -- --report bench.md
 *   pnpm --filter @htn/api benchmark:coding -- --report-only
 *   pnpm --filter @htn/api benchmark:coding -- --mode live --arms vanilla --reps 3 --yes-spend
 *
 * Unattended and resumable: every finished run is appended to the journal; rerunning
 * the same command skips what is already there. A run is never retried for a better
 * answer, only when the transport failed (the agent never got to work).
 *
 * Flags:
 *   --mode mock|live      mock (default) replays reference fixes offline. live spends money
 *                         and requires --yes-spend.
 *   --arms a,b,...        arm ids (default: every arm in mock; vanilla in live)
 *   --reps <n>            repetitions per (task, arm); default 3, the minimum the report accepts
 *   --tasks a,b,...       only these task ids
 *   --journal <file>      default .data/bench/coding.jsonl (CODING_BENCH_JOURNAL)
 *   --concurrency <n>     runs in flight (default 1)
 *   --max-runs <n>        stop after this many new runs
 *   --report <file.md>    also write the Markdown report
 *   --json <file>         also write the report as JSON
 *   --report-only         run nothing; rebuild the report from the journal
 *   --claude <path>       live: the claude executable (default `claude` on PATH)
 *   --model <id>          live: model for claude -p
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCodingReport, CODING_ARM_IDS, isCodingArmId, type CodingArmId } from '@htn/shared';
import {
  codingReportMarkdown,
  loadCodingTaskSet,
  readJournal,
  runCodingBenchmark,
} from '../src/core/benchmark/coding/index.js';
import { DEFAULT_CODING_JOURNAL, mockCodingAgent } from '../src/services/benchmarkCoding.service.js';
import { liveArmProblems, vanillaClaudeAgent } from '../src/services/benchmarkCoding.live.js';

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const has = (name: string) => process.argv.includes('--' + name);
const list = (name: string) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);
const int = (name: string, fallback?: number) => {
  const v = flag(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

const mode = (flag('mode') ?? 'mock') as 'mock' | 'live';
if (mode !== 'mock' && mode !== 'live') throw new Error('--mode must be mock or live');
const journal = flag('journal') ?? DEFAULT_CODING_JOURNAL;
const set = await loadCodingTaskSet();

async function writeReports(): Promise<void> {
  const { results } = await readJournal(journal);
  {
    const report = buildCodingReport(results, { tasks: set.tasks.map((t) => t.id).filter((id) => results.some((r) => r.taskId === id)) });
    const md = codingReportMarkdown(report);
    console.log('\n' + md);
    const mdPath = flag('report');
    if (mdPath) {
      mkdirSync(dirname(mdPath), { recursive: true });
      writeFileSync(mdPath, md);
      console.log('wrote ' + mdPath);
    }
    const jsonPath = flag('json');
    if (jsonPath) {
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      console.log('wrote ' + jsonPath);
    }
  }
}

if (has('report-only')) {
  await writeReports();
  process.exit(0);
}

const armIds = list('arms') ?? (mode === 'live' ? ['vanilla'] : [...CODING_ARM_IDS]);
const bad = armIds.filter((a) => !isCodingArmId(a));
if (bad.length) throw new Error('unknown arm(s): ' + bad.join(', ') + '. Known: ' + CODING_ARM_IDS.join(', '));
const arms = armIds as CodingArmId[];
const taskIds = list('tasks');
if (taskIds) {
  const unknown = taskIds.filter((id) => !set.tasks.some((t) => t.id === id));
  if (unknown.length) throw new Error('unknown task(s): ' + unknown.join(', '));
}

if (mode === 'live') {
  const problems = liveArmProblems(arms);
  if (problems.length) {
    console.error('Cannot run live:\n  ' + problems.join('\n  '));
    process.exit(2);
  }
  if (!has('yes-spend')) {
    console.error('--mode live runs Claude Code against real models and costs money. Re-run with --yes-spend.');
    process.exit(2);
  }
}

const agent =
  mode === 'live'
    ? vanillaClaudeAgent({
        ...(flag('claude') ? { binary: flag('claude')! } : {}),
        ...(flag('model') ? { model: flag('model')! } : {}),
      })
    : mockCodingAgent();

const controller = new AbortController();
process.once('SIGINT', () => {
  console.log('\ninterrupted; finished runs are journalled, rerun to resume');
  controller.abort();
});

console.log(`coding benchmark: mode=${mode} arms=${arms.join(',')} reps=${int('reps', 3)} journal=${journal}`);
const summary = await runCodingBenchmark({
  set,
  arms,
  reps: int('reps', 3)!,
  mode,
  agent,
  journal,
  concurrency: int('concurrency', 1)!,
  ...(taskIds ? { taskIds } : {}),
  ...(int('max-runs') !== undefined ? { maxRuns: int('max-runs')! } : {}),
  signal: controller.signal,
  onResult: (r, p) =>
    console.log(
      `[${p.done}/${p.total}] ${r.taskId} ${r.arm} #${r.rep}: ${r.status === 'ok' ? (r.passed ? 'pass' : 'FAIL') : r.status}` +
        (r.attempts > 1 ? ` (${r.attempts} attempts)` : '') +
        (r.error && !r.passed ? ' — ' + r.error.slice(0, 160) : ''),
    ),
});
console.log(`ran ${summary.ran}, already journalled ${summary.skipped}${summary.dropped ? `, dropped ${summary.dropped} torn line(s)` : ''}`);
await writeReports();
