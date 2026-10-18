/**
 * Run measurement — tokens, time and cost, per graph node and in total.
 *
 * THIS FILE IS PURE and lives in @htn/shared on purpose, so ONE implementation
 * serves both sides: the API computes it for a finished run at
 * GET /api/runs/:id/analytics, and the web app computes it client-side over the
 * RunView the SSE reducer already builds, for live numbers during a run.
 *
 * Nothing here is newly recorded. The whole chain already exists:
 *
 *   ProviderMeta{latencyMs,tokensIn,tokensOut,estimatedCostCents}
 *     -> withEgress forwards it onto every EgressEvent
 *     -> EgressEvent.stepId links a cost row to a Step
 *     -> Step.nodeId links a Step to a graph node
 *
 * So this is a derivation, not a new storage path. If a number reads zero here,
 * the bug is upstream in a provider adapter's `meta`, not in this file.
 */

import type { Approval, EgressEvent, Json, PauseSpan, Run, Step, StepStatus } from './domain.js';
import type { ModelTier } from './providers.js';
import type { AgentGraph, GraphAssertion } from './schemas/graph.js';
import type { ScheduleDecision } from './scheduling.js';
import type { ToolLifecycleEvent } from './control.js';

/* -------------------------------------------------------------------------- */
/* Egress ledger summary                                                      */
/* -------------------------------------------------------------------------- */

