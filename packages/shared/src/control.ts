/**
 * Harness-agnostic control-plane contracts.
 *
 * Jev only recommends choices from caller-supplied candidates. AgentOS owns
 * eligibility, authorization, verification, and the final lifecycle decision.
 */

import type { Iso, Json, StepStatus } from './domain.js';
import type { Reversibility } from './policy.js';

export type DataLabel = 'public' | 'private' | 'secret' | 'local_only';
export type ContextScope = 'public' | 'private' | 'local_only';
export type ModelCostTier = 'cheap' | 'standard' | 'frontier';
export type ModelDeployment = 'local' | 'cloud';

/** One policy-reviewed route Jev may choose. IDs are stable and server-owned. */
export interface ModelRoute {
  id: string;
  providerId: string;
  modelId: string;
  costTier: ModelCostTier;
  deployment: ModelDeployment;
  contextScope: ContextScope;
  supportsTools: boolean;
  allowedDataLabels: DataLabel[];
  enabled: boolean;
  maxContextTokens?: number;
  zeroDataRetention?: boolean;
  noTraining?: boolean;
}

export type ToolEffect = 'read' | 'write' | 'destructive' | 'unknown';
export type ToolTransport = 'mcp' | 'local' | 'harness' | 'http' | 'fixture';
export type ToolInteractionMode = 'research' | 'interactive' | 'resource_management';

/** Short metadata sent to Jev; schemas, credentials, and executors remain local. */
export interface ToolDescriptor {
  id: string;
  version: string;
  providerId: string;
  family: string;
  /** Trusted distinction between stateless evidence gathering and page-bound actions. */
  interactionMode?: ToolInteractionMode;
  description: string;
  inputSchemaRef: string;
  transport: ToolTransport;
  baselineEffect: ToolEffect;
  reversibility: Reversibility;
  requiredScopes: string[];
  allowedDataLabels: DataLabel[];
  availability: 'available' | 'unavailable' | 'requires_connection';
  executorRef: string;
  credentialRef?: string;
  /** Trusted connected-account identity for review; never an API key/vault reference. */
  accountRef?: string;
  simulated?: boolean;
  /** Reviewed connected-app mutations must expose an exact change approval. */
  requiresChangeReview?: boolean;
  /** Effective backend mode, distinct from non-executable fixture simulation. */
  executionMode?: 'live' | 'mock';
}

/** The exact action that must pass authorization immediately before execution. */
export interface ToolAction {
  id: string;
  runId: string;
  stepId: string;
  toolId: string;
  descriptorVersion: string;
  operation: string;
  arguments: Json;
  destination?: string;
  dataLabels: DataLabel[];
  createdAt: Iso;
  /** Hash of exact proposed arguments/destination; never a permission grant. */
  previewFingerprint?: string;
  /** Bound by the broker from trusted descriptor metadata, not model arguments. */
  accountRef?: string;
  /** Server-prepared operation/target bound to the exact human review. */
  review?: Json;
}

export type ActionPolicy = 'auto' | 'verify' | 'ask_user' | 'deny';

/** Jev's semantic recommendation. It never grants execution permission. */
export interface ActionPolicyRecommendation {
  policy: ActionPolicy;
  confidence: number;
  probabilities: Partial<Record<ActionPolicy, number>>;
  reasonCodes: string[];
}

/** AgentOS's final policy after deterministic rules and the Jev recommendation. */
export interface AuthorizationDecision {
  actionId: string;
  recommendation: ActionPolicyRecommendation;
  finalPolicy: ActionPolicy;
  allowed: boolean;
  reasonCodes: string[];
  at: Iso;
}

/** Only this explicitly sanitized shape is eligible for a remote Jev call. */
export interface DecisionState {
  taskSummary: string;
  contextSummary?: string;
  dataLabels: DataLabel[];
  sanitizedForRemote: boolean;
}

export interface ModelSelectionDecision {
  selectedRouteId: string;
  confidence: number;
  probabilities: Record<string, number>;
  reasonCodes: string[];
}

