/**
 * /compare with no run ids: the coding benchmark, "harness alone" against "harness under
 * Zephyr", plus the leave-one-out arms that check each lever (docs/cacp-09).
 *
 * Every number comes from GET /api/benchmarks/coding (the journal summarised by
 * services/benchmarkCoding.service.ts); nothing is recomputed here. Savings are shown only
 * where the report marks an arm comparable, and mock numbers always carry their note.
 */

import { useEffect, useState } from 'react';
import type { CodingArmReport, CodingBenchmarkReport } from '@htn/shared';
import { api } from '../../lib/api';
import {
  comparabilityNote,
  headline,
  modeNote,
  pct,
  savingsLabel,
  spreadLabel,
  verdictNote,
} from '../../lib/codingCompare';
import { Badge, type Tone } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

const COMPARABILITY_TONE: Record<CodingArmReport['comparability'], Tone> = {
  baseline: 'muted',
  comparable: 'ok',
  not_comparable: 'bad',
  insufficient: 'warn',
};

function ArmColumn({ arm, title }: { arm: CodingArmReport | undefined; title: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      {!arm ? (
        <p className="text-xs text-slate-500">No runs yet.</p>
      ) : (
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Passed</dt>
          <dd>
            {arm.passed}/{arm.runs} ({pct(arm.passRate)})
          </dd>
          <dt className="text-slate-500">Tokens</dt>
          <dd>{spreadLabel(arm.metrics.totalTokens, 'tokens')}</dd>
          <dt className="text-slate-500">Input tokens</dt>
          <dd>{spreadLabel(arm.metrics.inputTokens, 'tokens')}</dd>
          <dt className="text-slate-500">Cost</dt>
          <dd>{spreadLabel(arm.metrics.costUsd, 'usd')}</dd>
          <dt className="text-slate-500">Wall time</dt>
          <dd>{spreadLabel(arm.metrics.wallMs, 'ms')}</dd>
          <dt className="text-slate-500">Approvals</dt>
          <dd>{spreadLabel(arm.metrics.approvals, 'count')}</dd>
        </dl>
      )}
    </div>
  );
}

export function CodingCompare() {
  const [report, setReport] = useState<CodingBenchmarkReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api
      .codingBenchmark()
      .then((next) => active && setReport(next))
      .catch((issue) => active && setError(issue instanceof Error ? issue.message : 'Could not load the report.'));
    return () => {
      active = false;
    };
  }, []);

  if (error) return <p className="text-sm text-rose-400">{error}</p>;
  if (!report) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner />
        Loading the coding benchmark…
      </div>
    );
  }

  const head = headline(report);
  const note = modeNote(report.mode);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-100">Harness alone vs harness under Zephyr</h1>
        <span className="text-xs text-slate-500">
          {report.tasks.length} task{report.tasks.length === 1 ? '' : 's'} · at least {report.minRunsPerCell} runs
          per task and arm · {report.mode}
        </span>
      </div>
      {note && (
        <p className="text-xs text-amber-300" role="note">
          {note}
        </p>
      )}

      <Card title={head.claim ?? 'No result to state yet'}>
        <p className="mb-4 text-xs text-slate-400">{head.reason}</p>
        <div className="grid gap-6 md:grid-cols-2">
          <ArmColumn arm={head.vanilla} title="Harness alone" />
          <ArmColumn arm={head.supervised} title="Harness under Zephyr" />
        </div>
      </Card>

      {report.arms.length > 0 && (
        <Card title="Every arm">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-normal">Arm</th>
                <th className="py-1 pr-3 font-normal">Passed</th>
                <th className="py-1 pr-3 font-normal">Tokens (median, IQR)</th>
                <th className="py-1 pr-3 font-normal">Cost</th>
                <th className="py-1 pr-3 font-normal">Against the harness alone</th>
              </tr>
            </thead>
            <tbody>
              {report.arms.map((arm) => (
                <tr key={arm.arm} className="border-t border-slate-800 align-top">
                  <td className="py-2 pr-3">
                    <div className="text-slate-200">{arm.label}</div>
                    <div className="text-xs text-slate-500">{arm.purpose}</div>
                    {arm.diffFromVanilla.length > 0 && (
                      <div className="text-xs text-slate-500">{arm.diffFromVanilla.join(', ')}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {arm.passed}/{arm.runs}
                    {arm.networkExcluded > 0 && (
                      <div className="text-xs text-slate-500">{arm.networkExcluded} excluded (network)</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{spreadLabel(arm.metrics.totalTokens, 'tokens')}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{spreadLabel(arm.metrics.costUsd, 'usd')}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={COMPARABILITY_TONE[arm.comparability]} title={comparabilityNote(arm)}>
                      {arm.comparability.replace('_', ' ')}
                    </Badge>
                    <div className="mt-1 text-xs text-slate-400">
                      {savingsLabel(arm) ?? (arm.comparability === 'baseline' ? '' : comparabilityNote(arm))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {report.levers.length > 0 && (
        <Card title="Does each lever earn its place?">
          <ul className="space-y-2 text-sm">
            {report.levers.map((v) => (
              <li key={v.arm} className="flex items-baseline gap-3">
                <Badge tone={v.verdict === 'harmful' ? 'bad' : v.verdict === 'insufficient' ? 'warn' : 'ok'}>
                  {v.lever}
                </Badge>
                <span className="text-slate-300">{verdictNote(v)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs text-slate-500">
        Compare two specific runs instead with <code>/compare?a=&lt;run&gt;&amp;b=&lt;run&gt;</code>.
      </p>
    </div>
  );
}
