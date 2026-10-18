/**
 * The playbook contract — THE PIVOT SEAM.
 *
 * When the product idea is decided, everything product-specific lives in one file
 * implementing `Playbook`, plus its zod input schema in
 * packages/shared/src/schemas/playbooks/. Nothing above this layer changes.
 *
 * A playbook never touches the store, the bus, express, or a vendor SDK. It is
 * handed a `PlaybookContext` and uses only that.
 */

import type { ZodType } from 'zod';
import type {
  Capability,
  CapabilityMap,
  CompiledNodeDecision,
  CompletionDecision,
  DataLabel,
  IntelligenceLevel,
  Json,
  ModelTier,
  PrivacyRoute,
  ProposedAction,
  ProviderCallContext,
  ProviderId,
  ScheduleDecision,
  SessionCheckpoint,
  Step,
} from '@htn/shared';
import type { FanOutOutcome } from '../swarm.js';

export interface StepSpec {
  label: string;
  /** 'fetch' | 'worker' | 'judge' | 'browse' | 'decide' | ... Free-form; drives icons. */
  kind?: string;
  /**
   * The graph node this step belongs to, when the run came from a graph. Set by
   * the interpreter; a hand-written playbook leaves it undefined. See Step.nodeId.
   */
  nodeId?: string;
  parentStepId?: string | null;
  providerId?: ProviderId;
  input?: Json;
}

export interface FanOutSpec<I, O> {
  /** Label for the parent step that contains the swarm. */
  label: string;
  /** Applied to the parent AND every child, so a fan-out reports as one node. */
  nodeId?: string;
  items: I[];
  concurrency?: number;
  /** Label for each child step. Shown in the SwarmGrid. */
  workerLabel: (item: I, index: number) => string;
  worker: (item: I, index: number, step: Step) => Promise<O>;
}

export interface RedactionOutput {
  /** Safe to send to a cloud provider. */
  redacted: string;
  /** Pass into the ProviderCallContext so the ledger records what class of data left. */
  redactions: { placeholder: string; type: string }[];
  /** True when at least one sensitive span was found and pinned locally. */
  hadSensitive: boolean;
}

export interface AgentTaskSpec {
  toolCeiling?: string[];
  /** Hard resources bound by the graph, kept out of model-visible context. */
  resourceBindings?: { browserSession?: string };
  contextScope?: { id: string; mode: 'fresh' | 'continue' };
  contextProvenance?: string[];
  /** Step label shown in the timeline. */
  label: string;
  /** The goal handed to the agent runtime. */
  goal: string;
  /** Extra context passed through untouched — redact it first if it might be sensitive. */
  context?: unknown;
  /** Redacted objective eligible for a remote completion judgment. */
  sanitizedGoal?: string;
  /** Labels for the canonical task state. Defaults to public. */
  dataLabels?: DataLabel[];
  /**
   * Full candidate tool list BEFORE Jev filters it. Not tied to any one
   * provider's tool-name format — the harness-specific `live.ts` is
   * responsible for translating these into whatever that runtime expects.
   * Irreversible tools may be proposed, but every exact action is still gated
   * by AgentOS and requires approval before the executor is called.
   */
  availableTools: string[];
  /** The graph node this task belongs to. See Step.nodeId. */
  nodeId?: string;
  parentStepId?: string | null;
  /** How often to poll while the task runs. Default 400ms. */
  pollIntervalMs?: number;
  /** Give up and cancel after this many polls, so a stuck task can't hang the run. Default 20. */
  maxPolls?: number;
  /** Maximum Hermes turns in the AgentOS outer loop. Defaults to 3. */
  maxTurns?: number;
  /** Give up once the task has run this long overall, regardless of poll/turn budget. */
  maxDurationMs?: number;
  /** Give up once this many of the task's tool calls have failed. */
  maxFailedToolCalls?: number;
  /**
   * 'jev' (default): Jev picks the tools and each turn's model.
   * 'all_tools_frontier': the BASELINE arm only. Every registered tool that
   * passes eligibility is exposed and every turn runs on a frontier route —
   * the "frontier model, all tools" comparison point the design spec's
   * evaluation criterion names. Eligibility, data labels and per-action
   * approval still apply; only the Jev narrowing is skipped.
   */
  routing?: 'jev' | 'all_tools_frontier';
  /**
   * Graph agent nodes only. The node's frozen route (see core/graph/compile.ts)
   * and the identity it must match; the orchestrator reuses it only when the
   * resolved candidate set and decision mode still match, and otherwise asks
   * Jev and records the answer for `graphId`.
   */
  compiledRoute?: { graphId: string; nodeHash: string; entry?: CompiledNodeDecision };
}

