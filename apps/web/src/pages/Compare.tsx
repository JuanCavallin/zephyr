/**
 * Compare two or three runs side by side.
 *
 * Deliberately generic over WHICH runs -- a graph run against its baselines
 * (the core "structured graph beats one LLM call / one agent" argument), or a
 * graph run against the previous run of the SAME graph (did an edit actually
 * help?). Both are the same metrics table; only which run ids land in the URL
 * differs. See GraphEditor.tsx for the entry points that build this URL:
 * "compare to baseline", "compare to both baselines" and "compare to previous".
 *
 * All numbers come from GET /runs/:id/analytics (rollup(), already built) --
 * nothing here is computed a second way. Assertions use the shared helpers in
 * @htn/shared: a graph run is checked against its own graph.assertions, and a
 * baseline run (no per-node steps) against the assertions it snapshotted at
 * creation, read off its flat `result` by field name.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  assertionsForRun,
  outcomeAssertionsForRun,
  experimentForRun,
  evaluateAssertions,
  evaluateAssertionsAgainstResult,
  isBenchmarkArm,
  BENCHMARK_ARM_LABELS,
  type AgentGraph,
  type AssertionResult,
  type Run,
  type RunAnalytics,
  isTerminal,
} from '@htn/shared';
import { api, type RunDetail } from '../lib/api';
import { humanStatus, msLabel, relativeTime, RUN_STATUS_TONE } from '../lib/format';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

interface Side {
  run: Run;
  detail: RunDetail;
  analytics: RunAnalytics;
  graph: AgentGraph | null;
  assertions: AssertionResult[];
  pipelineAssertions: AssertionResult[];
}

function graphOf(run: Run): AgentGraph | null {
  return (run.input as { graphSnapshot?: AgentGraph }).graphSnapshot ?? null;
}

async function loadSide(id: string): Promise<Side> {
  const [detail, analytics] = await Promise.all([api.getRun(id), api.analytics(id)]);
  const graph = graphOf(detail.run);
  return { run: detail.run, detail, analytics, graph, assertions: [], pipelineAssertions: [] };
}

/**
 * A graph run is checked against its own snapshot. A baseline is checked
 * against the assertions it snapshotted at creation; an older baseline run
 * without that copy borrows the graph side's assertions.
 */
function withAssertions(side: Side, sides: Side[]): Side {
  void sides;
  const outcomes = outcomeAssertionsForRun(side.run);
  const pipeline = assertionsForRun(side.run).filter(
    (item) => !outcomes.some((outcome) => outcome.id === item.id),
  );
  return {
    ...side,
    assertions:
      side.run.kind === 'graph'
        ? evaluateAssertions(outcomes, side.detail.steps)
        : evaluateAssertionsAgainstResult(outcomes, side.run.result),
    pipelineAssertions:
      side.run.kind === 'graph' ? evaluateAssertions(pipeline, side.detail.steps) : [],
  };
}

