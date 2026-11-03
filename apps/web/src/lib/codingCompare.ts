/**
 * Words and numbers for the "harness vs harness under Zephyr" comparison
 * (docs/cacp-09-benchmark-cli-demo.md). Pure, so the rules that keep the page honest are
 * tested: a saving is stated only when the report marks the arm comparable, and mock
 * numbers always carry a note that they are not real cost.
 */

import type {
  CodingArmReport,
  CodingBenchmarkReport,
  LeverVerdict,
  Spread,
} from '@htn/shared';

// Same rule as runWork's compactTokens; repeated because the web test runner loads each
// lib on its own and cannot resolve extensionless imports between them.
function compactTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export type SpreadUnit = 'tokens' | 'usd' | 'ms' | 'count';

function format(value: number, unit: SpreadUnit): string {
  switch (unit) {
    case 'tokens':
      return compactTokens(Math.round(value));
    case 'usd':
      // Benchmark runs often cost under a cent; two decimals would show them all as $0.01.
      return '$' + value.toFixed(value !== 0 && Math.abs(value) < 0.1 ? 4 : 2);
    case 'ms':
      return (value / 1000).toFixed(1) + 's';
    case 'count':
      return String(Math.round(value * 10) / 10);
  }
}

/** "14k (12k–16k)": the median, then the interquartile range when it has width. */
export function spreadLabel(s: Spread, unit: SpreadUnit): string {
  const median = format(s.median, unit);
  if (s.p25 === s.p75) return median;
  return `${median} (${format(s.p25, unit)}–${format(s.p75, unit)})`;
}

export function pct(fraction: number): string {
  return Math.round(fraction * 100) + '%';
}

function change(fraction: number, less: string, more: string): string {
  return fraction >= 0 ? `${pct(fraction)} ${less}` : `${pct(-fraction)} ${more}`;
}

/** The paired saving against the harness alone, or null when the report shows none. */
export function savingsLabel(arm: CodingArmReport): string | null {
  if (arm.comparability !== 'comparable' || !arm.savings) return null;
  const s = arm.savings;
  return (
    `${change(s.totalTokens, 'fewer tokens', 'more tokens')} · ${change(s.costUsd, 'lower cost', 'higher cost')} · ` +
    `${change(s.wallMs, 'faster', 'slower')}, paired over ${s.tasks} task${s.tasks === 1 ? '' : 's'}`
  );
}

export function comparabilityNote(arm: CodingArmReport): string {
  switch (arm.comparability) {
    case 'baseline':
      return 'Baseline';
    case 'comparable':
      return 'Comparable: pass rate within noise of the baseline';
    case 'not_comparable':
      return `Pass rate ${pct(arm.passRate)} is below the baseline by more than the noise bar (±${pct(arm.noise)}); savings are not shown`;
    case 'insufficient':
      return 'Too few runs to compare';
  }
}

export interface Headline {
  vanilla?: CodingArmReport;
  supervised?: CodingArmReport;
  /** One sentence the page may state as a result; null when the report does not support one. */
  claim: string | null;
  /** Why there is no claim, or what the claim rests on. */
  reason: string;
}

export function headline(report: CodingBenchmarkReport): Headline {
  const vanilla = report.arms.find((a) => a.arm === 'vanilla');
  const supervised = report.arms.find((a) => a.arm === 'supervised');
  const base = { ...(vanilla ? { vanilla } : {}), ...(supervised ? { supervised } : {}) };
  if (report.mode === 'empty' || report.arms.length === 0)
    return { ...base, claim: null, reason: 'No runs recorded yet. Run `pnpm benchmark:coding` to fill this page.' };
  if (!vanilla) return { ...base, claim: null, reason: 'No runs of the harness alone yet; there is nothing to compare against.' };
  if (!supervised) return { ...base, claim: null, reason: 'No supervised runs yet.' };
  switch (supervised.comparability) {
    case 'comparable': {
      const s = supervised.savings;
      if (!s) return { ...base, claim: null, reason: 'Comparable, but no paired tasks to measure savings on.' };
      return {
        ...base,
        claim: `${change(s.totalTokens, 'fewer tokens', 'more tokens')} at the same pass rate`,
        reason: `Median of per-task medians, paired over ${s.tasks} task${s.tasks === 1 ? '' : 's'}.`,
      };
    }
    case 'not_comparable':
      return {
        ...base,
        claim: null,
        reason: `Under Zephyr the pass rate was ${pct(supervised.passRate)} against ${pct(vanilla.passRate)}, outside the noise bar, so token savings would not be a fair comparison.`,
      };
    default:
      return {
        ...base,
        claim: null,
        reason: `Each task needs at least ${report.minRunsPerCell} runs per task in both arms before a saving is stated.`,
      };
  }
}

/** A note the page must show next to the numbers, or null for an all-live report. */
export function modeNote(mode: CodingBenchmarkReport['mode']): string | null {
  switch (mode) {
    case 'mock':
      return 'These numbers come from the scripted harness. They test the measuring, not the product, and say nothing about real cost.';
    case 'mixed':
      return 'This report is a mix of scripted and live runs; read the live rows only.';
    case 'empty':
      return null;
    case 'live':
      return null;
  }
}

export function verdictNote(v: LeverVerdict): string {
  switch (v.verdict) {
    case 'harmful':
      return `Removing ${v.lever} raised the pass rate from ${pct(v.passWith)} to ${pct(v.passWithout)}: the lever hurts.`;
    case 'neutral_or_helpful':
      return `With ${v.lever}: ${pct(v.passWith)}; without: ${pct(v.passWithout)}. No harm beyond noise (±${pct(v.noise)}).`;
    case 'insufficient':
      return 'Not enough runs to judge this lever.';
  }
}