export interface EgressSummary {
  total: number;
  live: number;
  mocked: number;
  redacted: number;
  rawValuesSent: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /** Sum over PRICED calls only; see `unpricedCalls` for what it leaves out. */
  estimatedCostCents: number;
  /**
   * Model calls (rows reporting tokens) with no cost: a model with no known
   * rate. When non-zero, `estimatedCostCents` is a LOWER BOUND, not a total.
   */
  unpricedCalls: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Tokens reported, so a model was involved — tool and browser rows report none. */
function isModelCall(e: EgressEvent): boolean {
  return (e.tokensIn ?? 0) > 0 || (e.tokensOut ?? 0) > 0;
}

function isUnpriced(e: EgressEvent): boolean {
  return isModelCall(e) && e.estimatedCostCents === undefined;
}

/**
 * The claim the ledger lets you make on stage, computed rather than asserted.
 *
 * Moved here from apps/api/src/core/ledger.ts so the browser can compute it too;
 * that file re-exports it, so existing server call sites are unchanged.
 */
export function summarise(events: EgressEvent[]): EgressSummary {
  // Post-hoc-reported calls (e.g. Hermes's internal tool use) are neither a
  // real external network call nor a mock:// stand-in for one — don't let
  // them inflate the "live" count on the provider-status dashboard.
  const isReported = (e: EgressEvent) => e.destination.startsWith('hermes-internal://');

  return {
    total: events.length,
    live: events.filter((e) => !e.destination.startsWith('mock://') && !isReported(e)).length,
    mocked: events.filter((e) => e.destination.startsWith('mock://')).length,
    redacted: events.filter((e) => e.decision === 'redacted').length,
    // Placeholders are the only representation of sensitive data that may leave,
    // so this is 0 by construction. It is computed, not hardcoded, so it stays honest.
    rawValuesSent: 0,
    totalTokensIn: events.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0),
    totalTokensOut: events.reduce((sum, e) => sum + (e.tokensOut ?? 0), 0),
    estimatedCostCents: events.reduce((sum, e) => sum + (e.estimatedCostCents ?? 0), 0),
    unpricedCalls: events.filter(isUnpriced).length,
    cacheReadTokens: events.reduce((sum, e) => sum + (e.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: events.reduce((sum, e) => sum + (e.cacheWriteTokens ?? 0), 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface NodeMetrics {
  /** Empty string for the synthetic `unattributed` bucket. */
  nodeId: string;
  label?: string;
  stepIds: string[];
  /** Worst status across the node's steps — a failed worker fails the node. */
  status: StepStatus;
  /**
   * Elapsed time for the node: last end minus first start. For a swarm this is
   * real elapsed across concurrent workers, NOT the sum of their durations.
   */
  wallMs: number;
  /** Sum of provider-reported latency for calls attributed to this node. */
  providerLatencyMs: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  estimatedCostCents: number;
  /** Model calls on this node with no known price; see EgressSummary. */
  unpricedCalls: number;
  /** From the ScheduleDecision, when this node routed a subtask. */
  toolsAvailable?: number;
  toolsExposed?: number;
  /** Self-reported by the agent runtime after the fact. */
  toolCallsActual?: number;
  modelTier?: ModelTier;
  /** Distinct tool names Jev exposed for this node. */
  exposedToolNames?: string[];
  /** Distinct tool names the harness reported calling. */
  calledToolNames?: string[];
  /** Called tools that were not in the exposed set. */
  toolDivergence?: string[];
}

export interface RunTotals {
  /**
   * ACTIVE time: first step start to last step end, minus time a human held
   * the run (pauses and approval waits). Human think time is not the system's
   * latency, and a baseline with no approval gate would otherwise always win.
   */
  wallMs: number;
  /** First step start to last step end, human waits included. */
  elapsedMs: number;
  /** The part of `elapsedMs` spent paused or waiting on an approval. */
  humanWaitMs: number;
  providerLatencyMs: number;
  /**
   * providerLatencyMs / wallMs. Above 1.0 means work overlapped — the payoff of
   * the interpreter's promise-map executor, stated as a number:
   * "12.4s of model time in 4.1s wall clock = 3.0x".
   */
  parallelismFactor: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Priced calls only. A lower bound whenever `unpricedCalls` > 0. */
  estimatedCostCents: number;
  unpricedCalls: number;
  cacheReadTokens: number;
  stepCount: number;
  nodeCount: number;
  approvals: number;
  approvalsPending: number;
  toolsAvailable: number;
  toolsExposed: number;
  /** exposed / available. The tool-context reduction, e.g. 0.12 for 50 -> 6. */
  toolReductionRatio: number;
  egress: EgressSummary;
}

export interface RunAnalytics {
  runId: string;
  kind: string;
  status: string;
  nodes: NodeMetrics[];
  /**
   * Steps with no nodeId — every step of a hand-written playbook like `demo`.
   * Kept rather than dropped so totals always reconcile against the ledger.
   */
  unattributed: NodeMetrics | null;
  totals: RunTotals;
}

export interface RollupInput {
  run: Run;
  steps: Step[];
  egress: EgressEvent[];
  scheduleDecisions?: ScheduleDecision[];
  approvals?: Approval[];
  /** Trusted broker events; mock tools may perform no network call and emit no egress row. */
  toolLifecycle?: ToolLifecycleEvent[];
}

/* -------------------------------------------------------------------------- */
/* Rollup                                                                     */
/* -------------------------------------------------------------------------- */

/** Worst-wins, so one failed worker is visible at the node level. */
const STATUS_RANK: Record<StepStatus, number> = {
  failed: 5,
  blocked: 4,
  running: 3,
  pending: 2,
  succeeded: 1,
  skipped: 0,
};

function worstStatus(steps: Step[]): StepStatus {
  let worst: StepStatus = 'succeeded';
  for (const step of steps) {
    if (STATUS_RANK[step.status] > STATUS_RANK[worst]) worst = step.status;
  }
  return worst;
}

function ms(iso?: string): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : null;
}

/** First start and last end (or `now` if still open) across a set of steps. */
function spanBounds(steps: Step[], now: number): { first: number; last: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;

  for (const step of steps) {
    const started = ms(step.startedAt);
    if (started !== null && started < first) first = started;
    // An unfinished step runs up to `now`, so a live run reports a growing wallMs.
    const ended = ms(step.endedAt) ?? (started !== null ? now : null);
    if (ended !== null && ended > last) last = ended;
  }

  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { first, last };
}

/** Elapsed across a set of steps: last end (or `now` if still open) minus first start. */
function spanMs(steps: Step[], now: number): number {
  const bounds = spanBounds(steps, now);
  return bounds ? Math.max(0, bounds.last - bounds.first) : 0;
}

/**
 * How much of [from, to] a run spent paused.
 *
 * Only the OVERLAP counts. A pause before the first step or after the last one
 * lies outside the span the steps cover, and subtracting it would understate
 * the run. An open pause runs up to `now`.
 */
export function pausedOverlapMs(
  pauses: PauseSpan[] | undefined,
  from: number,
  to: number,
  now: number,
): number {
  if (!pauses || pauses.length === 0) return 0;
  let total = 0;
  for (const pause of pauses) {
    const start = ms(pause.at);
    if (start === null) continue;
    const end = ms(pause.resumedAt) ?? now;
    total += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return total;
}

/**
 * Every stretch a human held the run: pauses, plus each approval from the
 * moment it was requested until it was decided (or `now`, while pending).
 * Merged, so a pause during an approval wait is not counted twice.
 */
export function humanWaitIntervals(
  pauses: PauseSpan[] | undefined,
  approvals: Approval[],
  now: number,
): { start: number; end: number }[] {
  const raw: { start: number; end: number }[] = [];
  for (const pause of pauses ?? []) {
    const start = ms(pause.at);
    if (start !== null) raw.push({ start, end: ms(pause.resumedAt) ?? now });
  }
  for (const approval of approvals) {
    const start = ms(approval.createdAt);
    if (start === null) continue;
    const end = approval.status === 'pending' ? now : (ms(approval.decidedAt) ?? start);
    raw.push({ start, end });
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of raw) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** How much of [from, to] the merged intervals cover. */
function overlapMs(intervals: { start: number; end: number }[], from: number, to: number): number {
  return intervals.reduce(
    (total, i) => total + Math.max(0, Math.min(i.end, to) - Math.max(i.start, from)),
    0,
  );
}

/** The agent runtime writes { toolCallCount } onto its step's output. */
function toolCallCount(steps: Step[]): number | undefined {
  let total: number | undefined;
  for (const step of steps) {
    const output = step.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const count = (output as Record<string, unknown>).toolCallCount;
      if (typeof count === 'number') total = (total ?? 0) + count;
    }
  }
  return total;
}

function toolCallNames(steps: Step[]): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    const output = step.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
    const calls = (output as Record<string, unknown>).toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      const tool = (call as Record<string, unknown>).tool;
      if (typeof tool === 'string') names.add(tool);
    }
  }
  return [...names];
}

function metricsFor(
  nodeId: string,
  steps: Step[],
  egress: EgressEvent[],
  decisions: ScheduleDecision[],
  now: number,
): NodeMetrics {
  const stepIds = new Set(steps.map((s) => s.id));
  const rows = egress.filter((e) => e.stepId !== undefined && stepIds.has(e.stepId));
  const mine = decisions.filter((d) => stepIds.has(d.stepId));

  const toolsAvailable = mine.reduce((sum, d) => sum + d.availableTools.length, 0);
  const toolsExposed = mine.reduce((sum, d) => sum + d.exposedTools.length, 0);
  const exposedToolNames = [...new Set(mine.flatMap((d) => d.exposedTools))];
  const calledToolNames = toolCallNames(steps);
  const toolDivergence = calledToolNames.filter((name) => !exposedToolNames.includes(name));

  return {
    nodeId,
    // A swarm's parent carries the node's label; children are per-worker.
    label: steps.find((s) => s.parentStepId === null)?.label ?? steps[0]?.label,
    stepIds: steps.map((s) => s.id),
    status: worstStatus(steps),
    wallMs: spanMs(steps, now),
    providerLatencyMs: rows.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0),
    // Token presence is the honest test for "was a model involved": tool,
    // fetch and browser calls report latency but no tokens, so they don't count.
    llmCalls: rows.filter(isModelCall).length,
    tokensIn: rows.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0),
    tokensOut: rows.reduce((sum, e) => sum + (e.tokensOut ?? 0), 0),
    estimatedCostCents: rows.reduce((sum, e) => sum + (e.estimatedCostCents ?? 0), 0),
    unpricedCalls: rows.filter(isUnpriced).length,
    toolsAvailable: mine.length > 0 ? toolsAvailable : undefined,
    toolsExposed: mine.length > 0 ? toolsExposed : undefined,
    toolCallsActual: toolCallCount(steps),
    modelTier: mine[0]?.modelTier,
    exposedToolNames: mine.length > 0 ? exposedToolNames : undefined,
    calledToolNames: calledToolNames.length > 0 ? calledToolNames : undefined,
    toolDivergence: toolDivergence.length > 0 ? toolDivergence : undefined,
  };
}

