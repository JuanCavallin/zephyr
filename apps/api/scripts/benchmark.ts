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
 *   pnpm --filter @htn/api benchmark -- --suite --arms graph,baseline,baseline_agent --report bench.md
 *
 * Flags:
 *   --graph <id>[,<id>...]   graphs to benchmark (default graph_demo)
 *   --suite [key,...]        create or update the scripts/benchmarkSuite.ts graphs (all, or the
 *                            listed keys) and benchmark those instead of --graph
 *   --repeats <n>            rounds per graph (default 3)
 *   --arms <list>            graph,baseline,baseline_agent (default graph,baseline)
 *   --variables <json>       the run's {{input.*}} (default {"target":"ACME-2026-TERM-FEES"});
 *                            suite tasks carry their own
 *   --warmup <n>             graph-only runs per graph before measuring, not counted (default 0,
 *                            1 with --suite). Measured graph runs are then HOT: they reuse what
 *                            earlier runs froze or remembered, while baselines always start cold.
 *   --sequential             run a round's arms one at a time, in a shuffled order, instead of
 *                            concurrently, so no arm's active time includes another's load
 *   --on-approval <mode>     wait (default): a person decides in the UI. cancel: cancel the run,
 *                            which counts as a failure; for unattended suites with no approvals
 *   --report <file.md>       also write the report as Markdown
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
  agentGraphSchema,
  BENCHMARK_ARM_LABELS,
  benchmarkSample,
  buildBenchmarkReport,
  canAutoApproveMockBenchmark,
  isBenchmarkArm,
  isTerminal,
  type ActionEvidence,
  type Approval,
  type AgentGraph,
  type ArmStats,
  type BenchmarkArm,
  type BenchmarkReport,
  type BenchmarkSample,
  type PairedSaving,
  type ProviderStatus,
  type RollupInput,
  type Run,
} from '@htn/shared';
import { BENCHMARK_SUITE } from './benchmarkSuite.js';

const BASE = process.env.BENCHMARK_BASE ?? 'http://localhost:8787';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes('--' + name);

const suite = has('suite');
const suiteValue = flag('suite');
const suiteKeys = suiteValue && !suiteValue.startsWith('--') ? suiteValue.split(',') : undefined;
const repeats = Math.max(1, Number(flag('repeats') ?? 3));
const arms = (flag('arms') ?? 'graph,baseline').split(',').filter(Boolean);
const defaultVariables = JSON.parse(
  flag('variables') ?? '{"target":"ACME-2026-TERM-FEES"}',
) as Record<string, unknown>;
const timeoutMs = Number(flag('timeout-min') ?? 15) * 60_000;
const autoApprove = has('approve');
const outFile = flag('out');
const reportFile = flag('report');
const warmup = Math.max(0, Number(flag('warmup') ?? (suite ? 1 : 0)));
const sequential = has('sequential');
const onApproval = flag('on-approval') ?? 'wait';
if (onApproval !== 'wait' && onApproval !== 'cancel')
  throw new Error('--on-approval must be wait or cancel');

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

/** Create or update each suite task's graph, found by name so reruns keep one graph each. */
async function upsertSuite(): Promise<{ graphId: string; variables: Record<string, unknown> }[]> {
  const tasks = BENCHMARK_SUITE.filter((task) => !suiteKeys || suiteKeys.includes(task.key));
  if (tasks.length === 0) throw new Error('No suite task matches ' + suiteKeys?.join(','));
  const { graphs } = await api<{ graphs: AgentGraph[] }>('/api/graphs');
  const targets = [];
  for (const task of tasks) {
    const body = {
      name: task.name,
      description: task.description,
      nodes: task.nodes,
      edges: task.edges,
      assertions: task.assertions,
    };
    const existing = graphs.find((graph) => graph.name === task.name);
    // Leave an unchanged task alone: a save bumps the version, which starts a
    // new experiment and drops what earlier runs froze for it.
    const { graph } = existing
      ? (await sameTask(existing, body))
        ? { graph: existing }
        : await api<{ graph: AgentGraph }>('/api/graphs/' + existing.id, {
            method: 'PUT',
            body: JSON.stringify(body),
          })
      : await api<{ graph: AgentGraph }>('/api/graphs', {
          method: 'POST',
          body: JSON.stringify(body),
        });
    console.log(
      '  ' +
        task.key.padEnd(14) +
        graph.id +
        (!existing ? ' (created)' : graph.version !== existing.version ? ' (updated)' : ''),
    );
    targets.push({ graphId: graph.id, variables: task.variables });
  }
  return targets;
}

