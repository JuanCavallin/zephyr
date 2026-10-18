/**
 * Core domain entities.
 *
 * These describe SUPERVISED AGENTIC WORK, deliberately not any subject matter.
 * There is no TuitionStatement, no InsuranceClaim, no Listing anywhere in here —
 * all product specificity lives in `Run.kind`, the Json blobs, and one playbook file.
 *
 * Rule for edits: ADDITIVE ONLY, and new fields are optional. That keeps old
 * fixtures and old code compiling at 3am.
 */

import type { PiiType, Reversibility, RiskClass } from './policy.js';
import type { ProviderId } from './providers.js';

/** ISO-8601 timestamp. */
export type Iso = string;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

export type RunStatus =
  | 'pending'
  | 'running'
  /** Blocked on a human decision about one exact action. */
  | 'awaiting_approval'
  /**
   * Blocked on the human generally — either they hit pause, or the completion
   * judge returned `blocked`. Distinct from 'awaiting_approval' because there
   * is no single action to decide, and distinct from 'failed' because the run
   * is still resumable.
   */
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** A terminal status means no further events will arrive for this run. */
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * What the OPERATOR has asked of a live run -- kept apart from `status` (what
 * the run is DOING) because the two are independent: a run can be blocked on an
 * approval and have a pause requested at the same moment.
 *
 *   running   the default. Absent on a run that was never paused.
 *   pausing   pause requested. Nothing NEW may start; work already in flight is
 *             allowed to finish. This is a wait, not an interrupt -- see
 *             core/runGate.ts for why, and for what counts as "in flight".
 *   paused    nothing is running. Resume continues from the next step.
 *
 * Cleared when the run reaches a terminal status.
 */
export type RunControl = 'running' | 'pausing' | 'paused';

/**
 * One stretch a run spent fully paused: from the moment nothing was running
 * until it was resumed. The `pausing` drain is NOT included, because work was
 * still happening then and it belongs in the run's time.
 */
export interface PauseSpan {
  at: Iso;
  /** Absent while the pause is still open. */
  resumedAt?: Iso;
}

export interface Run {
  id: string;
  /** Playbook id. THE pivot knob — the only product-specific thing at this level. */
  kind: string;
  title: string;
  status: RunStatus;
  /** Shape is validated per-kind by a zod schema in `schemas/playbooks`. */
  input: Json;
  /** Graph associated with graph/baseline runs, when applicable. */
  graphId?: string;
  /** One-line human result, rendered on the run card. */
  summary?: string;
  /** Per-kind payload. The UI picks a result renderer by `kind`. */
  result?: Json;
  error?: { code: string; message: string };
  /** See RunControl. Only meaningful while the run is non-terminal. */
  control?: RunControl;
  /** Every completed or open pause, oldest first. Lets analytics exclude idle time. */
  pauses?: PauseSpan[];
  createdAt: Iso;
  updatedAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Step                                                                       */
/* -------------------------------------------------------------------------- */

export type StepStatus = 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'skipped';

export interface Step {
  id: string;
  runId: string;
  /**
   * Swarm fan-out tree, for free. A fan-out is N steps sharing a parent; the judge
   * is a sibling step whose input references them. No separate entity needed, and
   * nothing changes if the swarm becomes recursive or collapses to a pipeline.
   */
  parentStepId: string | null;
  /** Monotonic within a run. Drives timeline ordering. */
  seq: number;
  /**
   * Which graph node produced this step, when the run came from a graph.
   * THE join key: it is what lets the canvas highlight a live node
   * (`steps.find(s => s.nodeId === node.id)?.status`) and what groups steps
   * into per-node metrics in `analytics.ts`. Undefined for a hand-written
   * playbook like `demo`, whose steps roll up as `unattributed`.
   *
   * A swarm's parent and all of its children share one nodeId, so a fan-out
   * reports as the single node the author drew.
   */
  nodeId?: string;
  /** 'fetch' | 'worker' | 'judge' | 'browse' | 'decide' | ... */
  kind: string;
  /** Human string shown in the timeline. */
  label: string;
  status: StepStatus;
  /** Which adapter did the work. Rendered as a badge. */
  providerId?: ProviderId;
  riskClass?: RiskClass;
  approvalId?: string;
  input?: Json;
  output?: Json;
  error?: { code: string; message: string };
  startedAt?: Iso;
  endedAt?: Iso;
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revised' | 'expired';

export interface Approval {
  id: string;
  runId: string;
  stepId: string;
  /** e.g. "Submit the fee-adjustment request to the Registrar?" */
  question: string;
  /** Exactly what will be sent if approved. Shown verbatim — no summarising. */
  proposedAction: Json;
  /**
   * What the human edited the payload into, when `status` is 'revised'. The
   * spec requires BOTH to survive: `proposedAction` is what the agent asked
   * for, this is what actually ran. Never overwrite one with the other.
   */
  revisedAction?: Json;
  reversibility: Reversibility;
  riskClass: RiskClass;
  /** Which rule demanded a human. */
  policyRule: string;
  /**
   * Set on a revision: the rule that fired when the REVISED action was put
   * back through the risk gate. A revision is never trusted because a human
   * typed it — it is reauthorized like any other action.
   */
  reauthorizedRule?: string;
  status: ApprovalStatus;
  decidedAt?: Iso;
  note?: string;
  createdAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Conversation                                                               */
/* -------------------------------------------------------------------------- */

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: Iso;
  /** Graph version produced by this turn, when it produced one. */
  graphVersion?: number;
}

/** A chat transcript that points at, but does not duplicate, its authored graph. */
export interface Conversation {
  id: string;
  title: string;
  graphId?: string;
  messages: ConversationMessage[];
  createdAt: Iso;
  updatedAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Egress ledger                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One outbound call. Records WHAT CLASS of data left and WHY it was allowed —
 * never the value. Works identically whether the payload was a tuition PDF or
 * an insurance claim.
 */
export interface EgressEvent {
  id: string;
  runId: string;
  stepId?: string;
  at: Iso;
  providerId: ProviderId | 'tavily';
  op: string;
  /** Host contacted, or `mock://<provider>`, or `hermes-internal://<tool>` for
   *  a call reported after the fact rather than made directly (see
   *  policyRule 'reported-post-hoc-by-hermes'). */
  destination: string;
  dataSpans: { placeholder: string; type: string }[];
  policyRule: string;
  decision: 'allowed' | 'redacted' | 'blocked';
  latencyMs?: number;
  /** Cost accounting, when the provider reported it. See ProviderMeta. */
  tokensIn?: number;
  tokensOut?: number;
  /**
   * Absent means UNPRICED (model with no known rate), not free. The rollup
   * counts those calls separately instead of summing them as zero.
   */
  estimatedCostCents?: number;
  /** The model that actually answered, as the provider reported it. */
  model?: string;
  /** Prompt-cache input tokens, already included in `tokensIn`. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/* -------------------------------------------------------------------------- */
/* PII                                                                        */
/* -------------------------------------------------------------------------- */

export interface PiiSpan {
  id: string;
  runId: string;
  type: PiiType;
  /** What a cloud model actually sees, e.g. "[[PII_3]]". */
  placeholder: string;
  /** Provenance: which document or field it came from. */
  field: string;
  routedTo: 'local' | 'cloud';
}

/**
 * Server-side only. The `value` never crosses the wire — `PiiSpan` is the client
 * shape, this one stays in the store.
 */
export interface PiiSpanWithValue extends PiiSpan {
  value: string;
}

export function stripPiiValue(span: PiiSpanWithValue): PiiSpan {
  const { value: _value, ...rest } = span;
  return rest;
}
