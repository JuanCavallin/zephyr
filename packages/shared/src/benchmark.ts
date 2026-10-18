/**
 * Graph vs baseline benchmark — the ONE implementation of the comparison math.
 *
 * Pure and in @htn/shared so the API endpoint (GET /api/benchmarks), the
 * Benchmarks page and the repeat-run script (scripts/benchmark.ts) cannot
 * drift: they all reduce the same runs with this file.
 *
 * Three arms per graph:
 *   graph           the orchestrated run
 *   baseline        B0 — one frontier call, no tools
 *   baseline_agent  B1 — one agent, frontier model, every tool, no Jev
 *
 * The rules, each one deliberate:
 *   - SUCCESS is "run succeeded AND every graph assertion passed". A run that
 *     finished but answered wrong is a failure. With no assertions, success
 *     falls back to "succeeded" and the result says so (`hasAssertions`).
 *   - The headline cost metric is COST PER SUCCESS (total spend / successes).
 *     Per-run cost alone rewards an arm that is cheap because it gives up.
 *   - SAVINGS COUNT ONLY WHEN BOTH SIDES SUCCEED (the design spec's evaluation
 *     rule): runs are paired, and only pairs where both passed contribute.
 *   - Costs are lower bounds whenever any call was unpriced; that is carried
 *     through rather than hidden.
 *   - Mocked runs (any mock:// egress) are separated; their numbers are not
 *     real and are excluded unless the caller explicitly asks.
 */

import { evaluateAssertions, rollup, type AssertionResult, type RollupInput } from './analytics.js';
import { runReuse } from './reuse.js';
import type { Approval, EgressEvent, Run } from './domain.js';
import type { ActionEvidence } from './actionEvidence.js';
import type { AgentGraph, GraphAssertion } from './schemas/graph.js';

export const BENCHMARK_PROTOCOL = 'agentos-benchmark-v2' as const;
export interface BenchmarkExperiment extends Record<string, unknown> {
  protocol: typeof BENCHMARK_PROTOCOL;
  source: 'server';
  fingerprint: string;
  taskHash: string;
  graphHash: string;
  configHash: string;
  inputsHash: string;
  assertionsHash: string;
  graphVersion: number;
  toolIds: string[];
  outcomeAssertions: GraphAssertion[];
}

/** Explicit scope wins; legacy answer nodes remain comparable, internal pipeline nodes do not. */
export function outcomeAssertionsForGraph(graph: AgentGraph): GraphAssertion[] {
  return (graph.assertions ?? []).filter((assertion) => {
    if (assertion.scope) return assertion.scope === 'outcome';
    const [root, id] = assertion.path.split('.');
    const node = graph.nodes.find((candidate) => candidate.id === id);
    return root === 'nodes' && !!node && ['judge', 'decide', 'agent_task'].includes(node.type);
  });
}

export function experimentForRun(run: Run): BenchmarkExperiment | undefined {
  const value = (run.input as { benchmarkExperiment?: BenchmarkExperiment } | null)
    ?.benchmarkExperiment;
  return value?.protocol === BENCHMARK_PROTOCOL &&
    value.source === 'server' &&
    /^[a-f0-9]{64}$/.test(value.fingerprint)
    ? value
    : undefined;
}

/** Empty history is not a proof of simulation. Every positive condition is server metadata. */
export function canAutoApproveMockBenchmark(input: {
  mockAll: boolean;
  providers: readonly { mode: string }[];
  approval: Approval;
  evidence: readonly ActionEvidence[];
  egress: readonly EgressEvent[];
}): boolean {
  if (
    !input.mockAll ||
    !input.providers.length ||
    input.providers.some((provider) => !['mock', 'disabled'].includes(provider.mode)) ||
    input.approval.status !== 'pending'
  )
    return false;
  if (
    input.egress.some(
      (event) =>
        !event.destination.startsWith('mock://') &&
        !event.destination.startsWith('hermes-internal://'),
    )
  )
    return false;
  const action = input.approval.proposedAction;
  if (
    !action ||
    typeof action !== 'object' ||
    Array.isArray(action) ||
    typeof action.actionId !== 'string' ||
    typeof action.previewFingerprint !== 'string'
  )
    return false;
  return input.evidence.some(
    (item) =>
      item.runId === input.approval.runId &&
      item.actionId === action.actionId &&
      item.phase === 'proposed' &&
      item.executionMode === 'mock' &&
      item.fingerprint === action.previewFingerprint,
  );
}