/** Compare as the server stores it: parsed with defaults, not as written in the suite. */
async function sameTask(
  existing: AgentGraph,
  body: { description: string; nodes: unknown[]; edges: unknown[]; assertions: unknown[] },
): Promise<boolean> {
  const parsed = agentGraphSchema.safeParse({ ...existing, ...body });
  if (!parsed.success) return false;
  const key = (graph: AgentGraph) =>
    JSON.stringify([graph.description, graph.nodes, graph.edges, graph.assertions]);
  return key(parsed.data) === key(existing);
}

function launch(
  arm: BenchmarkArm,
  graphId: string,
  pairId: string,
  variables: Record<string, unknown>,
): Promise<{ run: Run }> {
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
      if (onApproval === 'cancel' && !(autoApprove && (await provablyMockApproval(approval)))) {
        console.log(
          '    run ' + runId + ' asked for approval; cancelling it (--on-approval cancel).',
        );
        await api('/api/runs/' + runId + '/cancel', { method: 'POST' }).catch(() => undefined);
        return waitTerminal(runId);
      }
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
  return waitTerminal(runId);
}

/** After a cancel, give the run a moment to record its final status. */
async function waitTerminal(runId: string): Promise<Detail> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const detail = await api<Detail>('/api/runs/' + runId);
    if (isTerminal(detail.run.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return api<Detail>('/api/runs/' + runId);
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
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
      'tokens in/out':
        Math.round(row!.medianTokensIn ?? 0) + '/' + Math.round(row!.medianTokensOut ?? 0),
      'model calls': row!.medianLlmCalls ?? '',
      'Jev calls': row!.medianJevCalls,
      warm: row!.warmRuns + '/' + row!.runs,
      'active p50 ms': Math.round(row!.medianWallMs),
      'active p95 ms': Math.round(row!.p95WallMs),
      unpriced: row!.unpricedCalls,
    })),
  );
}

const ciText = (ci: [number, number] | null | undefined) =>
  ci ? ' (95% CI ' + pct(ci[0]) + '..' + pct(ci[1]) + ')' : '';
const savingText = (value: number | null, ci?: [number, number] | null) =>
  value === null ? 'n/a' : pct(value) + ciText(ci);

function savingLine(entry: PairedSaving): string {
  return (
    'vs ' +
    BENCHMARK_ARM_LABELS[entry.versus] +
    ': ' +
    entry.bothSucceeded +
    '/' +
    entry.pairs +
    ' pairs both succeeded; median token saving ' +
    savingText(entry.medianTokenSaving, entry.tokenSavingCi) +
    ', active time ' +
    savingText(entry.medianWallSaving, entry.wallSavingCi) +
    ', cost ' +
    savingText(entry.medianCostSaving, entry.costSavingCi) +
    '. Graph-only wins ' +
    entry.graphOnlyWins +
    ', baseline-only wins ' +
    entry.baselineOnlyWins +
    '.'
  );
}

function printSavings(savings: PairedSaving[]): void {
  for (const entry of savings) console.log('  ' + savingLine(entry));
}

function markdownArms(stats: Partial<Record<BenchmarkArm, ArmStats>>): string {
  const rows = Object.values(stats).map((row) =>
    [
      BENCHMARK_ARM_LABELS[row!.arm],
      row!.runs,
      pct(row!.successRate),
      Math.round(row!.medianTokens).toLocaleString('en-US'),
      Math.round(row!.medianTokensIn ?? 0).toLocaleString('en-US') +
        ' / ' +
        Math.round(row!.medianTokensOut ?? 0).toLocaleString('en-US'),
      row!.medianLlmCalls ?? '',
      row!.medianJevCalls,
      (row!.medianWallMs / 1000).toFixed(1) + ' s',
      (row!.p95WallMs / 1000).toFixed(1) + ' s',
      cents(row!.costPerSuccessCents, row!.unpricedCalls > 0),
      row!.warmRuns + '/' + row!.runs,
    ].join(' | '),
  );
  return [
    '| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => '| ' + row + ' |'),
  ].join('\n');
}

