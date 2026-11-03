/**
 * The unattended coding-benchmark runner.
 *
 * - One agent run per (task, arm, repetition). A run that fails is a failed run; it is
 *   never retried to get a better answer.
 * - The only retry is for transport failures (isNetworkFailure): the agent never got
 *   to work, so the run did not happen. After the allowed retries such a row is
 *   journalled as `status: 'network'`, excluded from the report, and attempted again
 *   on the next resume.
 * - Every finished run is appended to a JSONL journal before the next starts, so a
 *   crash loses at most the runs in flight. On start the journal is read back, a
 *   truncated last line is dropped, and every key already journalled (other than
 *   `network`) is skipped.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  codingRunKey,
  codingRunResultSchema,
  type CodingArm,
  type CodingArmId,
  type CodingRunResult,
  type CodingTokens,
  CODING_ARMS,
} from '@htn/shared';
import { isNetworkFailure } from '../../../lib/networkFailure.js';
import { runHiddenTest, type HiddenTestResult } from './hiddenTests.js';
import { hiddenIsolationProblems, hiddenTestOf, prepareRepo, type CodingTask, type CodingTaskSet } from './taskSet.js';

/** What an agent reports about one run. Wall time and the hidden test are measured by the runner. */
export interface AgentOutcome {
  /** Directory holding the agent's final code; defaults to the prepared repo. */
  worktree?: string;
  tokens: CodingTokens;
  costUsd: number;
  approvals: number;
  stuckBlocks: number;
  detail?: string;
  /** Called after the hidden test ran (e.g. to remove a worktree the agent opened). */
  release?: () => Promise<void>;
}

export interface CodingAgentInput {
  set: CodingTaskSet;
  task: CodingTask;
  arm: CodingArm;
  rep: number;
  /** A fresh git repo with the fixture at HEAD. */
  repoDir: string;
  signal: AbortSignal;
}

/** Runs one task under one arm. Throws on failure; a network failure must say so in its message. */
export type CodingAgent = (input: CodingAgentInput) => Promise<AgentOutcome>;

export interface RunnerOptions {
  set: CodingTaskSet;
  arms: CodingArmId[];
  reps: number;
  mode: 'mock' | 'live';
  agent: CodingAgent;
  /** JSONL journal; resumes from it when it exists. */
  journal: string;
  /** Runs in flight at once. Default 1. */
  concurrency?: number;
  /** Retries per run for network failures only. Default 2. */
  networkRetries?: number;
  /** Only these task ids. */
  taskIds?: string[];
  /** Stop after this many new runs (budget). */
  maxRuns?: number;
  signal?: AbortSignal;
  onResult?: (r: CodingRunResult, progress: { done: number; total: number }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Parent of the per-run temp repos. */
  tmpParent?: string;
}

/** Results in a journal; malformed lines (a crash mid-write) are skipped. */
export async function readJournal(path: string): Promise<{ results: CodingRunResult[]; dropped: number }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { results: [], dropped: 0 };
  }
  const results: CodingRunResult[] = [];
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      results.push(codingRunResultSchema.parse(JSON.parse(line)));
    } catch {
      dropped++;
    }
  }
  return { results, dropped };
}

