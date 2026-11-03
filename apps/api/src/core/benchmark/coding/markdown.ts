/**
 * The coding report as Markdown, for `--report` and for pasting into docs. Mock reports
 * carry a banner: their numbers show the pipeline works, not what Zephyr saves.
 */

import type { CodingBenchmarkReport, Spread } from '@htn/shared';

const pct = (x: number) => (x * 100).toFixed(0) + '%';
const num = (x: number) => (Math.abs(x) >= 1000 ? (x / 1000).toFixed(1) + 'k' : x.toFixed(x % 1 ? 2 : 0));
const spread = (s: Spread, f: (x: number) => string = num) => `${f(s.median)} (${f(s.p25)}–${f(s.p75)})`;
/** A paired saving: positive is cheaper than vanilla. */
const delta = (s: number) => (s >= 0 ? `saves ${pct(s)}` : `${pct(-s)} more`);
const usd =(x: number) => '$' + x.toFixed(4);
const secs = (ms: number) => (ms / 1000).toFixed(1) + 's';

export function codingReportMarkdown(r: CodingBenchmarkReport): string {
  const out: string[] = [];
  out.push('# Coding benchmark', '');
  out.push(`Protocol \`${r.protocol}\`, mode **${r.mode}**, ${r.tasks.length} task(s), generated ${r.generatedAt}.`, '');
  if (r.mode === 'mock' || r.mode === 'mixed')
    out.push(
      '> **Mock rows present.** The scripted harness replays reference fixes with synthetic token counts.',
      '> These numbers show the pipeline works; they are not a measurement of Zephyr.',
      '',
    );
  out.push(`Medians with the interquartile range in brackets. A saving is shown only when the arm's pass rate is within noise of vanilla (≥${r.minRunsPerCell} runs per task per arm).`, '');
  out.push('| Arm | Differs from vanilla | Runs | Pass | Total tokens | Input | Cost | Wall | Approvals | Blocks | Verdict |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.arms) {
    const verdict =
      a.comparability === 'baseline'
        ? 'baseline'
        : a.comparability === 'comparable' && a.savings
          ? `${delta(a.savings.totalTokens)} tokens, ${delta(a.savings.costUsd)} cost`
          : a.comparability === 'not_comparable'
            ? `not comparable (pass ${pct(a.passRate)} vs noise ±${pct(a.noise)})`
            : 'insufficient runs';
    out.push(
      `| ${a.label} | ${a.diffFromVanilla.join(', ') || '—'} | ${a.runs}${a.networkExcluded ? ` (+${a.networkExcluded} net)` : ''} | ${pct(a.passRate)} | ${spread(a.metrics.totalTokens)} | ${spread(a.metrics.inputTokens)} | ${spread(a.metrics.costUsd, usd)} | ${spread(a.metrics.wallMs, secs)} | ${spread(a.metrics.approvals)} | ${spread(a.metrics.stuckBlocks)} | ${verdict} |`,
    );
  }
  if (r.levers.length) {
    out.push('', '## Leave-one-out', '', '| Lever removed | Pass with | Pass without | Noise | Verdict |', '|---|---|---|---|---|');
    for (const l of r.levers)
      out.push(`| ${l.lever} | ${pct(l.passWith)} | ${pct(l.passWithout)} | ±${pct(l.noise)} | ${l.verdict.replace(/_/g, ' ')} |`);
  }
  return out.join('\n') + '\n';
}