export const BENCHMARK_ARMS = ['graph', 'baseline', 'baseline_agent'] as const;
export type BenchmarkArm = (typeof BENCHMARK_ARMS)[number];

export const BENCHMARK_ARM_LABELS: Record<BenchmarkArm, string> = {
  graph: 'Graph (orchestrated)',
  baseline: 'B0 · one call, no tools',
  baseline_agent: 'B1 · one agent, all tools',
};

export function isBenchmarkArm(kind: string): kind is BenchmarkArm {
  return (BENCHMARK_ARMS as readonly string[]).includes(kind);
}

/**
 * Check graph assertions against a run that has no per-node steps (a baseline):
 * its flat `result` is matched by each assertion path's LAST field name, e.g.
 * "nodes.verdict.choice" -> result.choice. Baselines are asked to reply with
 * exactly those field names (see baselineTask.ts), never the expected values.
 */
export function evaluateAssertionsAgainstResult(
  assertions: GraphAssertion[],
  result: unknown,
): AssertionResult[] {
  return assertions.map((assertion) => {
    const outcomes =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).outcomes
        : undefined;
    const value =
      outcomes &&
      typeof outcomes === 'object' &&
      !Array.isArray(outcomes) &&
      Object.hasOwn(outcomes, assertion.id)
        ? (outcomes as Record<string, unknown>)[assertion.id]
        : undefined;
    const actual = value === undefined || value === null ? null : String(value);
    return {
      id: assertion.id,
      description: assertion.description,
      expected: assertion.expected,
      actual,
      passed: actual !== null && actual === assertion.expected,
    };
  });
}

/** The assertions a run is judged by: a graph's own snapshot, or a baseline's copy. */
export function assertionsForRun(run: Run): GraphAssertion[] {
  const input = (run.input ?? {}) as {
    graphSnapshot?: AgentGraph;
    assertions?: GraphAssertion[];
  };
  return input.graphSnapshot?.assertions ?? input.assertions ?? [];
}

export function outcomeAssertionsForRun(run: Run): GraphAssertion[] {
  const experiment = experimentForRun(run);
  if (experiment) return experiment.outcomeAssertions;
  const input = (run.input ?? {}) as {
    graphSnapshot?: AgentGraph;
    outcomeAssertions?: GraphAssertion[];
  };
  return (
    input.outcomeAssertions ??
    (input.graphSnapshot ? outcomeAssertionsForGraph(input.graphSnapshot) : [])
  );
}

/** Missing completion evidence never upgrades a quiescent agent into a verified answer. */
export function benchmarkCompletionVerified(input: RollupInput): boolean {
  if (input.run.kind === 'baseline') return input.run.status === 'succeeded';
  const result = input.run.result as
    { completion?: { status?: string; verified?: boolean } } | undefined;
  if (input.run.kind === 'baseline_agent')
    return result?.completion?.status === 'done' && result.completion.verified === true;
  const graph = (input.run.input as { graphSnapshot?: AgentGraph })?.graphSnapshot;
  const agentNodes = graph?.nodes.filter((node) => node.type === 'agent_task') ?? [];
  return agentNodes.every((node) =>
    input.steps.some((step) => {
      const output = step.output as
        { completionDecision?: { status?: string; verified?: boolean } } | undefined;
      return (
        step.nodeId === node.id &&
        output?.completionDecision?.status === 'done' &&
        output.completionDecision.verified === true
      );
    }),
  );
}

export function pairIdOf(run: Run): string | undefined {
  const pairId = (run.input as { pairId?: unknown } | null)?.pairId;
  return typeof pairId === 'string' ? pairId : undefined;
}

export interface BenchmarkSample {
  runId: string;
  arm: BenchmarkArm;
  graphId: string;
  pairId?: string;
  createdAt: string;
  status: string;
  hasAssertions: boolean;
  assertionsPassed: number;
  assertionsTotal: number;
  success: boolean;
  costCents: number;
  unpricedCalls: number;
  tokens: number;
  tokensIn?: number;
  tokensOut?: number;
  llmCalls: number;
  wallMs: number;
  humanWaitMs: number;
  mocked: boolean;
  experimentFingerprint?: string;
  qualityEligible?: boolean;
  provenanceKnown?: boolean;
  completionVerified?: boolean;
  pipelineAssertionsPassed?: number;
  pipelineAssertionsTotal?: number;
  /** Jev round trips this run made (see runReuse). */
  jevCalls?: number;
  /** Reused frozen graph decisions or remembered browser targets. */
  warm?: boolean;
}