function markdownReport(report: BenchmarkReport, samples: BenchmarkSample[]): string {
  const sections = [
    '# Benchmark: graph vs baselines',
    '',
    'Generated ' +
      new Date().toISOString() +
      ' against ' +
      BASE +
      '. Arms: ' +
      arms.join(', ') +
      '; ' +
      repeats +
      ' measured round(s) per task' +
      (warmup ? ' after ' + warmup + ' uncounted warm-up graph run(s)' : '') +
      (sequential ? '; arms run one at a time in shuffled order' : '; arms run concurrently') +
      '.',
    '',
    'Savings are medians of per-pair `1 - graph / baseline`, counted only where both runs passed ' +
      'every outcome assertion. Active time excludes time spent waiting on a person. Graph runs ' +
      'after the warm-up are hot (they reuse frozen decisions and remembered browser targets); ' +
      'baselines start cold every time.',
  ];
  if (samples.some((sample) => sample.mocked))
    sections.push('', '> Some runs used mocked providers; their tokens and costs are not real.');
  sections.push('', '## All tasks pooled', '', markdownArms(report.overall), '');
  for (const entry of report.overallSavings) sections.push('- ' + savingLine(entry));
  for (const graph of report.graphs) {
    sections.push('', '## ' + graph.graphName, '', markdownArms(graph.arms), '');
    for (const entry of graph.savings) sections.push('- ' + savingLine(entry));
    const failures = samples.filter(
      (sample) =>
        sample.graphId === graph.graphId &&
        sample.experimentFingerprint === graph.experimentFingerprint &&
        !sample.success,
    );
    if (failures.length)
      sections.push(
        '',
        'Failed runs: ' +
          failures
            .map(
              (sample) =>
                sample.arm +
                ' `' +
                sample.runId +
                '` (' +
                sample.status +
                ', ' +
                sample.assertionsPassed +
                '/' +
                sample.assertionsTotal +
                ' assertions' +
                (sample.completionVerified === false ? ', completion not verified' : '') +
                ')',
            )
            .join('; ') +
          '.',
      );
  }
  return sections.join('\n') + '\n';
}

function describe(detail: Detail, sample: BenchmarkSample | null): string {
  return (
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
        sample.tokens +
        ' tokens, ' +
        (sample.wallMs / 1000).toFixed(1) +
        ' s, ' +
        (sample.jevCalls ?? 0) +
        ' Jev call(s)' +
        (sample.warm ? ', warm' : '')
      : '')
  );
}

async function main(): Promise<void> {
  const setup = await fetch(BASE + '/api/credentials/session', {
    method: 'POST',
    headers: { Origin: new URL(BASE).origin },
  });
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!setup.ok || !cookie) throw new Error('Could not establish a local control session.');

  const targets = suite
    ? (console.log('Suite graphs:'), await upsertSuite())
    : (flag('graph') ?? 'graph_demo')
        .split(',')
        .filter(Boolean)
        .map((graphId) => ({ graphId, variables: defaultVariables }));
  console.log(
    '\nBenchmark against ' +
      BASE +
      ': ' +
      targets.map((target) => target.graphId).join(', ') +
      ' x ' +
      repeats +
      ' round(s), arms ' +
      arms.join(', ') +
      (warmup ? ', ' + warmup + ' warm-up run(s) each' : '') +
      (sequential ? ', sequential' : '') +
      '\n',
  );
  const samples: BenchmarkSample[] = [];
  const graphNames: Record<string, string> = {};

  for (const { graphId, variables } of targets) {
    for (let index = 1; index <= warmup; index += 1) {
      // Not paired and not counted: it only lets later runs reuse what it froze.
      const { run } = await launch(
        'graph',
        graphId,
        'warmup_' + Date.now().toString(36),
        variables,
      );
      console.log('  ' + graphId + ' warm-up ' + index + ': ' + run.id);
      const detail = await settle(run.id);
      console.log(describe(detail, benchmarkSample(detail)));
    }
    for (let round = 1; round <= repeats; round += 1) {
      const pairId = 'bench_' + Date.now().toString(36) + '_' + round;
      let details: Detail[];
      if (sequential) {
        // One at a time, in a fresh order each round, so no arm always runs
        // first (rate-limit headroom) or shares the machine with another.
        details = [];
        const order = shuffled(arms);
        console.log('  ' + graphId + ' round ' + round + ' (' + order.join(' -> ') + ')');
        for (const arm of order) {
          const { run } = await launch(arm as BenchmarkArm, graphId, pairId, variables);
          details.push(await settle(run.id));
        }
      } else {
        // Arms in one round run concurrently, like the UI's compare button;
        // rounds run one after another so rate limits don't skew later rounds.
        const runs = await Promise.all(
          arms.map((arm) => launch(arm as BenchmarkArm, graphId, pairId, variables)),
        );
        console.log(
          '  ' + graphId + ' round ' + round + ': ' + runs.map((r) => r.run.id).join(', '),
        );
        details = await Promise.all(runs.map((r) => settle(r.run.id)));
      }
      for (const detail of details) {
        const sample = benchmarkSample(detail);
        if (sample) samples.push(sample);
        const snapshot = (detail.run.input as { graphSnapshot?: { name?: string } }).graphSnapshot;
        if (snapshot?.name) graphNames[graphId] = snapshot.name;
        console.log(describe(detail, sample));
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
  if (report.graphs.length > 1) {
    console.log('\nAll tasks pooled');
    printArms(report.overall);
    printSavings(report.overallSavings);
  }
  if (reportFile) {
    writeFileSync(reportFile, markdownReport(report, samples));
    console.log('\nWrote ' + reportFile);
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
