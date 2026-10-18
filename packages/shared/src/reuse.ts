/**
 * How much of a run's decision-making was REUSED rather than asked again:
 * frozen graph decisions (compiled routes, fixed dispatch choices) and
 * remembered browser targets, against the Jev decisions it still made.
 *
 * Derived from records every run already keeps (schedule decisions, tool
 * lifecycle events, the egress ledger); nothing new is stored to compute it.
 * A run that reused anything is WARM: benchmark reports keep warm and cold
 * runs apart, because the baseline arms never reuse anything.
 */

import type { RollupInput } from './analytics.js';

export interface ReuseCounts {
  /** Agent routes and dispatch choices taken from the graph's frozen decisions. */
  frozenDecisions: number;
  /** Agent routes and dispatch choices Jev made during the run. */
  liveDecisions: number;
  /** Browser targets replayed from the run cache or cross-run memory. */
  rememberedTargets: number;
  /** Browser targets Jev (or its deterministic fallback) picked. */
  decidedTargets: number;
}

export interface RunReuse extends ReuseCounts {
  /**
   * Jev round trips: decision-provider rows in the ledger plus browser target
   * picks, counted from tool reviews (their ledger rows are skipped, not added).
   */
  jevCalls: number;
  warm: boolean;
  byNode: Record<string, ReuseCounts>;
}

const FROZEN_RULES = new Set(['compiled-graph-route', 'dispatch-compiled-single-tool']);
const LIVE_RULES = new Set(['jev-routed', 'dispatch-selected-single-tool']);

function empty(): ReuseCounts {
  return { frozenDecisions: 0, liveDecisions: 0, rememberedTargets: 0, decidedTargets: 0 };
}

function browserReview(value: unknown): { decisionSource?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const review = value as Record<string, unknown>;
  return review.kind === 'browser_target'
    ? {
        decisionSource:
          typeof review.decisionSource === 'string' ? review.decisionSource : undefined,
      }
    : undefined;
}

export function runReuse(input: RollupInput): RunReuse {
  const nodeOf = new Map(input.steps.map((step) => [step.id, step.nodeId]));
  const totals = empty();
  const byNode: Record<string, ReuseCounts> = {};
  const add = (stepId: string | undefined, key: keyof ReuseCounts) => {
    totals[key] += 1;
    const nodeId = stepId ? nodeOf.get(stepId) : undefined;
    if (nodeId) (byNode[nodeId] ??= empty())[key] += 1;
  };

  for (const decision of input.scheduleDecisions ?? []) {
    if (FROZEN_RULES.has(decision.rule)) add(decision.stepId, 'frozenDecisions');
    else if (LIVE_RULES.has(decision.rule)) add(decision.stepId, 'liveDecisions');
  }
  for (const event of input.toolLifecycle ?? []) {
    if (event.phase !== 'proposed') continue;
    const review = browserReview(event.action.review);
    if (!review) continue;
    add(
      event.stepId,
      review.decisionSource === 'memory' || review.decisionSource === 'cache'
        ? 'rememberedTargets'
        : 'decidedTargets',
    );
  }
  // Browser picks also land in the ledger (op 'browser_target'); they are
  // counted from the tool reviews below, which also see picks made without one.
  const ledgerJev = input.egress.filter(
    (row) =>
      row.providerId === 'jev' &&
      row.op !== 'browser_target' &&
      !row.destination.startsWith('hermes-internal://'),
  ).length;
  const jevTargetPicks = (input.toolLifecycle ?? []).filter(
    (event) =>
      event.phase === 'proposed' && browserReview(event.action.review)?.decisionSource === 'jev',
  ).length;
  return {
    ...totals,
    jevCalls: ledgerJev + jevTargetPicks,
    warm: totals.frozenDecisions + totals.rememberedTargets > 0,
    byNode,
  };
}

/** Per node across a graph's recent runs, plus what is frozen or remembered for it now. */
export interface NodeReuse extends ReuseCounts {
  /** Recent runs in which this node made or reused a decision. */
  runs: number;
  /** A frozen decision the graph carries for this node right now. */
  compiled?: { kind: 'agent_route' | 'dispatch'; source: 'compile' | 'run' };
  /** Cross-run browser targets remembered for this node. */
  remembered: { entries: number; hits: number; misses: number; corrected: number };
}