export interface AgentTaskResult {
  dataLabels?: DataLabel[];
  result: unknown;
  /** The routing decision Jev made before this task started. */
  scheduleDecision: ScheduleDecision;
  /** Self-reported by the runtime; our only post-hoc visibility into its internal loop. */
  toolCalls: { tool: string; args?: unknown; at: string }[];
  completionDecision: CompletionDecision;
}

export interface PlaybookContext {
  readonly runId: string;
  readonly signal: AbortSignal;

  /** Append a log line to the run. */
  log(level: 'info' | 'warn' | 'error', message: string): Promise<void>;

  /**
   * Run one step. Handles the status transitions and events; you write the body.
   * Throwing inside `fn` marks the step failed and propagates.
   */
  step<T>(spec: StepSpec, fn: (step: Step) => Promise<T>): Promise<T>;

  /**
   * Fan out N workers as child steps of one parent step. This is the entire cost
   * of a swarm — the UI renders it from parentStepId with no extra work.
   */
  fanOut<I, O>(spec: FanOutSpec<I, O>): Promise<FanOutOutcome<O>[]>;

  /**
   * Classify an action and, if the policy demands a human, BLOCK until they decide.
   * Throws ApprovalRejectedError when rejected.
   *
   * Returns the action AS AUTHORIZED. That is the proposed action for an
   * ungated or plainly-approved call, and the human's edit when they revised
   * it. Execute the return value — executing the argument instead would
   * silently discard a revision, which is the one bug this signature exists to
   * make impossible.
   */
  requireApproval(stepId: string, action: ProposedAction): Promise<ProposedAction>;

  /** Get a provider by capability — never by vendor name. */
  provider<C extends Capability>(capability: C): CapabilityMap[C];
  /** Existing resources stay bound to the backend that created them. */
  browserForSession?(sessionId: string): import('@htn/shared').BrowserAdapter;

  /**
   * Which vendor is currently bound to a capability.
   *
   * For LABELLING ONLY — a step badge, a log line. Never branch on this: the
   * whole point of the capability indirection is that behaviour does not depend
   * on who is serving it. It exists because a hardcoded `providerId: 'jev'` on
   * a step becomes a lie the moment someone repoints BINDINGS, and a dashboard
   * that misreports which vendor ran is worse than one that says nothing.
   */
  providerFor(capability: Capability): ProviderId;

  /** Detect PII, pin it locally, and return cloud-safe text. */
  redact(text: string, field: string): Promise<RedactionOutput>;

  /**
   * Run one subtask on the harness bound to 'agent.runtime' (Hermes today,
   * but never mentioned by name here — that's what makes this harness
   * agnostic). Jev decides the model tier and filters `availableTools` down
   * BEFORE the task starts; this is where tool/model optimization actually
   * happens, at subtask granularity rather than per literal model turn,
   * because the runtime's own internal loop is opaque to us once running.
   * Blocks until the task reports done, fails, or maxPolls is exceeded.
   */
  runAgentTask(spec: AgentTaskSpec): Promise<AgentTaskResult>;

  /** Evaluate an explicit checkpoint through the same verified completion gate. */
  judgeCompletion(checkpoint: SessionCheckpoint, stepId?: string): Promise<CompletionDecision>;

  /**
   * Keep a graph-level Jev decision this run had to make (no usable frozen
   * entry existed), so the next run of the graph reuses it. Best effort.
   */
  recordCompiledDecision?(
    graphId: string,
    nodeId: string,
    entry: CompiledNodeDecision,
  ): Promise<void>;

