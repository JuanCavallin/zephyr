/**
 * A per-task summary written from the evidence bundle only (docs/cacp-09, "Per-task
 * summary generated from the evidence bundle"). Every line states something the bundle
 * records; nothing is inferred. A saving against the baseline is shown only when the
 * bundle carries a baseline measured for the same task.
 */

import type { EvidenceBundle } from './coding.js';

export interface EvidenceSummary {
  /** One line for lists: diff size, test outcome, cost. */
  headline: string;
  /** Short lines, one fact each, in reading order. */
  lines: string[];
  /** True when the after-tests have no failures and at least one test ran. */
  green: boolean;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const tokens = (n: number) => (n >= 10_000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const dollars = (cents: number) => '$' + (cents / 100).toFixed(cents < 100 ? 3 : 2);
const seconds = (ms: number) => (ms >= 60_000 ? (ms / 60_000).toFixed(1) + ' min' : (ms / 1000).toFixed(1) + ' s');

function tally(t: { passed: number; failed: number; skipped: number }): string {
  return `${t.passed} passed, ${t.failed} failed` + (t.skipped ? `, ${t.skipped} skipped` : '');
}

function totalTokens(u: EvidenceBundle['usage']): number {
  return u.tokensIn + u.tokensOut + u.cacheReadTokens + u.cacheWriteTokens;
}

export function summarizeEvidence(b: EvidenceBundle): EvidenceSummary {
  const lines: string[] = [];
  const after = b.tests.after;
  const ran = after.passed + after.failed;
  const green = ran > 0 && after.failed === 0;

  lines.push(
    `Changed ${plural(b.diff.files, 'file')} (+${b.diff.insertions} −${b.diff.deletions}), diff ${b.diff.hash.slice(0, 12)}.`,
  );

  const before = b.tests.before ? `before: ${tally(b.tests.before)}; ` : '';
  lines.push(`Tests ${before}after: ${tally(after)}.`);
  if (ran === 0) lines.push('No tests ran after the change; nothing here proves it works.');
  const jev = b.tests.selected.filter((s) => !s.fallback).length;
  const fallback = b.tests.selected.length - jev;
  if (b.tests.selected.length)
    lines.push(
      `Selected ${plural(b.tests.selected.length, 'test')}` +
        (jev && fallback ? ` (${jev} by relevance score, ${fallback} by fallback)` : fallback ? ' (deterministic fallback)' : ' (by relevance score)') +
        '.',
    );
  if (b.tests.added.length) lines.push(`Added tests: ${b.tests.added.join(', ')}.`);
  if (b.tests.modified.length) lines.push(`Modified existing tests: ${b.tests.modified.join(', ')}.`);

  if (b.protectedPathApprovals.length)
    lines.push(
      `Protected paths edited with approval: ${b.protectedPathApprovals.map((p) => `${p.path} (${p.approvalId})`).join(', ')}.`,
    );
  if (b.checkpoints.length) lines.push(`${plural(b.checkpoints.length, 'checkpoint')} to rewind to.`);
  if (b.walkthrough) lines.push(`Walkthrough: ${plural(b.walkthrough.steps.length, 'step')} at ${b.walkthrough.previewUrl}.`);

  const u = b.usage;
  lines.push(
    `Used ${tokens(totalTokens(u))} tokens (in ${tokens(u.tokensIn)}, out ${tokens(u.tokensOut)}, cache read ${tokens(u.cacheReadTokens)}, cache write ${tokens(u.cacheWriteTokens)}), ${dollars(u.costCents)}, ${seconds(u.wallMs)}.`,
  );
  if (b.baseline) {
    const base = totalTokens(b.baseline);
    const now = totalTokens(u);
    if (base > 0) {
      const saved = 1 - now / base;
      lines.push(
        saved >= 0
          ? `Measured baseline: ${tokens(base)} tokens; this run used ${Math.round(saved * 100)}% fewer.`
          : `Measured baseline: ${tokens(base)} tokens; this run used ${Math.round(-saved * 100)}% more.`,
      );
    }
  }

  lines.push(
    b.egress.calls
      ? `Network: ${plural(b.egress.calls, 'call')} to ${b.egress.destinations.join(', ') || 'unrecorded destinations'}.`
      : 'Network: no outbound calls.',
  );

  const headline =
    `${b.taskId ?? b.runId}: ${plural(b.diff.files, 'file')} +${b.diff.insertions}/−${b.diff.deletions}, ` +
    (ran === 0 ? 'no tests ran' : green ? `${after.passed} tests green` : `${after.failed} failing`) +
    `, ${tokens(totalTokens(u))} tokens, ${dollars(u.costCents)}`;
  return { headline, lines, green };
}