export interface ToolFamilySelectionDecision {
  selectedFamilies: string[];
  confidences: Record<string, number>;
  reasonCodes: string[];
}

export interface ToolSelectionDecision {
  selectedToolIds: string[];
  confidences: Record<string, number>;
  reasonCodes: string[];
}

export interface SessionStepSummary {
  id: string;
  label: string;
  status: StepStatus;
  required: boolean;
  /** Local canonical summary. Never copied into remote state implicitly. */
  summary?: string;
  /** Deliberately prepared, redacted summary that may be sent remotely. */
  sanitizedSummary?: string;
}

export interface SessionArtifactSummary {
  id: string;
  kind: string;
  required: boolean;
  verified: boolean;
  dataLabels: DataLabel[];
  summary?: string;
  sanitizedSummary?: string;
}

export interface VerificationSummary {
  id: string;
  passed: boolean;
  required: boolean;
  reasonCode: string;
}

export interface SessionBudget {
  stepsRemaining: number;
  timeRemainingMs?: number;
  tokensRemaining?: number;
  costRemainingCents?: number;
}

export type AgentSessionStatus =
  | 'created'
  | 'running'
  | 'quiescent'
  | 'awaiting_approval'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

/**
 * Compact context memory owned by AgentOS. Full prompts and tool payloads are
 * deliberately not duplicated here: this is the durable control-plane view,
 * safe to inspect and use when changing harnesses or model routes.
 */
export interface SessionContextEntry {
  id: string;
  /** Source node/input paths, not raw values. */
  provenance?: string[];
  role: 'system' | 'user' | 'assistant' | 'tool';
  summary: string;
  sanitizedSummary?: string;
  dataLabels: DataLabel[];
  tokenEstimate?: number;
  at: Iso;
}

/**
 * Security authority for tool calls proposed from one tool-bearing model request.
 * UI-facing selectedToolIds are only a summary; the broker validates this grant.
 */
export interface ToolExposureGrant {
  id: string;
  sessionStateId: string;
  turn: number;
  modelCallId: string;
  selectedToolVersions: Record<string, string>;
  createdAt: Iso;
}

/**
 * Canonical state for one harness task. AgentOS, not Hermes or Jev, owns this
 * record so routing, completion, and UI observability share one source of truth.
 */
export interface AgentSessionState {
  id: string;
  runId: string;
  stepId: string;
  harness: string;
  harnessSessionId?: string;
  /** Run-scoped graph transcript identity, independent of browser resources. */
  contextScopeId?: string;
  /** Optional hard tool ceiling; an explicit empty array permits no tools. */
  toolCeiling?: string[];
  objective: string;
  sanitizedObjective?: string;
  dataLabels: DataLabel[];
  status: AgentSessionStatus;
  turn: number;
  contextVersion: number;
  context: SessionContextEntry[];
  candidateModelRouteIds: string[];
  selectedModelRouteId?: string;
  candidateToolIds: string[];
  /** Immutable Jev-selected task grant. A model turn may narrow this set, never widen it. */
  taskToolIds?: string[];
  /**
   * Set only by the all-tools BASELINE arm: every turn uses a route of this
   * cost tier instead of a Jev model choice, so the comparison measures the
   * graph against "frontier model, every tool" as the design spec asks.
   */
  pinnedCostTier?: ModelCostTier;
  /**
   * A graph's frozen route tier for this task. Unlike the pin it is only a
   * preference among ELIGIBLE routes: with none of that tier eligible, Jev
   * picks as usual.
   */
  preferredModelTier?: import('./providers.js').ModelTier;
  /** Server-side resource binding; never included in model context by default. */
  boundBrowserSessionId?: string;
  selectedToolIds: string[];
  /** Descriptor versions exposed on the latest model request, pinned against TOCTOU changes. */
  selectedToolVersions?: Record<string, string>;
  /** Active only for the current turn and replaced only by a tool-bearing model request. */
  activeToolExposureGrant?: ToolExposureGrant;
  budget: SessionBudget;
  latestCheckpoint?: SessionCheckpoint;
  createdAt: Iso;
  updatedAt: Iso;
}