export function Compare() {
  const [params] = useSearchParams();
  const ids = ['a', 'b', 'c']
    .map((key) => params.get(key))
    .filter((id): id is string => Boolean(id));
  const idsKey = ids.join(',');

  const [sides, setSides] = useState<Side[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length < 2) return;
    setSides(null);
    setError(null);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const loaded = await Promise.all(ids.map(loadSide));
        if (!active) return;
        setSides(loaded.map((side) => withAssertions(side, loaded)));
        if (loaded.some((side) => !isTerminal(side.run.status))) {
          timer = setTimeout(() => void refresh(), 1500);
        }
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // idsKey captures every id; `ids` itself is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (ids.length < 2) {
    return (
      <p className="text-sm text-rose-400">Compare needs at least two run ids: ?a=...&b=...</p>
    );
  }
  if (error) return <p className="text-sm text-rose-400">{error}</p>;
  if (!sides) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner />
        Loading runs…
      </div>
    );
  }

  const graphs = sides.map((side) => side.graph).filter((graph): graph is AgentGraph => !!graph);
  const sameGraph = graphs.length > 1 && graphs.every((graph) => graph.id === graphs[0]!.id);
  const updating = sides.some((side) => !isTerminal(side.run.status));
  const experiment = experimentForRun(sides[0]!.run)?.fingerprint;
  const matchedExperiment =
    !!experiment && sides.every((side) => experimentForRun(side.run)?.fingerprint === experiment);
  const columns = { gridTemplateColumns: '10rem repeat(' + sides.length + ', minmax(0, 1fr))' };
  const row = (label: string, render: (side: Side) => string) => (
    <Row label={label} values={sides.map(render)} />
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-100">Compare runs</h1>
        <Link to="/benchmarks" className="text-xs text-sky-300 hover:underline">
          All runs: Benchmarks →
        </Link>
      </div>
      {updating && (
        <p className="text-xs text-sky-300" role="status">
          Measurements refresh while any run is active; values may be partial.
        </p>
      )}
      <p className={'text-xs ' + (matchedExperiment ? 'text-slate-400' : 'text-amber-300')}>
        {matchedExperiment
          ? 'Matching experiment ' +
            experiment!.slice(0, 12) +
            ': shared task, inputs, outcome checks and configuration.'
          : 'These runs do not share a current experiment snapshot. Measurements are shown for inspection; they are not a matched benchmark.'}
      </p>

      <div className="grid gap-x-4 gap-y-1 text-sm" style={columns}>
        <div />
        {sides.map((side) => (
          <SideHeader key={side.run.id} side={side} />
        ))}

        {row('Version', (side) => versionLabel(side, sides, sameGraph))}
        {row('Active time', (side) => measured(side, side.analytics.totals.wallMs, msLabel))}
        {row('Human wait', humanWaitLabel)}
        {row('Tokens (in/out)', (side) =>
          measured(
            side,
            side.analytics.totals.tokensIn + side.analytics.totals.tokensOut,
            () => side.analytics.totals.tokensIn + ' / ' + side.analytics.totals.tokensOut,
          ),
        )}
        {row('Cost', costLabel)}
        {row('Model calls', (side) => measured(side, side.analytics.totals.llmCalls, String))}
        {row('Tool reduction', toolReductionLabel)}
        {row('Approvals', approvalsLabel)}
        {row('PII spans pinned', (side) => measured(side, side.detail.piiSpans.length, String))}
      </div>

      {sides.some((side) => side.assertions.length > 0) && (
        <Card title="Shared outcome checks">
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: columns.gridTemplateColumns.replace('10rem ', '') }}
          >
            {sides.map((side) => (
              <AssertionList key={side.run.id} assertions={side.assertions} />
            ))}
          </div>
        </Card>
      )}
      {sides.some((side) => side.pipelineAssertions.length > 0) && (
        <Card title="Graph pipeline checks (not graded against baselines)">
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: columns.gridTemplateColumns.replace('10rem ', '') }}
          >
            {sides.map((side) => (
              <AssertionList key={side.run.id} assertions={side.pipelineAssertions} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function SideHeader({ side }: { side: Side }) {
  const mocked = side.analytics.totals.egress.mocked > 0;
  return (
    <div>
      <Link
        to={'/runs/' + side.run.id}
        className="text-sm font-medium text-slate-200 hover:underline"
      >
        {side.run.title}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge tone="muted">
          {isBenchmarkArm(side.run.kind) ? BENCHMARK_ARM_LABELS[side.run.kind] : side.run.kind}
        </Badge>
        <Badge tone={RUN_STATUS_TONE[side.run.status]}>{humanStatus(side.run.status)}</Badge>
        {mocked && (
          <span title="At least one call was mocked; its tokens and cost are not real.">
            <Badge tone="warn">mock data</Badge>
          </span>
        )}
        <span className="text-xs text-slate-600">{relativeTime(side.run.createdAt)}</span>
      </div>
    </div>
  );
}

function Row({ label, values }: { label: string; values: string[] }) {
  return (
    <>
      <div className="py-1.5 text-xs uppercase tracking-wide text-slate-500">{label}</div>
      {values.map((value, index) => (
        <div key={index} className="border-t border-slate-800 py-1.5 text-slate-200">
          {value}
        </div>
      ))}
    </>
  );
}

function versionLabel(side: Side, sides: Side[], sameGraph: boolean): string {
  if (!side.graph) return side.run.kind !== 'graph' ? 'n/a — no graph' : '—';
  const others = sides.filter((other) => other !== side && other.graph);
  if (others.length === 0) return 'v' + side.graph.version;
  if (sameGraph) {
    return others.every((other) => other.graph!.version === side.graph!.version)
      ? 'v' + side.graph.version + ' (same version)'
      : 'v' + side.graph.version;
  }
  return 'v' + side.graph.version + ' (different graph)';
}

function measured(side: Side, value: number, format: (value: number) => string): string {
  if (!isTerminal(side.run.status) && value === 0) return 'Waiting for measurements…';
  return format(value);
}

/**
 * Cost is a LOWER BOUND when any model call had no known price (e.g. a model
 * missing from the rate table). Say so instead of printing a confident total.
 */
function costLabel(side: Side): string {
  const { estimatedCostCents, unpricedCalls, cacheReadTokens } = side.analytics.totals;
  if (!isTerminal(side.run.status) && estimatedCostCents === 0 && unpricedCalls === 0) {
    return 'Waiting for measurements…';
  }
  const cost = (unpricedCalls > 0 ? '≥ ' : '') + estimatedCostCents.toFixed(4) + '¢';
  const notes = [
    unpricedCalls > 0 ? unpricedCalls + ' unpriced call' + (unpricedCalls === 1 ? '' : 's') : '',
    cacheReadTokens > 0 ? cacheReadTokens + ' cached tokens' : '',
  ].filter(Boolean);
  return notes.length > 0 ? cost + ' (' + notes.join(', ') + ')' : cost;
}

function humanWaitLabel(side: Side): string {
  const { humanWaitMs } = side.analytics.totals;
  if (humanWaitMs === 0) return side.run.kind === 'graph' ? '0' : '0 — no gates';
  return msLabel(humanWaitMs) + ' (excluded from active time)';
}

function toolReductionLabel(side: Side): string {
  const { toolsAvailable, toolsExposed } = side.analytics.totals;
  if (!isTerminal(side.run.status) && toolsAvailable === 0) return 'Waiting for routing…';
  if (toolsAvailable === 0) return 'n/a — no tools routed';
  return toolsExposed + ' of ' + toolsAvailable;
}

function approvalsLabel(side: Side): string {
  const { approvals, approvalsPending } = side.analytics.totals;
  if (!isTerminal(side.run.status) && approvals === 0) return 'Waiting…';
  if (approvals === 0) return side.run.kind === 'baseline' ? '0 — cannot gate' : '0';
  return approvals + (approvalsPending > 0 ? ' (' + approvalsPending + ' pending)' : '');
}

function AssertionList({ assertions }: { assertions: AssertionResult[] }) {
  if (assertions.length === 0) {
    return <p className="text-xs text-slate-600">No assertions evaluated for this side.</p>;
  }
  return (
    <ul className="space-y-1.5 text-xs">
      {assertions.map((assertion) => (
        <li key={assertion.id} className="flex items-start gap-1.5">
          <span className={assertion.passed ? 'text-emerald-400' : 'text-rose-400'}>
            {assertion.passed ? '✓' : '✗'}
          </span>
          <span className="text-slate-400">
            {assertion.description}
            <span className="block text-slate-600">
              expected {assertion.expected}, got {assertion.actual ?? '(nothing)'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
