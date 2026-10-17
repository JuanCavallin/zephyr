/**
 * Repeat-run benchmark: graph vs baselines on the SAME task, N times, reported
 * with the same math as the Benchmarks page (@htn/shared buildBenchmarkReport).
 *
 * One run per arm is an anecdote — LLM output varies run to run — so this
 * launches every arm `--repeats` times on the same input, pairs the runs by a
 * shared pairId, and reports success rate, cost per success and paired savings
 * (counted only where BOTH sides succeeded, per the design spec).
 *
 * Needs a running API:
 *   pnpm dev:api
 *   pnpm --filter @htn/api benchmark -- --graph graph_demo --repeats 5
 *
 * Flags:
 *   --graph <id>[,<id>...]   graphs to benchmark (default graph_demo)
 *   --repeats <n>            rounds per graph (default 3)
 *   --arms <list>            graph,baseline,baseline_agent (default graph,baseline)
 *   --variables <json>       the run's {{input.*}} (default {"target":"ACME-2026-TERM-FEES"})
 *   --timeout-min <n>        give up on one run after this long (default 15)
 *   --approve                auto-approve a pending approval ONLY when the server reports
 *                            MOCK_ALL with every provider mocked AND the pending action's own
 *                            proposed evidence is mock. Anything else may guard a real,
 *                            possibly irreversible action, so it waits for a person in the UI
 *                            (that wait is excluded from active time). Never use for live runs.
 *   --out <file>             also write the raw samples and report as JSON
 *
 * Every live run costs real money; B1 (baseline_agent) is a full agent run.
 */

import { writeFileSync } from 'node:fs';
import {
  BENCHMARK_ARM_LABELS,
  benchmarkSample,
  buildBenchmarkReport,
  canAutoApproveMockBenchmark,
  isBenchmarkArm,
  isTerminal,
  type ActionEvidence,
  type Approval,
  type ArmStats,
  type BenchmarkArm,
  type BenchmarkSample,
  type PairedSaving,
  type ProviderStatus,
  type RollupInput,
  type Run,
} from '@htn/shared';

const BASE = process.env.BENCHMARK_BASE ?? 'http://localhost:8787';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes('--' + name);

const graphIds = (flag('graph') ?? 'graph_demo').split(',').filter(Boolean);
const repeats = Math.max(1, Number(flag('repeats') ?? 3));
const arms = (flag('arms') ?? 'graph,baseline').split(',').filter(Boolean);
const variables = JSON.parse(flag('variables') ?? '{"target":"ACME-2026-TERM-FEES"}') as Record<
  string,
  unknown
>;
const timeoutMs = Number(flag('timeout-min') ?? 15) * 60_000;
const autoApprove = has('approve');
const outFile = flag('out');

for (const arm of arms) {
  if (!isBenchmarkArm(arm)) throw new Error('Unknown arm "' + arm + '"');
}
if (!arms.includes('graph')) throw new Error('--arms must include graph: it is what is measured.');

let cookie = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      Origin: new URL(BASE).origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status + ': ' + JSON.stringify(body));
  return body;
}

type Detail = RollupInput & { run: Run };

function launch(arm: BenchmarkArm, graphId: string, pairId: string): Promise<{ run: Run }> {
  const input =
    arm === 'graph'
      ? { graphId, variables, pairId }
      : { graphId, variables, pairId, target: String(variables.target ?? 'benchmark') };
  return api<{ run: Run }>('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ kind: arm, input }),
  });
}

async function provablyMockApproval(approval: Approval): Promise<boolean> {
  const action = approval.proposedAction;
  const actionId =
    action && typeof action === 'object' && !Array.isArray(action) ? action.actionId : undefined;
  if (typeof actionId !== 'string') return false;
  const [status, egress, evidence] = await Promise.all([
    api<{ mockAll: boolean; providers: ProviderStatus[] }>('/api/providers'),
    api<Detail>('/api/runs/' + approval.runId).then((detail) => detail.egress),
    api<{ evidence: ActionEvidence[] }>(
      '/api/runs/' + approval.runId + '/actions/' + actionId + '/evidence',
    ).then((body) => body.evidence),
  ]);
  return canAutoApproveMockBenchmark({
    mockAll: status.mockAll === true,
    providers: status.providers,
    approval,
    evidence,
    egress,
  });
}