const SESSION_BOOKKEEPING = new Set(['releaseRun', 'setOwnership']);

export function benchmarkSample(input: RollupInput): BenchmarkSample | null {
  const { run } = input;
  if (!isBenchmarkArm(run.kind) || !run.graphId) return null;
  const analytics = rollup(input);
  const assertions = outcomeAssertionsForRun(run);
  const results =
    run.kind === 'graph'
      ? evaluateAssertions(assertions, input.steps)
      : evaluateAssertionsAgainstResult(assertions, run.result);
  const passed = results.filter((result) => result.passed).length;
  const all = assertionsForRun(run);
  const pipeline = all.filter((item) => !assertions.some((outcome) => outcome.id === item.id));
  const pipelineResults = run.kind === 'graph' ? evaluateAssertions(pipeline, input.steps) : [];
  const events = input.toolLifecycle ?? [];
  const executed = events.filter(
    (event) =>
      event.phase === 'succeeded' ||
      event.phase === 'executing' ||
      (event.phase === 'failed' && event.outcome !== 'not_executed'),
  );
  const provenanceKnown =
    input.toolLifecycle !== undefined &&
    executed.every(
      (event) =>
        event.evidence?.executionMode !== undefined ||
        events.some(
          (other) =>
            other.action.id === event.action.id && other.evidence?.executionMode !== undefined,
        ),
    );
  // Session bookkeeping returns no results, so a mock row for it simulates
  // nothing: every run releases every browser backend, used or not. A run
  // that really used a mock backend still has mock open/read rows.
  const mocked =
    input.egress.some(
      (row) => row.destination.startsWith('mock://') && !SESSION_BOOKKEEPING.has(row.op),
    ) || events.some((event) => event.evidence?.executionMode === 'mock');
  const completionVerified = benchmarkCompletionVerified(input);
  const reuse = runReuse(input);
  return {
    runId: run.id,
    arm: run.kind,
    graphId: run.graphId,
    pairId: pairIdOf(run),
    createdAt: run.createdAt,
    status: run.status,
    hasAssertions: assertions.length > 0,
    assertionsPassed: passed,
    assertionsTotal: assertions.length,
    success:
      run.status === 'succeeded' &&
      assertions.length > 0 &&
      passed === assertions.length &&
      completionVerified,
    costCents: analytics.totals.estimatedCostCents,
    unpricedCalls: analytics.totals.unpricedCalls,
    tokens: analytics.totals.tokensIn + analytics.totals.tokensOut,
    tokensIn: analytics.totals.tokensIn,
    tokensOut: analytics.totals.tokensOut,
    llmCalls: analytics.totals.llmCalls,
    wallMs: analytics.totals.wallMs,
    humanWaitMs: analytics.totals.humanWaitMs,
    mocked,
    experimentFingerprint: experimentForRun(run)?.fingerprint,
    qualityEligible: assertions.length > 0,
    provenanceKnown,
    completionVerified,
    pipelineAssertionsPassed: pipelineResults.filter((result) => result.passed).length,
    pipelineAssertionsTotal: pipeline.length,
    jevCalls: reuse.jevCalls,
    warm: reuse.warm,
  };
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

const median = (values: number[]) => quantile(values, 0.5);

/**
 * 95% percentile-bootstrap interval for the median. Seeded, so the page, the
 * endpoint and the script print the SAME interval for the same runs.
 */
function bootstrapMedianCi(values: number[], resamples = 1000): [number, number] | null {
  if (values.length < 3) return null;
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const medians: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const sample = values.map(() => values[Math.floor(random() * values.length)]!);
    medians.push(median(sample));
  }
  return [quantile(medians, 0.025), quantile(medians, 0.975)];
}

export interface ArmStats {
  arm: BenchmarkArm;
  runs: number;
  successes: number;
  successRate: number;
  totalCostCents: number;
  /** Total spend / successes. null when nothing succeeded (cost per success is unbounded). */
  costPerSuccessCents: number | null;
  medianCostCents: number;
  medianTokens: number;
  medianTokensIn?: number;
  medianTokensOut?: number;
  medianLlmCalls?: number;
  medianWallMs: number;
  p95WallMs: number;
  /** Any unpriced call in any run makes every cost figure for this arm a lower bound. */
  unpricedCalls: number;
  medianJevCalls: number;
  /** Runs that reused frozen decisions or remembered targets. */
  warmRuns: number;
}

