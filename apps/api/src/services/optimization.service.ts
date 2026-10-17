/**
 * Self-improving graph generation.
 *
 * Feeds a graph's own run history back into the EXISTING chat-based
 * synthesiser (synthesiseGraph) as a critique, and lands whatever it proposes
 * as a NEW forked graph for a human to review. Two invariants matter more than
 * anything else here:
 *
 *   1. The source graph is NEVER mutated. optimizeGraph only reads it.
 *   2. The candidate can never gain a success criterion the human did not
 *      author -- any assertion synthesis adds that the source graph did not
 *      already have is stripped before saving, and reported back instead.
 */

import {
  agentGraphSchema,
  buildGraphCritique,
  isTerminal,
  promotionCandidates,
  type PromotionCandidate,
  type ToolLifecycleEvent,
  type AgentGraph,
  type Approval,
  type EgressEvent,
  type GraphAssertion,
  type GraphCritique,
  type Run,
  type ScheduleDecision,
  type Step,
} from '@htn/shared';
import { newId, nowIso } from '../lib/ids.js';
import { store } from '../store/index.js';
import { listRuns } from './runs.service.js';
import { synthesiseGraph } from './synthesis.service.js';
import { GraphNotFoundError, GraphValidationError } from './graphs.service.js';
import { saveGraphOwned } from './graphCompile.service.js';

/** How far back to look for run history to critique. */
const RECENT_RUNS_LIMIT = 10;
/** Cast a wide net before filtering to this graph, since the store has no graphId index. */
const RUN_SCAN_LIMIT = 200;

export interface OptimizeGraphResult {
  graph: AgentGraph;
  critique: GraphCritique;
  /** Assertions the synthesiser proposed that were NOT in the source graph, dropped for safety. */
  suggestedAssertions: GraphAssertion[];
}

/** Terminal runs of `kind`, for this graph, newest first, most-recent-first-ish limit applied. */
async function terminalRunsForGraph(kind: string, graphId: string): Promise<Run[]> {
  const candidates = await listRuns({ kind, graphId, limit: RUN_SCAN_LIMIT });
  return candidates.filter((run) => isTerminal(run.status)).slice(0, RECENT_RUNS_LIMIT);
}

interface PerRunData {
  steps: Map<string, Step[]>;
  egress: Map<string, EgressEvent[]>;
  scheduleDecisions: Map<string, ScheduleDecision[]>;
  approvals: Map<string, Approval[]>;
  toolLifecycle: Map<string, ToolLifecycleEvent[]>;
}

/** Fetch what rollup() needs for each run, in parallel. */
async function loadPerRunData(runs: Run[]): Promise<PerRunData> {
  const steps = new Map<string, Step[]>();
  const egress = new Map<string, EgressEvent[]>();
  const scheduleDecisions = new Map<string, ScheduleDecision[]>();
  const approvals = new Map<string, Approval[]>();
  const toolLifecycle = new Map<string, ToolLifecycleEvent[]>();

  await Promise.all(
    runs.map(async (run) => {
      const [s, e, d, a, events] = await Promise.all([
        store.listSteps(run.id),
        store.listEgress(run.id),
        store.listScheduleDecisions(run.id),
        store.listApprovals(run.id),
        store.eventsSince(run.id, 0),
      ]);
      steps.set(run.id, s);
      egress.set(run.id, e);
      scheduleDecisions.set(run.id, d);
      approvals.set(run.id, a);
      toolLifecycle.set(
        run.id,
        events.flatMap(({ event }) => (event.type === 'tool.lifecycle' ? [event.lifecycle] : [])),
      );
    }),
  );

  return { steps, egress, scheduleDecisions, approvals, toolLifecycle };
}