/** Canonical state AgentOS evaluates after a quiescent harness turn. */
export interface SessionCheckpoint {
  runId: string;
  objective: string;
  sanitizedObjective?: string;
  steps: SessionStepSummary[];
  artifacts: SessionArtifactSummary[];
  verifications: VerificationSummary[];
  outstandingRequirements: string[];
  pendingApprovalIds: string[];
  dataLabels: DataLabel[];
  budget: SessionBudget;
  at: Iso;
}

export type CompletionStatus = 'done' | 'continue' | 'blocked';

/** Raw Jev judgment. AgentOS must verify it before ending a run. */
export interface CompletionJudgment {
  status: CompletionStatus;
  confidence: number;
  probabilities: Partial<Record<CompletionStatus, number>>;
  reasonCodes: string[];
  suggestedNextStepId?: string;
}

/** Final outer-loop decision after deterministic completion verification. */
export interface CompletionDecision extends CompletionJudgment {
  verified: boolean;
  verificationFailures: string[];
}

export type ControlDecisionOperation =
  | 'select_model'
  | 'select_tool_families'
  | 'select_tools'
  | 'recommend_action_policy'
  /** Outbound-text authenticity check. Advisory and escalate-only. */
  | 'check_outbound_text'
  | 'judge_completion';

/** Persisted, UI-safe trace of one bounded control-plane decision. */
export interface ControlDecisionRecord {
  id: string;
  runId: string;
  stepId?: string;
  operation: ControlDecisionOperation;
  candidateIds: string[];
  selectedIds: string[];
  confidence: number;
  reasonCodes: string[];
  source: 'jev' | 'deterministic' | 'fallback';
  at: Iso;
}

export type ModelLifecyclePhase = 'requested' | 'completed' | 'failed';

/** One model invocation, correlated across selection, provider egress, and output. */
export interface ModelLifecycleEvent {
  id: string;
  modelCallId: string;
  runId: string;
  stepId?: string;
  sessionStateId: string;
  phase: ModelLifecyclePhase;
  routeId: string;
  providerId: string;
  configuredModelId: string;
  actualModelId?: string;
  selectedToolIds: string[];
  dataLabels: DataLabel[];
  messageCount: number;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostCents?: number;
  toolCallCount?: number;
  /**
   * Readable, truncated copy of what went into / came out of the model, for the
   * run's debug log. Present only when every data label on the session is `public`;
   * otherwise `ioWithheld` is set and nothing is carried.
   */
  inputPreview?: string;
  outputPreview?: string;
  ioWithheld?: boolean;
  error?: { code: string; message: string };
  at: Iso;
}

export interface HarnessTurnEvent {
  id: string;
  runId: string;
  sessionId: string;
  turnId: string;
  phase: 'started' | 'model_requested' | 'tool_proposed' | 'quiescent' | 'cancelled' | 'failed';
  payload?: Json;
  at: Iso;
}

export type ToolLifecyclePhase =
  | 'proposed'
  | 'policy_decided'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'blocked'
  | 'failed';

/** UI-safe trace of one exact tool action as it crosses the AgentOS broker. */
export interface ToolLifecycleEvent {
  id: string;
  runId: string;
  stepId: string;
  sessionStateId: string;
  phase: ToolLifecyclePhase;
  action: ToolAction;
  authorization?: AuthorizationDecision;
  approvalId?: string;
  /** Tool output is untrusted; only a compact local summary enters the event stream. */
  outputSummary?: string;
  evidence?: import('./actionEvidence.js').ActionEvidence;
  /** A remote write error after dispatch may have committed; never retry it blindly. */
  outcome?: 'completed' | 'not_executed' | 'partial' | 'unknown';
  error?: { code: string; message: string };
  at: Iso;
}