export interface PairedSaving {
  /** The baseline arm the graph is compared against. */
  versus: Exclude<BenchmarkArm, 'graph'>;
  /** Pairs found at all, and the subset where BOTH runs succeeded. */
  pairs: number;
  bothSucceeded: number;
  /** Median of per-pair (1 - graph / baseline). 0.4 = graph 40% cheaper. Both-succeeded pairs only. */
  medianCostSaving: number | null;
  costSavingCi: [number, number] | null;
  medianTokenSaving: number | null;
  tokenSavingCi?: [number, number] | null;
  medianWallSaving: number | null;
  wallSavingCi?: [number, number] | null;
  /** Pairs where the graph succeeded and this baseline did not, and vice versa. */
  graphOnlyWins: number;
  baselineOnlyWins: number;
  unpricedPairs?: number;
}

export interface GraphBenchmark {
  graphId: string;
  graphName: string;
  hasAssertions: boolean;
  arms: Partial<Record<BenchmarkArm, ArmStats>>;
  savings: PairedSaving[];
  experimentFingerprint?: string;
}

/**
 * Which graph-arm runs a report includes. A warm run reused frozen decisions
 * or remembered targets from earlier runs; report them apart, or a warm graph
 * looks better than the baselines because of the cache, not the graph.
 */
export type BenchmarkWarmth = 'all' | 'cold' | 'warm';

export interface BenchmarkReport {
  includeMocked: boolean;
  warmth?: BenchmarkWarmth;
  mockedRunsExcluded: number;
  ineligibleRunsExcluded?: number;
  graphs: GraphBenchmark[];
  /** Every graph's runs pooled together, per arm. */
  overall: Partial<Record<BenchmarkArm, ArmStats>>;
  overallSavings: PairedSaving[];
}

export function armStats(arm: BenchmarkArm, samples: BenchmarkSample[]): ArmStats {
  const successes = samples.filter((sample) => sample.success).length;
  const totalCostCents = samples.reduce((sum, sample) => sum + sample.costCents, 0);
  return {
    arm,
    runs: samples.length,
    successes,
    successRate: samples.length > 0 ? successes / samples.length : 0,
    totalCostCents,
    costPerSuccessCents: successes > 0 ? totalCostCents / successes : null,
    medianCostCents: median(samples.map((sample) => sample.costCents)),
    medianTokens: median(samples.map((sample) => sample.tokens)),
    medianTokensIn: median(samples.map((sample) => sample.tokensIn ?? 0)),
    medianTokensOut: median(samples.map((sample) => sample.tokensOut ?? 0)),
    medianLlmCalls: median(samples.map((sample) => sample.llmCalls)),
    medianWallMs: median(samples.map((sample) => sample.wallMs)),
    p95WallMs: quantile(
      samples.map((sample) => sample.wallMs),
      0.95,
    ),
    unpricedCalls: samples.reduce((sum, sample) => sum + sample.unpricedCalls, 0),
    medianJevCalls: median(samples.map((sample) => sample.jevCalls ?? 0)),
    warmRuns: samples.filter((sample) => sample.warm === true).length,
  };
}

/**
 * Pair each graph run with ONE run of the other arm on the same graph:
 * the same `pairId` when both carry one (launched together), otherwise the
 * nearest-in-time unused run. Each run is used in at most one pair.
 */
export function pairRuns(
  graphRuns: BenchmarkSample[],
  others: BenchmarkSample[],
): [BenchmarkSample, BenchmarkSample][] {
  const used = new Set<string>();
  const pairs: [BenchmarkSample, BenchmarkSample][] = [];
  for (const graphRun of graphRuns) {
    if (!graphRun.pairId || !graphRun.experimentFingerprint) continue;
    const candidates = others.filter(
      (other) =>
        other.graphId === graphRun.graphId &&
        !used.has(other.runId) &&
        other.experimentFingerprint === graphRun.experimentFingerprint &&
        other.pairId === graphRun.pairId,
    );
    const exact = graphRun.pairId
      ? candidates.find((other) => other.pairId === graphRun.pairId)
      : undefined;
    const nearest = exact;
    if (!nearest) continue;
    used.add(nearest.runId);
    pairs.push([graphRun, nearest]);
  }
  return pairs;
}

function saving(graph: number, baseline: number): number | null {
  return baseline > 0 ? 1 - graph / baseline : null;
}

