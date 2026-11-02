/**
 * Raw log → digest under a token cap.
 *
 * Every failing id is always kept: an agent that cannot see which tests failed
 * re-runs the suite to find out, which costs more than the digest saved. What
 * shrinks under pressure is detail, in this order: traces get shorter, then go,
 * then assertions get shorter. The full text of each failure stays behind the
 * handle for `zephyr_test_output`.
 */

import type { Diagnostic, DiagnosticsDigest, Digest, ParsedTests, RunFacts } from './types.js';
import { estimateTokens } from './types.js';

export const DEFAULT_DIGEST_CAP_TOKENS = 2_000;

interface Shape {
  traceLines: number;
  traceChars: number;
  assertionChars: number;
}

const SHAPES: Shape[] = [
  { traceLines: 12, traceChars: 600, assertionChars: 300 },
  { traceLines: 4, traceChars: 240, assertionChars: 200 },
  { traceLines: 0, traceChars: 0, assertionChars: 160 },
  { traceLines: 0, traceChars: 0, assertionChars: 80 },
  { traceLines: 0, traceChars: 0, assertionChars: 0 },
];

function clip(text: string, chars: number): string {
  const t = text.trim();
  if (chars <= 0) return '';
  return t.length <= chars ? t : t.slice(0, Math.max(0, chars - 1)) + '…';
}

function clipLines(text: string, lines: number, chars: number): string {
  if (lines <= 0 || chars <= 0) return '';
  const kept = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(0, lines)
    .join('\n');
  return clip(kept, chars);
}

/** The JSON the model sees. Kept separate so its size is what gets measured. */
export function renderDigest(digest: Digest | DiagnosticsDigest, facts: RunFacts): string {
  const head =
    `${facts.command} exited ${facts.exitCode ?? 'without a code'}` +
    (facts.timedOut ? ' (timed out)' : '') +
    (facts.truncated ? ' (output truncated)' : '') +
    ` in ${Math.round(facts.durationMs / 100) / 10}s`;
  return head + '\n' + JSON.stringify(digest);
}

export interface TestDigestInput {
  parsed: ParsedTests;
  raw: string;
  handle: string;
  facts: RunFacts;
  capTokens?: number;
}

export function buildTestDigest(input: TestDigestInput): { digest: Digest; text: string } {
  const cap = input.capTokens ?? DEFAULT_DIGEST_CAP_TOKENS;
  const rawTokens = estimateTokens(input.raw);
  const { parsed } = input;
  let best: { digest: Digest; text: string } | null = null;
  for (const shape of SHAPES) {
    const digest: Digest = {
      total: parsed.total,
      passed: parsed.passed,
      failed: Math.max(parsed.failed, parsed.failures.length),
      failures: parsed.failures.map((f) => ({
        id: f.id,
        assertion: clip(f.assertion, shape.assertionChars),
        trace: clipLines(f.trace === f.assertion ? '' : f.trace, shape.traceLines, shape.traceChars),
      })),
      handle: input.handle,
      rawTokens,
      digestTokens: 0,
    };
    const text = finalize(digest, input.facts);
    best = { digest, text };
    if (digest.digestTokens <= cap) break;
  }
  return best!;
}

/** Measure the rendered digest, including the count itself (fixed point in two passes). */
function finalize<T extends { digestTokens: number }>(digest: T, facts: RunFacts): string {
  let text = renderDigest(digest as unknown as Digest, facts);
  digest.digestTokens = estimateTokens(text);
  text = renderDigest(digest as unknown as Digest, facts);
  digest.digestTokens = estimateTokens(text);
  return text;
}

export interface DiagnosticsDigestInput {
  diagnostics: Diagnostic[];
  raw: string;
  handle: string;
  facts: RunFacts;
  capTokens?: number;
}

/**
 * Errors first, then warnings. Unlike test ids, diagnostics past the cap are
 * counted in `omitted` and dropped: a build with 3,000 lint warnings has no ids
 * worth listing one by one, and the handle still serves them all.
 */
export function buildDiagnosticsDigest(input: DiagnosticsDigestInput): { digest: DiagnosticsDigest; text: string } {
  const cap = input.capTokens ?? DEFAULT_DIGEST_CAP_TOKENS;
  const sorted = [...input.diagnostics].sort(
    (a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
  );
  const errors = sorted.filter((d) => d.severity === 'error').length;
  const warnings = sorted.length - errors;
  const ok = input.facts.exitCode === 0 && !input.facts.timedOut;
  const make = (count: number, messageChars: number): DiagnosticsDigest => ({
    ok,
    errors,
    warnings,
    diagnostics: sorted.slice(0, count).map((d) => ({ ...d, message: clip(d.message, messageChars) })),
    omitted: Math.max(0, sorted.length - count),
    handle: input.handle,
    rawTokens: estimateTokens(input.raw),
    digestTokens: 0,
  });

  let count = sorted.length;
  let digest = make(count, 240);
  let text = finalize(digest, input.facts);
  while (digest.digestTokens > cap && count > 0) {
    // Shrink proportionally, then step down one at a time near the boundary.
    count = Math.min(count - 1, Math.floor((count * cap) / digest.digestTokens));
    digest = make(Math.max(0, count), 160);
    text = finalize(digest, input.facts);
  }
  return { digest, text };
}

export function digestLine(kind: 'test' | 'build' | 'lint', rawTokens: number, digestTokens: number): string {
  const what = kind === 'test' ? 'test output' : kind + ' output';
  return `${what} digested: ${rawTokens} → ${digestTokens} tokens`;
}