async function settle(runId: string): Promise<Detail> {
  const deadline = Date.now() + timeoutMs;
  const warned = new Set<string>();
  while (Date.now() < deadline) {
    const detail = await api<Detail>('/api/runs/' + runId);
    if (isTerminal(detail.run.status)) return detail;
    for (const approval of detail.approvals ?? []) {
      if (approval.status !== 'pending') continue;
      // No live egress YET is not proof of a mock: a run's first real write is
      // pending with an empty ledger. Approve only when the server says every
      // provider is mocked and the pending action's own evidence is mock.
      const provablyMock = autoApprove && (await provablyMockApproval(approval));
      if (provablyMock) {
        await api('/api/approvals/' + approval.id + '/decide', {
          method: 'POST',
          body: JSON.stringify({ decision: 'approved', note: 'benchmark --approve (mock run)' }),
        });
      } else if (!warned.has(approval.id)) {
        warned.add(approval.id);
        console.log(
          '    run ' +
            runId +
            ' is waiting on an approval; decide it in the UI' +
            (autoApprove ? ' (not provably mocked, so not auto-approved)' : '') +
            '. Wait time is excluded from active time.',
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  console.log('    run ' + runId + ' timed out; cancelling it (it counts as a failure).');
  await api('/api/runs/' + runId + '/cancel', { method: 'POST' }).catch(() => undefined);
  return api<Detail>('/api/runs/' + runId);
}

const pct = (value: number) => Math.round(value * 100) + '%';
const cents = (value: number | null, lowerBound: boolean) =>
  value === null ? 'n/a' : (lowerBound ? '>=' : '') + value.toFixed(4) + 'c';

function printArms(stats: Partial<Record<BenchmarkArm, ArmStats>>): void {
  console.table(
    Object.values(stats).map((row) => ({
      arm: BENCHMARK_ARM_LABELS[row!.arm],
      runs: row!.runs,
      success: pct(row!.successRate),
      'cost/success': cents(row!.costPerSuccessCents, row!.unpricedCalls > 0),
      'median cost': cents(row!.medianCostCents, row!.unpricedCalls > 0),
      'median tokens': Math.round(row!.medianTokens),
      'active p50 ms': Math.round(row!.medianWallMs),
      'active p95 ms': Math.round(row!.p95WallMs),
      unpriced: row!.unpricedCalls,
    })),
  );
}

function printSavings(savings: PairedSaving[]): void {
  for (const entry of savings) {
    const ci = entry.costSavingCi
      ? ' (95% CI ' + pct(entry.costSavingCi[0]) + '..' + pct(entry.costSavingCi[1]) + ')'
      : '';
    console.log(
      '  vs ' +
        BENCHMARK_ARM_LABELS[entry.versus] +
        ': ' +
        entry.bothSucceeded +
        '/' +
        entry.pairs +
        ' pairs both succeeded; median cost saving ' +
        (entry.medianCostSaving === null ? 'n/a' : pct(entry.medianCostSaving)) +
        ci +
        ', tokens ' +
        (entry.medianTokenSaving === null ? 'n/a' : pct(entry.medianTokenSaving)) +
        ', active time ' +
        (entry.medianWallSaving === null ? 'n/a' : pct(entry.medianWallSaving)) +
        '. Graph-only wins ' +
        entry.graphOnlyWins +
        ', baseline-only wins ' +
        entry.baselineOnlyWins +
        '.',
    );
  }
}

async function main(): Promise<void> {
  const setup = await fetch(BASE + '/api/credentials/session', {
    method: 'POST',
    headers: { Origin: new URL(BASE).origin },
  });
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!setup.ok || !cookie) throw new Error('Could not establish a local control session.');

  console.log(
    'Benchmark against ' +
      BASE +
      ': ' +
      graphIds.join(', ') +
      ' x ' +
      repeats +
      ' round(s), arms ' +
      arms.join(', ') +
      '\n',
  );
  const samples: BenchmarkSample[] = [];
  const graphNames: Record<string, string> = {};

  for (const graphId of graphIds) {
    for (let round = 1; round <= repeats; round += 1) {
      const pairId = 'bench_' + Date.now().toString(36) + '_' + round;
      // Arms in one round run concurrently, like the UI's compare button;
      // rounds run one after another so rate limits don't skew later rounds.
      const runs = await Promise.all(
        arms.map((arm) => launch(arm as BenchmarkArm, graphId, pairId)),
      );
      console.log('  ' + graphId + ' round ' + round + ': ' + runs.map((r) => r.run.id).join(', '));
      const details = await Promise.all(runs.map((r) => settle(r.run.id)));
      for (const detail of details) {
        const sample = benchmarkSample(detail);
        if (sample) samples.push(sample);
        const snapshot = (detail.run.input as { graphSnapshot?: { name?: string } }).graphSnapshot;
        if (snapshot?.name) graphNames[graphId] = snapshot.name;
        console.log(
          '    ' +
            detail.run.kind.padEnd(15) +
            detail.run.status.padEnd(12) +
            (sample
              ? (sample.success ? 'PASS ' : 'FAIL ') +
                sample.assertionsPassed +
                '/' +
                sample.assertionsTotal +
                ' assertions' +
                (sample.mocked ? ' (mock)' : '') +
                ', ' +
                (sample.jevCalls ?? 0) +
                ' Jev call(s)' +
                (sample.warm ? ', warm' : '')
              : ''),
        );
      }
    }
  }

  const report = buildBenchmarkReport(samples, graphNames, { includeMocked: true });
  if (samples.some((sample) => sample.warm)) {
    console.log(
      '\nNOTE: warm graph runs reused frozen decisions or remembered targets; baselines never do. ' +
        'Compare cold runs with GET /api/benchmarks?warmth=cold.',
    );
  }
  if (samples.some((sample) => sample.mocked)) {
    console.log('\nNOTE: some runs used mocked providers; their tokens and costs are not real.');
  }
  for (const graph of report.graphs) {
    console.log(
      '\n' + graph.graphName + (graph.hasAssertions ? '' : '  [no assertions: success = finished]'),
    );
    printArms(graph.arms);
    printSavings(graph.savings);
  }
  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ samples, report }, null, 2));
    console.log('\nWrote ' + outFile);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