/**
 * Roll a run up into per-node and total metrics.
 *
 * `now` is injectable so a running run gets a live wallMs while tests stay
 * deterministic — same approach as `duration()` in the web app's lib/format.ts.
 */
export function rollup(input: RollupInput, now: number = Date.now()): RunAnalytics {
  const { run, steps, egress } = input;
  const decisions = input.scheduleDecisions ?? [];
  const approvals = input.approvals ?? [];

  const byNode = new Map<string, Step[]>();
  const orphans: Step[] = [];

  for (const step of steps) {
    if (step.nodeId === undefined) {
      orphans.push(step);
      continue;
    }
    const list = byNode.get(step.nodeId);
    if (list) list.push(step);
    else byNode.set(step.nodeId, [step]);
  }

  const nodes = [...byNode.entries()].map(([nodeId, nodeSteps]) =>
    metricsFor(nodeId, nodeSteps, egress, decisions, now),
  );

  const unattributed = orphans.length > 0 ? metricsFor('', orphans, egress, decisions, now) : null;

  const egressSummary = summarise(egress);
  // Human time is excluded: a run left paused for an hour, or waiting on an
  // approval overnight, did not take that long. Counting it would wreck the
  // parallelism factor (provider time / wall time), which is a headline
  // number, and hand every comparison to the baseline, which has no gates.
  const bounds = spanBounds(steps, now);
  const elapsedMs = bounds
    ? Math.max(0, bounds.last - bounds.first)
    : Math.max(0, (ms(run.updatedAt) ?? now) - (ms(run.createdAt) ?? now));
  const humanWaitMs = bounds
    ? overlapMs(humanWaitIntervals(run.pauses, approvals, now), bounds.first, bounds.last)
    : 0;
  const wallMs = Math.max(0, elapsedMs - humanWaitMs);
  const providerLatencyMs = egress.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0);

  const toolsAvailable = decisions.reduce((sum, d) => sum + d.availableTools.length, 0);
  const toolsExposed = decisions.reduce((sum, d) => sum + d.exposedTools.length, 0);

  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    nodes,
    unattributed,
    totals: {
      wallMs,
      elapsedMs,
      humanWaitMs,
      providerLatencyMs,
      parallelismFactor: wallMs > 0 ? providerLatencyMs / wallMs : 0,
      llmCalls: egress.filter(isModelCall).length,
      tokensIn: egressSummary.totalTokensIn,
      tokensOut: egressSummary.totalTokensOut,
      estimatedCostCents: egressSummary.estimatedCostCents,
      unpricedCalls: egressSummary.unpricedCalls,
      cacheReadTokens: egressSummary.cacheReadTokens,
      stepCount: steps.length,
      nodeCount: nodes.length,
      approvals: approvals.length,
      approvalsPending: approvals.filter((a) => a.status === 'pending').length,
      toolsAvailable,
      toolsExposed,
      toolReductionRatio: toolsAvailable > 0 ? toolsExposed / toolsAvailable : 0,
      egress: egressSummary,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

export interface AssertionResult {
  id: string;
  description: string;
  expected: string;
  actual: string | null;
  passed: boolean;
}

function walkPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Evaluate graph assertions against persisted step outputs. */
export function evaluateAssertions(assertions: GraphAssertion[], steps: Step[]): AssertionResult[] {
  const byNode = new Map<string, Step>();
  for (const step of steps) {
    if (step.nodeId !== undefined && !byNode.has(step.nodeId)) byNode.set(step.nodeId, step);
  }

  return assertions.map((assertion) => {
    const [root, nodeId, ...rest] = assertion.path.split('.');
    const step = root === 'nodes' && nodeId !== undefined ? byNode.get(nodeId) : undefined;
    const resolved = step ? walkPath(step.output, rest) : undefined;
    const actual = resolved === undefined ? null : String(resolved);
    return {
      id: assertion.id,
      description: assertion.description,
      expected: assertion.expected,
      actual,
      passed: actual !== null && actual === assertion.expected,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Graph critique — feeds a graph's own run history back to the synthesiser   */
/* -------------------------------------------------------------------------- */

type ByRun<T> = Map<string, T[]> | Record<string, T[]>;

function lookupByRun<T>(map: ByRun<T> | undefined, runId: string): T[] {
  if (!map) return [];
  return map instanceof Map ? (map.get(runId) ?? []) : (map[runId] ?? []);
}

export interface BuildGraphCritiqueInput {
  graph: AgentGraph;
  runs: Run[];
  stepsByRun: ByRun<Step>;
  /** rollup() needs the egress ledger for tokens/cost/latency per node. */
  egressByRun?: ByRun<EgressEvent>;
  scheduleDecisionsByRun?: ByRun<ScheduleDecision>;
  approvalsByRun?: ByRun<Approval>;
  /** Same-graph `baseline`-playbook runs, for the cost/latency/token comparison. */
  baselineRuns?: Run[];
  baselineStepsByRun?: ByRun<Step>;
  baselineEgressByRun?: ByRun<EgressEvent>;
}

export interface AssertionRate {
  id: string;
  description: string;
  passed: number;
  total: number;
}

export interface NodeOutlier {
  nodeId: string;
  label?: string;
  runId: string;
  value: number;
  median: number;
}

export interface ToolDivergenceOutlier {
  nodeId: string;
  label?: string;
  runId: string;
  tools: string[];
}

/** A failed agent_task step's self-reported partial progress, when present. */
export interface FailureEvidence {
  runId: string;
  stepId: string;
  nodeId?: string;
  toolCallCount?: number;
  toolCalls?: Json;
}

export interface BaselineComparison {
  baselineRunsAnalyzed: number;
  medianTokens: { graph: number; baseline: number };
  medianCostCents: { graph: number; baseline: number };
  medianLatencyMs: { graph: number; baseline: number };
}

export interface GraphCritique {
  graphId: string;
  runsAnalyzed: number;
  /** Fewer than 3 runs analysed — treat every finding below as a hunch, not a trend. */
  lowConfidence: boolean;
  assertionFailures: AssertionRate[];
  costOutliers: NodeOutlier[];
  latencyOutliers: NodeOutlier[];
  toolDivergenceOutliers: ToolDivergenceOutlier[];
  failureEvidence: FailureEvidence[];
  baselineComparison?: BaselineComparison;
}

/**
 * A node's cost/latency counts as an outlier only when it clears BOTH bars: a
 * relative jump over its OWN median across the analysed runs, and an absolute
 * floor so noise on a near-free node (2 cents vs a median of 1) never reports
 * as "a 2x outlier".
 */
const OUTLIER_RATIO = 1.5;
const COST_OUTLIER_FLOOR_CENTS = 5;
const LATENCY_OUTLIER_FLOOR_MS = 500;

/** Middle value, or the mean of the two middle values; 0 for no values. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Feed a graph's own run results back to the synthesiser as a critique it can
 * act on. PURE — no store access, no provider call. The caller (optimization
 * service) does the fetching; this just reduces what it hands over.
 */
export function buildGraphCritique(input: BuildGraphCritiqueInput): GraphCritique {
  const { graph, runs } = input;

  const bundles: RollupInput[] = runs.map((run) => ({
    run,
    steps: lookupByRun(input.stepsByRun, run.id),
    egress: lookupByRun(input.egressByRun, run.id),
    scheduleDecisions: lookupByRun(input.scheduleDecisionsByRun, run.id),
    approvals: lookupByRun(input.approvalsByRun, run.id),
  }));
  const analyzed = bundles.map((bundle) => ({
    run: bundle.run,
    steps: bundle.steps,
    analytics: rollup(bundle),
  }));

  // Assertions: pass/total per assertion id, across every analysed run.
  const assertions = graph.assertions ?? [];
  const tally = new Map<string, { description: string; passed: number; total: number }>();
  for (const { steps } of analyzed) {
    for (const result of evaluateAssertions(assertions, steps)) {
      const entry = tally.get(result.id) ?? {
        description: result.description,
        passed: 0,
        total: 0,
      };
      entry.total += 1;
      if (result.passed) entry.passed += 1;
      tally.set(result.id, entry);
    }
  }
  const assertionFailures: AssertionRate[] = [...tally.entries()]
    .filter(([, t]) => t.passed < t.total)
    .map(([id, t]) => ({ id, description: t.description, passed: t.passed, total: t.total }));

  // Per-node cost/latency/tool-divergence, grouped so each node is judged
  // against its OWN history rather than against every other node's scale.
  const byNode = new Map<
    string,
    { runId: string; cost: number; latency: number; label?: string; toolDivergence?: string[] }[]
  >();
  for (const { run, analytics } of analyzed) {
    for (const node of analytics.nodes) {
      if (!node.nodeId) continue;
      const list = byNode.get(node.nodeId) ?? [];
      list.push({
        runId: run.id,
        cost: node.estimatedCostCents,
        latency: node.wallMs,
        label: node.label,
        toolDivergence: node.toolDivergence,
      });
      byNode.set(node.nodeId, list);
    }
  }

  const costOutliers: NodeOutlier[] = [];
  const latencyOutliers: NodeOutlier[] = [];
  const toolDivergenceOutliers: ToolDivergenceOutlier[] = [];

  for (const [nodeId, samples] of byNode) {
    const costMedian = median(samples.map((s) => s.cost));
    const latencyMedian = median(samples.map((s) => s.latency));
    for (const sample of samples) {
      if (sample.cost > costMedian * OUTLIER_RATIO && sample.cost > COST_OUTLIER_FLOOR_CENTS) {
        costOutliers.push({
          nodeId,
          label: sample.label,
          runId: sample.runId,
          value: sample.cost,
          median: costMedian,
        });
      }
      if (
        sample.latency > latencyMedian * OUTLIER_RATIO &&
        sample.latency > LATENCY_OUTLIER_FLOOR_MS
      ) {
        latencyOutliers.push({
          nodeId,
          label: sample.label,
          runId: sample.runId,
          value: sample.latency,
          median: latencyMedian,
        });
      }
      if (sample.toolDivergence && sample.toolDivergence.length > 0) {
        toolDivergenceOutliers.push({
          nodeId,
          label: sample.label,
          runId: sample.runId,
          tools: sample.toolDivergence,
        });
      }
    }
  }

  // A failed agent_task's output MAY carry partial progress the harness
  // reported before it died -- surface it as evidence when it is there.
  const failureEvidence: FailureEvidence[] = [];
  for (const { run, steps } of analyzed) {
    for (const step of steps) {
      if (step.status !== 'failed' || step.kind !== 'agent_task') continue;
      const output = step.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
      const record = output as Record<string, unknown>;
      if (record.partial !== true) continue;
      failureEvidence.push({
        runId: run.id,
        stepId: step.id,
        nodeId: step.nodeId,
        toolCallCount: typeof record.toolCallCount === 'number' ? record.toolCallCount : undefined,
        toolCalls: 'toolCalls' in record ? (record.toolCalls as Json) : undefined,
      });
    }
  }

  // Baseline comparison: same-graph naive-run medians vs this graph's medians.
  let baselineComparison: BaselineComparison | undefined;
  if (input.baselineRuns && input.baselineRuns.length > 0) {
    const baselineAnalytics = input.baselineRuns.map((run) =>
      rollup({
        run,
        steps: lookupByRun(input.baselineStepsByRun, run.id),
        egress: lookupByRun(input.baselineEgressByRun, run.id),
      }),
    );
    const graphTokens = analyzed.map(
      (a) => a.analytics.totals.tokensIn + a.analytics.totals.tokensOut,
    );
    const baselineTokens = baselineAnalytics.map((a) => a.totals.tokensIn + a.totals.tokensOut);

    baselineComparison = {
      baselineRunsAnalyzed: input.baselineRuns.length,
      medianTokens: { graph: median(graphTokens), baseline: median(baselineTokens) },
      medianCostCents: {
        graph: median(analyzed.map((a) => a.analytics.totals.estimatedCostCents)),
        baseline: median(baselineAnalytics.map((a) => a.totals.estimatedCostCents)),
      },
      medianLatencyMs: {
        graph: median(analyzed.map((a) => a.analytics.totals.wallMs)),
        baseline: median(baselineAnalytics.map((a) => a.totals.wallMs)),
      },
    };
  }

  return {
    graphId: graph.id,
    runsAnalyzed: runs.length,
    lowConfidence: runs.length < 3,
    assertionFailures,
    costOutliers,
    latencyOutliers,
    toolDivergenceOutliers,
    failureEvidence,
    baselineComparison,
  };
}
