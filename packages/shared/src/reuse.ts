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
   * picks, which the browser decider does not write to the ledger.
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
  const ledgerJev = input.egress.filter(
    (row) => row.providerId === 'jev' && !row.destination.startsWith('hermes-internal://'),
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
}