/** Rewrite a journal with only its valid rows, so appends never land on a torn line. */
async function compactJournal(path: string, results: CodingRunResult[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, results.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
}

export interface RunPlanItem {
  task: CodingTask;
  arm: CodingArmId;
  rep: number;
}

/** Every (task, arm, rep) not yet journalled with a real outcome. Interleaved by rep so a partial run covers every arm. */
export function pendingRuns(
  set: CodingTaskSet,
  arms: CodingArmId[],
  reps: number,
  journalled: CodingRunResult[],
  taskIds?: string[],
): RunPlanItem[] {
  const done = new Set(journalled.filter((r) => r.status !== 'network').map(codingRunKey));
  const tasks = taskIds ? set.tasks.filter((t) => taskIds.includes(t.id)) : set.tasks;
  const out: RunPlanItem[] = [];
  for (let rep = 0; rep < reps; rep++)
    for (const task of tasks)
      for (const arm of arms) if (!done.has(codingRunKey({ taskId: task.id, arm, rep }))) out.push({ task, arm, rep });
  return out;
}

const ZERO: CodingTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** One run end to end: fresh repo → isolation check → agent → hidden test → cleanup. */
export async function runOne(
  item: RunPlanItem,
  opts: Pick<RunnerOptions, 'set' | 'mode' | 'agent' | 'networkRetries' | 'now' | 'sleep' | 'tmpParent'> & {
    signal: AbortSignal;
  },
): Promise<CodingRunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.networkRetries ?? 2;
  const hiddenTest = hiddenTestOf(opts.set, item.task);
  const base = { taskId: item.task.id, arm: item.arm, rep: item.rep, mode: opts.mode };
  let attempts = 0;
  for (;;) {
    attempts++;
    const repo = await prepareRepo(opts.set, item.task, opts.tmpParent);
    const started = now();
    let outcome: AgentOutcome | undefined;
    try {
      const problems = await hiddenIsolationProblems(repo.dir, hiddenTest);
      if (problems.length) throw new Error('hidden test not isolated: ' + problems.join('; '));
      outcome = await opts.agent({
        set: opts.set,
        task: item.task,
        arm: CODING_ARMS[item.arm],
        rep: item.rep,
        repoDir: repo.dir,
        signal: opts.signal,
      });
      const wallMs = now() - started;
      const hidden: HiddenTestResult = await runHiddenTest({
        worktree: outcome.worktree ?? repo.dir,
        hiddenTest,
        ...(item.task.timeoutMs ? { timeoutMs: item.task.timeoutMs } : {}),
        signal: opts.signal,
      });
      return {
        ...base,
        status: 'ok',
        passed: hidden.passed,
        hidden: { pass: hidden.pass, fail: hidden.fail, timedOut: hidden.timedOut },
        tokens: outcome.tokens,
        costUsd: outcome.costUsd,
        wallMs,
        approvals: outcome.approvals,
        stuckBlocks: outcome.stuckBlocks,
        attempts,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(hidden.passed ? {} : { error: 'hidden test failed: ' + lastLines(hidden.output) }),
        at: new Date(now()).toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const network = isNetworkFailure(message) && !opts.signal.aborted;
      if (network && attempts <= retries) {
        await sleep(Math.min(30_000, 1000 * 2 ** (attempts - 1)));
        continue;
      }
      return {
        ...base,
        status: network ? 'network' : 'error',
        passed: false,
        hidden: { pass: 0, fail: 0, timedOut: false },
        tokens: outcome?.tokens ?? ZERO,
        costUsd: outcome?.costUsd ?? 0,
        wallMs: now() - started,
        approvals: outcome?.approvals ?? 0,
        stuckBlocks: outcome?.stuckBlocks ?? 0,
        attempts,
        error: message.slice(0, 2000),
        at: new Date(now()).toISOString(),
      };
    } finally {
      await outcome?.release?.().catch(() => {});
      await repo.cleanup().catch(() => {});
    }
  }
}

function lastLines(output: string): string {
  return output.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 600);
}

export interface RunnerSummary {
  results: CodingRunResult[];
  ran: number;
  skipped: number;
  dropped: number;
}

/** Run every pending cell, journalling each result as it lands. Returns the full journal. */
export async function runCodingBenchmark(opts: RunnerOptions): Promise<RunnerSummary> {
  const { results: prior, dropped } = await readJournal(opts.journal);
  await compactJournal(opts.journal, prior);
  const plan = pendingRuns(opts.set, opts.arms, opts.reps, prior, opts.taskIds);
  const todo = opts.maxRuns !== undefined ? plan.slice(0, opts.maxRuns) : plan;
  const signal = opts.signal ?? new AbortController().signal;
  const results = [...prior];
  const total = todo.length;
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const item = todo[next++];
      if (!item) return;
      const r = await runOne(item, { ...opts, signal });
      await appendFile(opts.journal, JSON.stringify(r) + '\n', 'utf8');
      results.push(r);
      done++;
      opts.onResult?.(r, { done, total });
    }
  }
  const workers = Math.max(1, Math.min(opts.concurrency ?? 1, todo.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return { results, ran: done, skipped: prior.length, dropped };
}
