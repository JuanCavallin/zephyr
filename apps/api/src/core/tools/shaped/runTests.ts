/**
 * `zephyr_run_tests`: run the worktree's test command and return a digest.
 *
 * Report formats are tried best-first: a JUnit file the runner was asked to
 * write, JUnit printed to stdout, TAP, then the raw-text fallback. The raw log
 * (capped) and each failure's full detail go into the output store behind the
 * digest's handle.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCommand, type ShapedKind } from './commands.js';
import { buildDiagnosticsDigest, buildTestDigest, digestLine } from './digest.js';
import { describeCommand, runBounded, type BoundedRunResult } from './exec.js';
import type { OutputStore } from './outputStore.js';
import { parseDiagnostics } from './parsers/diagnostics.js';
import { looksLikeJunit, parseJunit } from './parsers/junit.js';
import { parseRawTestOutput } from './parsers/rawFallback.js';
import { looksLikeTap, parseTap } from './parsers/tap.js';
import type { DiagnosticsDigest, Digest, ParsedTests, RunFacts } from './types.js';

export interface ShapedRunConfig {
  store: OutputStore;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killAfterBytes?: number;
  capTokens?: number;
  overrides?: Partial<Record<ShapedKind, string[]>>;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ShapedRunInput {
  runId: string;
  worktree: string;
  filter?: string;
  signal?: AbortSignal;
}

export type ShapedRunResult =
  | {
      ok: true;
      kind: ShapedKind;
      /** "test output digested: N → M tokens" */
      line: string;
      /** What the model receives: the line, the run facts and the digest JSON. */
      text: string;
      digest: Digest | DiagnosticsDigest;
      facts: RunFacts;
    }
  | { ok: false; kind: ShapedKind; code: 'NO_COMMAND' | 'BAD_FILTER' | 'SPAWN_FAILED'; message: string };

export const SHAPED_DEFAULTS = {
  timeoutMs: 10 * 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
} as const;

/** Best available parse of a test run. Exported for the parser tests. */
export function parseTestOutput(output: string, junitXml?: string): ParsedTests {
  if (junitXml && looksLikeJunit(junitXml)) return parseJunit(junitXml);
  if (looksLikeJunit(output)) {
    const start = output.search(/<\?xml|<testsuites?[\s>]/);
    const parsed = parseJunit(output.slice(Math.max(0, start)));
    if (parsed.total > 0) return parsed;
  }
  if (looksLikeTap(output)) {
    const parsed = parseTap(output);
    if (parsed.total > 0) return parsed;
  }
  return parseRawTestOutput(output);
}

function factsOf(argv: string[], run: BoundedRunResult): RunFacts {
  return {
    command: describeCommand(argv),
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    truncated: run.truncated,
    durationMs: run.durationMs,
  };
}

function runNote(run: BoundedRunResult, cfg: { timeoutMs: number }): string {
  if (run.timedOut) return `\nThe command was killed after ${Math.round(cfg.timeoutMs / 1000)}s; results are partial.`;
  if (run.runaway) return '\nThe command was killed for writing too much output; results are partial.';
  if (run.aborted) return '\nThe run was cancelled; results are partial.';
  return '';
}

export async function runShaped(kind: ShapedKind, input: ShapedRunInput, cfg: ShapedRunConfig): Promise<ShapedRunResult> {
  const timeoutMs = cfg.timeoutMs ?? SHAPED_DEFAULTS.timeoutMs;
  const maxOutputBytes = cfg.maxOutputBytes ?? SHAPED_DEFAULTS.maxOutputBytes;
  const reportDir = await mkdtemp(join(tmpdir(), 'zephyr-shaped-'));
  try {
    const detected = detectCommand(input.worktree, kind, {
      reportDir,
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
      ...(cfg.overrides ? { overrides: cfg.overrides } : {}),
    });
    if (!detected.ok) {
      const code = /filter/.test(detected.message) ? 'BAD_FILTER' : 'NO_COMMAND';
      return { ok: false, kind, code, message: detected.message };
    }
    const { argv, junitPath } = detected.command;
    const run = await runBounded({
      argv,
      cwd: input.worktree,
      timeoutMs,
      maxOutputBytes,
      ...(cfg.killAfterBytes !== undefined ? { killAfterBytes: cfg.killAfterBytes } : {}),
      ...(cfg.baseEnv ? { baseEnv: cfg.baseEnv } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (run.spawnError) {
      return { ok: false, kind, code: 'SPAWN_FAILED', message: `Could not start ${describeCommand(argv)}: ${run.spawnError}` };
    }
    const facts = factsOf(argv, run);

    if (kind === 'test') {
      const junit = junitPath ? await readFile(junitPath, 'utf8').catch(() => undefined) : undefined;
      const parsed = parseTestOutput(run.output, junit);
      const details = new Map(parsed.failures.map((f) => [f.id, f.detail ?? f.trace] as const));
      const handle = cfg.store.put({ runId: input.runId, kind, command: facts.command, raw: run.output, details });
      const { digest, text } = buildTestDigest({
        parsed,
        raw: run.output,
        handle,
        facts,
        ...(cfg.capTokens !== undefined ? { capTokens: cfg.capTokens } : {}),
      });
      const line = digestLine(kind, digest.rawTokens, digest.digestTokens);
      return { ok: true, kind, line, text: line + '\n' + text + runNote(run, { timeoutMs }), digest, facts };
    }

    const { diagnostics } = parseDiagnostics(run.output);
    const details = new Map(diagnostics.map((d) => [d.id, d.detail] as const));
    const handle = cfg.store.put({ runId: input.runId, kind, command: facts.command, raw: run.output, details });
    const { digest, text } = buildDiagnosticsDigest({
      diagnostics: diagnostics.map(({ detail: _detail, ...d }) => d),
      raw: run.output,
      handle,
      facts,
      ...(cfg.capTokens !== undefined ? { capTokens: cfg.capTokens } : {}),
    });
    const line = digestLine(kind, digest.rawTokens, digest.digestTokens);
    return { ok: true, kind, line, text: line + '\n' + text + runNote(run, { timeoutMs }), digest, facts };
  } finally {
    await rm(reportDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function runTests(input: ShapedRunInput, cfg: ShapedRunConfig): Promise<ShapedRunResult> {
  return runShaped('test', input, cfg);
}