  /**
   * Record a routing decision made OUTSIDE runAgentTask.
   *
   * runAgentTask records its own, but the `dispatch` node -- where the decision
   * layer picks ONE tool and the interpreter calls it directly, with no agent
   * harness in the middle -- needs the same visibility. Without this, the cheap
   * path would look like it did no routing at all and the
   * availableTools-vs-exposedTools number would only ever come from the
   * expensive path.
   */
  /**
   * Call a registered tool through the trusted broker.
   *
   * WHY A GRAPH NODE GETS A BROKER CALL AT ALL: the broker binds every call to
   * a deliberate SELECTION (see assertSelected). For a harness turn that is the
   * model's pick; for a graph node it is the author's, pinned in a reviewed
   * document -- a stronger claim, not a weaker one. So the orchestrator mints a
   * one-tool exposure grant from what the node names and executes against it.
   *
   * Returns null when no broker is wired, so a caller can fall back rather than
   * fail. THE BROKER GATES ITS OWN CALLS -- do not also call requireApproval
   * around this, or a person is asked twice for one action.
   */
  callBrokeredTool(input: {
    forceApproval?: boolean;
    dataLabels?: DataLabel[];
    stepId: string;
    toolId: string;
    args: Record<string, Json>;
  }): Promise<{ output: Json; summary: string; dataLabels?: DataLabel[] } | null>;

  /**
   * Which of these tool ids the registry can actually execute right now.
   *
   * A decision layer must never be offered a candidate that cannot run. Graph
   * authors write candidate lists by hand (and a generated graph writes them
   * from a model), so a list can easily name a tool that no provider
   * registers — `sheets.append` is the standing example. Without this, the
   * choice succeeds, the call fails deep inside the toolbox, and the error
   * blames Composio for a name it was never taught.
   *
   * OPTIONAL on purpose: a caller with no registry wired keeps the old
   * behaviour rather than losing the ability to dispatch at all.
   */
  registeredToolIds?(candidates: string[]): Promise<string[]>;

  /**
   * Announce a browser session the UI can offer a live view of.
   *
   * Same shape as `recordSchedule`: core declares what it needs, the
   * orchestrator supplies store + bus. A `handoff` node opens a session and
   * deliberately leaves it open, and the person being handed to has no way to
   * reach it unless the id and viewer URL are put on the run stream.
   *
   * NOTHING SENSITIVE may go through here -- it crosses SSE and is persisted
   * in the run's event log. A viewer URL and metadata, never page content.
   */
  announceBrowserSession(session: {
    sessionId: string;
    stepId?: string;
    nodeId?: string;
    providerId: ProviderId;
    liveViewUrl?: string;
    interactive: boolean;
    startUrl?: string;
  }): Promise<void>;

  /** Symmetric: the viewer is dead from here (Browserbase 410s the debug URL). */
  releaseBrowserSession(sessionId: string): Promise<void>;

  recordSchedule(input: {
    stepId: string;
    requestedCapability: Capability;
    selectedProvider: ProviderId;
    privacy?: PrivacyRoute;
    intelligence?: IntelligenceLevel;
    privacyConfidence?: number;
    intelligenceConfidence?: number;
    modelTier: ModelTier;
    availableTools: string[];
    exposedTools: string[];
    confidence: number;
    rule: string;
  }): Promise<ScheduleDecision>;

  /** Build the context every provider call requires. */
  callContext(args: {
    stepId?: string;
    policyRule: string;
    redactions?: { placeholder: string; type: string }[];
  }): ProviderCallContext;
}

export interface PlaybookOutcome {
  /** One line shown on the run card. */
  summary: string;
  /** Per-kind payload. The UI picks a renderer by run.kind. */
  result?: Json;
}

export interface Playbook<I = unknown> {
  kind: string;
  title: string;
  inputSchema: ZodType<I>;
  /**
   * Can the generic "pick a playbook and go" form launch this with NO input?
   *
   * Defaults to true. `graph` sets it false: it needs a graphId, so offering it
   * in a dropdown that posts `{}` produces a guaranteed validation error. If
   * you add a playbook with required input, set this, or the launch form will
   * advertise a button that cannot work.
   */
  directLaunch?: boolean;
  execute(ctx: PlaybookContext, input: I): Promise<PlaybookOutcome>;
}

/** Helper so a playbook file can be written without repeating the generic. */
export function definePlaybook<I>(playbook: Playbook<I>): Playbook<I> {
  return playbook;
}