/** Render a GraphCritique as the compact "OPTIMIZE: " request the synthesiser reads. */
export function renderOptimizeRequest(
  critique: GraphCritique,
  promotions: PromotionCandidate[] = [],
): string {
  const lines: string[] = [];

  lines.push(
    critique.runsAnalyzed === 0
      ? 'This graph has never been run -- there is no run history to learn from.'
      : 'Analysed ' + critique.runsAnalyzed + ' recent terminal run(s) of this graph.',
  );

  if (critique.lowConfidence) {
    lines.push(
      'LOW CONFIDENCE: fewer than 3 runs analysed. Treat every finding below as a hunch, ' +
        'not a trend, and prefer small, reversible changes over a rewrite.',
    );
  }

  for (const a of critique.assertionFailures) {
    lines.push(
      'Assertion "' + a.description + '" (' + a.id + ') failed ' +
        (a.total - a.passed) + ' of ' + a.total + ' run(s).',
    );
  }
  for (const o of critique.costOutliers) {
    lines.push(
      'Node "' + (o.label ?? o.nodeId) + '" cost ' + o.value + ' cent(s) in run ' + o.runId +
        ', vs a median of ' + o.median + ' -- look for a cheaper tier or a smaller budget there.',
    );
  }
  for (const o of critique.latencyOutliers) {
    lines.push(
      'Node "' + (o.label ?? o.nodeId) + '" took ' + o.value + 'ms in run ' + o.runId +
        ', vs a median of ' + o.median + 'ms -- consider trimming its scope.',
    );
  }
  for (const o of critique.toolDivergenceOutliers) {
    lines.push(
      'Node "' + (o.label ?? o.nodeId) + '" called tool(s) it was not exposed in run ' +
        o.runId + ': ' + o.tools.join(', ') + '.',
    );
  }
  for (const f of critique.failureEvidence) {
    lines.push(
      'Run ' + f.runId + ' failed a subtask after ' + (f.toolCallCount ?? 'some') +
        ' tool call(s) -- it made partial progress before running out of budget.',
    );
  }
  for (const p of promotions) {
    lines.push(
      'Agent node "' + p.nodeId + '" finished verified in its last ' + p.runs +
        ' run(s) by calling the same tool(s) in the same order: ' + p.tools.join(' -> ') + '. ' +
        (p.suggestion === 'dispatch'
          ? 'Consider a dispatch or tool node instead of an agent loop.'
          : 'Consider replacing the agent loop with fixed tool nodes in that order.') +
        (p.arguments
          ? ' The arguments were identical every run: ' + JSON.stringify(p.arguments).slice(0, 600) + '.'
          : p.stableArguments
            ? ''
            : ' Arguments varied between runs; wire them from upstream node outputs, not literals.') +
        ' Keep every approval, submit and handoff gate.',
    );
  }
  if (critique.baselineComparison) {
    const b = critique.baselineComparison;
    lines.push(
      'Baseline comparison (' + b.baselineRunsAnalyzed + ' baseline run(s)): tokens ' +
        b.medianTokens.graph + ' vs ' + b.medianTokens.baseline + ', cost ' +
        b.medianCostCents.graph + 'c vs ' + b.medianCostCents.baseline + 'c, latency ' +
        b.medianLatencyMs.graph + 'ms vs ' + b.medianLatencyMs.baseline + 'ms.',
    );
  }

  const nothingFound =
    critique.assertionFailures.length === 0 &&
    critique.costOutliers.length === 0 &&
    critique.latencyOutliers.length === 0 &&
    critique.toolDivergenceOutliers.length === 0 &&
    critique.failureEvidence.length === 0 &&
    promotions.length === 0;

  lines.push(
    nothingFound
      ? 'Nothing obviously wrong in the run history. Propose a conservative cost or latency ' +
          'tune only (e.g. a cheaper model tier or a smaller token/time budget on one node) ' +
          'without changing what the graph does or removing any safeguard.'
      : 'Propose a graph that addresses the above without adding new success criteria, ' +
          'changing what the graph promises to do, or removing any approval/submit/handoff gate.',
  );

  return lines.join('\n');
}

/** Structural equality for assertions -- same rule, not just same id. */
function sameAssertion(a: GraphAssertion, b: GraphAssertion): boolean {
  return (
    a.id === b.id &&
    a.path === b.path &&
    a.expected === b.expected &&
    a.description === b.description
  );
}

/**
 * The candidate must never gain a success criterion the source graph did not
 * already have. Drop any assertion not structurally present in `source`, and
 * report the dropped ones so a human can decide whether to add them for real.
 */
export function stripAddedAssertions(
  candidate: AgentGraph,
  source: AgentGraph,
): { graph: AgentGraph; suggestedAssertions: GraphAssertion[] } {
  const sourceAssertions = source.assertions ?? [];
  const candidateAssertions = candidate.assertions ?? [];

  const kept = candidateAssertions.filter((a) => sourceAssertions.some((s) => sameAssertion(a, s)));
  const dropped = candidateAssertions.filter((a) => !sourceAssertions.some((s) => sameAssertion(a, s)));

  return {
    graph: { ...candidate, assertions: kept.length > 0 ? kept : undefined },
    suggestedAssertions: dropped,
  };
}

/**
 * Load a graph's run history, critique it, ask the existing synthesiser for an
 * improvement, and save the result as a NEW forked graph. Never touches the
 * source graph.
 */
export async function optimizeGraph(graphId: string): Promise<OptimizeGraphResult> {
  const source = await store.getGraph(graphId);
  if (!source) throw new GraphNotFoundError(graphId);

  const graphRuns = await terminalRunsForGraph('graph', graphId);
  const baselineRuns = await terminalRunsForGraph('baseline', graphId);

  const [runData, baselineData] = await Promise.all([
    loadPerRunData(graphRuns),
    loadPerRunData(baselineRuns),
  ]);

  const critique = buildGraphCritique({
    graph: source,
    runs: graphRuns,
    stepsByRun: runData.steps,
    egressByRun: runData.egress,
    scheduleDecisionsByRun: runData.scheduleDecisions,
    approvalsByRun: runData.approvals,
    baselineRuns: baselineRuns.length > 0 ? baselineRuns : undefined,
    baselineStepsByRun: baselineData.steps,
    baselineEgressByRun: baselineData.egress,
  });

  const promotions = promotionCandidates({
    graph: source,
    runs: graphRuns.map((run) => ({
      run,
      steps: runData.steps.get(run.id) ?? [],
      egress: runData.egress.get(run.id) ?? [],
      scheduleDecisions: runData.scheduleDecisions.get(run.id) ?? [],
      toolLifecycle: runData.toolLifecycle.get(run.id) ?? [],
    })),
  });
  const request = 'OPTIMIZE: ' + renderOptimizeRequest(critique, promotions);

  const synthesis = await synthesiseGraph({
    conversationId: newId('conv'),
    request,
    currentGraph: source,
  });

  const { graph: safeCandidate, suggestedAssertions } = stripAddedAssertions(
    synthesis.graph,
    source,
  );

  const at = nowIso();
  const forked = {
    ...safeCandidate,
    id: newId('graph'),
    name: 'Optimized: ' + source.name,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };

  const parsed = agentGraphSchema.safeParse(forked);
  if (!parsed.success) {
    throw new GraphValidationError('Optimized graph failed validation', {
      issues: parsed.error.issues,
    });
  }

  const saved = await saveGraphOwned(parsed.data);

  return { graph: saved, critique, suggestedAssertions };
}