/**
 * A remembered page that keeps missing has probably been redesigned; a site
 * that keeps blocking automated reads needs a person or another backend.
 */
export interface ReuseAlert {
  kind: 'site_changed' | 'site_blocked';
  origin: string;
  pathTemplate?: string;
  detail: string;
}

export interface GraphReuseReport {
  graphId: string;
  /** Recent graph runs the counts are drawn from. */
  runs: number;
  warmRuns: number;
  medianJevCalls: number;
  totals: ReuseCounts;
  nodes: Record<string, NodeReuse>;
  alerts: ReuseAlert[];
  /** Agent nodes that keep doing the same thing and could be fixed steps. */
  promotions: PromotionCandidate[];
}

/* -------------------------------------------------------------------------- */
/* Promotion: an agent node that keeps doing the same thing                   */
/* -------------------------------------------------------------------------- */

/**
 * An agent_task node whose recent runs all finished with a verified `done`,
 * were exposed the same tools and called the same tools in the same order.
 * Its harness loop is no longer earning its cost: the same work could be
 * fixed graph steps (one model-free call each, still brokered and approved).
 * A suggestion for a person or the optimizer, never applied automatically.
 */
export interface PromotionCandidate {
  nodeId: string;
  /** Consecutive most-recent runs that agree. */
  runs: number;
  /** Tool ids in call order. */
  tools: string[];
  exposedTools: string[];
  /** Every call had identical arguments in every run. */
  stableArguments: boolean;
  /** The arguments, only when stable AND every call was on public data. */
  arguments?: unknown[];
  suggestion: 'dispatch' | 'tool_nodes';
}

const MIN_PROMOTION_RUNS = 3;

/** `runs` newest first, as the store lists them. */
export function promotionCandidates(input: {
  graph: import('./schemas/graph.js').AgentGraph;
  runs: RollupInput[];
  minRuns?: number;
}): PromotionCandidate[] {
  const minRuns = input.minRuns ?? MIN_PROMOTION_RUNS;
  const out: PromotionCandidate[] = [];
  for (const node of input.graph.nodes) {
    if (node.type !== 'agent_task') continue;
    const observed: { tools: string[]; exposed: string[]; args: string[]; public: boolean }[] = [];
    for (const run of input.runs) {
      const steps = run.steps.filter((step) => step.nodeId === node.id);
      const verified = steps.some((step) => {
        const decision = (
          step.output as { completionDecision?: { status?: string; verified?: boolean } } | null
        )?.completionDecision;
        return decision?.status === 'done' && decision.verified === true;
      });
      // Only an unbroken streak of verified runs counts; older agreement does not.
      if (!verified) break;
      const stepIds = new Set(steps.map((step) => step.id));
      const calls = (run.toolLifecycle ?? [])
        .filter((event) => event.phase === 'succeeded' && stepIds.has(event.stepId))
        .sort((a, b) => a.at.localeCompare(b.at));
      const exposed =
        (run.scheduleDecisions ?? []).find(
          (decision) =>
            stepIds.has(decision.stepId) && decision.requestedCapability === 'agent.runtime',
        )?.exposedTools ?? [];
      observed.push({
        tools: calls.map((event) => event.action.toolId),
        exposed: [...exposed].sort(),
        args: calls.map((event) => JSON.stringify(event.action.arguments)),
        public: calls.every((event) =>
          event.action.dataLabels.every((label) => label === 'public'),
        ),
      });
    }
    if (observed.length < minRuns) continue;
    const first = observed[0]!;
    if (first.tools.length === 0) continue;
    const same = (a: string[], b: string[]) =>
      a.length === b.length && a.every((item, i) => item === b[i]);
    if (!observed.every((run) => same(run.tools, first.tools) && same(run.exposed, first.exposed)))
      continue;
    const stableArguments = observed.every((run) => same(run.args, first.args));
    const allPublic = observed.every((run) => run.public);
    out.push({
      nodeId: node.id,
      runs: observed.length,
      tools: first.tools,
      exposedTools: first.exposed,
      stableArguments,
      ...(stableArguments && allPublic
        ? { arguments: first.args.map((json) => JSON.parse(json) as unknown) }
        : {}),
      suggestion: first.tools.length === 1 ? 'dispatch' : 'tool_nodes',
    });
  }
  return out;
}