export function pairedSaving(
  versus: Exclude<BenchmarkArm, 'graph'>,
  graphRuns: BenchmarkSample[],
  baselineRuns: BenchmarkSample[],
): PairedSaving {
  const pairs = pairRuns(graphRuns, baselineRuns);
  const both = pairs.filter(([graph, baseline]) => graph.success && baseline.success);
  const values = (pick: (sample: BenchmarkSample) => number) =>
    both
      .map(([graph, baseline]) => saving(pick(graph), pick(baseline)))
      .filter((value): value is number => value !== null);
  const priced = both.filter(
    ([graph, baseline]) => graph.unpricedCalls === 0 && baseline.unpricedCalls === 0,
  );
  const cost = priced
    .map(([graph, baseline]) => saving(graph.costCents, baseline.costCents))
    .filter((value): value is number => value !== null);
  const tokens = values((sample) => sample.tokens);
  const wall = values((sample) => sample.wallMs);
  return {
    versus,
    pairs: pairs.length,
    bothSucceeded: both.length,
    medianCostSaving: cost.length > 0 ? median(cost) : null,
    costSavingCi: bootstrapMedianCi(cost),
    unpricedPairs: both.length - priced.length,
    medianTokenSaving: tokens.length > 0 ? median(tokens) : null,
    tokenSavingCi: bootstrapMedianCi(tokens),
    medianWallSaving: wall.length > 0 ? median(wall) : null,
    wallSavingCi: bootstrapMedianCi(wall),
    graphOnlyWins: pairs.filter(([graph, baseline]) => graph.success && !baseline.success).length,
    baselineOnlyWins: pairs.filter(([graph, baseline]) => !graph.success && baseline.success)
      .length,
  };
}

function statsByArm(samples: BenchmarkSample[]): Partial<Record<BenchmarkArm, ArmStats>> {
  const arms: Partial<Record<BenchmarkArm, ArmStats>> = {};
  for (const arm of BENCHMARK_ARMS) {
    const mine = samples.filter((sample) => sample.arm === arm);
    if (mine.length > 0) arms[arm] = armStats(arm, mine);
  }
  return arms;
}

function savingsFor(samples: BenchmarkSample[]): PairedSaving[] {
  const graphRuns = samples.filter((sample) => sample.arm === 'graph');
  return (['baseline', 'baseline_agent'] as const)
    .map((versus) =>
      pairedSaving(
        versus,
        graphRuns,
        samples.filter((sample) => sample.arm === versus),
      ),
    )
    .filter((entry) => entry.pairs > 0);
}

/** Reduce terminal samples into the per-graph and pooled report. */
export function buildBenchmarkReport(
  allSamples: BenchmarkSample[],
  graphNames: Record<string, string>,
  options: { includeMocked?: boolean; warmth?: BenchmarkWarmth } = {},
): BenchmarkReport {
  const includeMocked = options.includeMocked ?? false;
  const warmth = options.warmth ?? 'all';
  const eligible = allSamples.filter(
    (sample) =>
      !!sample.experimentFingerprint &&
      sample.qualityEligible === true &&
      sample.provenanceKnown === true &&
      // Only the graph arm can be warm; baselines never reuse anything.
      (warmth === 'all' ||
        sample.arm !== 'graph' ||
        (warmth === 'warm') === (sample.warm === true)),
  );
  const samples = includeMocked ? eligible : eligible.filter((sample) => !sample.mocked);
  const experimentKeys = [
    ...new Set(samples.map((sample) => sample.graphId + ':' + sample.experimentFingerprint)),
  ];
  const graphs = experimentKeys
    .map((key) => {
      const mine = samples.filter(
        (sample) => sample.graphId + ':' + sample.experimentFingerprint === key,
      );
      const graphId = mine[0]!.graphId;
      return {
        graphId,
        experimentFingerprint: mine[0]!.experimentFingerprint,
        graphName: graphNames[graphId] ?? graphId,
        hasAssertions: mine.some((sample) => sample.hasAssertions),
        arms: statsByArm(mine),
        savings: savingsFor(mine),
      };
    })
    // Only graphs with something to compare against are a benchmark.
    .filter((graph) => Object.keys(graph.arms).length > 1)
    .sort((a, b) => a.graphName.localeCompare(b.graphName));
  const compared = samples.filter((sample) =>
    graphs.some(
      (graph) =>
        graph.graphId === sample.graphId &&
        graph.experimentFingerprint === sample.experimentFingerprint,
    ),
  );
  return {
    includeMocked,
    warmth,
    mockedRunsExcluded: includeMocked ? 0 : allSamples.filter((sample) => sample.mocked).length,
    ineligibleRunsExcluded: allSamples.length - eligible.length,
    graphs,
    overall: statsByArm(compared),
    overallSavings: savingsFor(compared),
  };
}
