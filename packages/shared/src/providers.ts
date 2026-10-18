/**
 * The provider adapter contract.
 *
 * IMPORTANT: every type in this file is OUR internal vocabulary, not any vendor's.
 * Vendor SDK types must never escape a provider's `live.ts`. That is what lets us
 * swap providers, and what lets Hermes/Jev stay unimplemented without blocking anyone.
 */

import type { BrowserOperation, BrowserPerformResult, ElementTable } from './browser.js';

export type ProviderId =
  | 'hermes' // agent runtime (Nous Research)
  | 'jev' // fast / cheap decision layer
  | 'browserbase' // cloud browser automation
  | 'browserless' // supervised cloud CDP browser
  | 'localbrowser' // local browser automation for private/local-only work
  | 'composio' // SaaS tools + OAuth brokering
  | 'ollama' // local/private model runtime
  | 'mcp' // user-configured upstream MCP connections
  | 'anthropic' // frontier text model
  | 'gemini' // direct Google cloud model route (second cloud vendor)
  | 'gptzero'; // outbound-text authenticity check

export const PROVIDER_IDS = [
  'hermes',
  'jev',
  'browserbase',
  'browserless',
  'localbrowser',
  'composio',
  'ollama',
  'mcp',
  'anthropic',
  'gemini',
  'gptzero',
] as const satisfies readonly ProviderId[];

export type ProviderMode = 'mock' | 'live' | 'disabled';

/**
 * Cost/capability tier for a text-model or agent-runtime call. Advisory only
 * until Milestone 3's model gateway actually switches providers per tier —
 * for now it is recorded on every ScheduleDecision so the UI and benchmark
 * script have something real to show before it is functionally enforced.
 */
export type ModelTier = 'local' | 'cheap' | 'standard' | 'frontier';
export type PrivacyRoute = 'private' | 'cloud';
export type IntelligenceLevel = 'low' | 'high';

/**
 * What a provider can do, in our terms. Playbooks ask for a CAPABILITY, never a
 * vendor — so re-pointing 'decision' from jev to anthropic is a one-line change.
 */
export type Capability =
  | 'agent.runtime'
  | 'decision'
  | 'browser'
  | 'browser.local'
  | 'toolbox'
  | 'text.model'
  | 'content.analysis';

/** Passed to every provider call. Feeds the egress ledger. */
export interface ProviderCallContext {
  runId: string;
  stepId?: string;
  /**
   * Placeholders present in the outgoing payload. Records WHAT CLASS of data left,
   * never the value itself.
   */
  redactions?: { placeholder: string; type: string }[];
  /** Which policy rule permitted this call. Required — there is no anonymous egress. */
  policyRule: string;
  signal?: AbortSignal;
  /** Trusted server-side attribution; never taken from model/tool arguments. */
  sessionStateId?: string;
  /** Process-local gateway credentials. Never persist or include in prompts/events. */
  gatewayCredentials?: { model: string; mcp: string; profileId: string };
}

export interface ProviderMeta {
  provider: ProviderId;
  op: string;
  mode: ProviderMode;
  latencyMs: number;
  /** Host actually contacted. `mock://<id>` when mocked. */
  destination: string | null;
  /**
   * Optional cost accounting. Reuses this existing meta -> egress ledger
   * pipeline rather than a second channel — a provider that knows its token
   * usage (or a rough cost estimate) just fills these in, and withEgress
   * forwards them onto the stored EgressEvent automatically.
   */
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostCents?: number;
  /** The model that actually answered; see EgressEvent.model. */
  model?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ProviderErrorCode =
  'NOT_IMPLEMENTED' | 'DISABLED' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'UPSTREAM' | 'BAD_INPUT';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
}

export type ProviderResult<T> =
  | { ok: true; data: T; meta: ProviderMeta }
  | { ok: false; error: ProviderError; meta: ProviderMeta };

/** Every provider implements exactly this. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly capabilities: readonly Capability[];
  health(): Promise<ProviderResult<{ detail?: string }>>;
  /** Escape hatch for ops not yet promoted to a typed capability method. */
  invoke<TIn = unknown, TOut = unknown>(
    op: string,
    input: TIn,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<TOut>>;
}

/* -------------------------------------------------------------------------- */
/* Capability interfaces — our vocabulary, deliberately narrow.               */
/* -------------------------------------------------------------------------- */

export interface AgentRuntimeAdapter extends ProviderAdapter {
  startTask(
    input: { goal: string; context?: unknown; tools?: string[] },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ taskId: string }>>;
  pollTask(
    taskId: string,
    ctx: ProviderCallContext,
  ): Promise<
    ProviderResult<{
      status: 'running' | 'done' | 'failed';
      partial?: unknown;
      result?: unknown;
      log?: string[];
      /**
       * Self-reported: what the runtime actually invoked internally while it
       * ran its own loop. This is our ONLY post-hoc visibility into that loop —
       * we cannot gate these individually in real time, only audit them after
       * the fact. If the real runtime cannot report this, the field stays
       * empty and that blind spot should be called out, not hidden.
       */
      toolCalls?: { tool: string; args?: unknown; at: string }[];
    }>
  >;
  /** Continue the same harness session after AgentOS decides more work is required. */
  continueTask(
    taskId: string,
    input: { instruction: string; context?: unknown },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<null>>;
  cancelTask(taskId: string, ctx: ProviderCallContext): Promise<ProviderResult<null>>;
}

export interface DecisionAdapter extends ProviderAdapter {
  /** Cheap, fast classify-or-route call. Deliberately tiny. */
  decide(
    input: { question: string; options: string[]; evidence?: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ choice: string; confidence: number; rationale?: string }>>;

  /** Choose exactly one policy-eligible model route supplied by AgentOS. */
  selectModel(
    input: {
      state: import('./control.js').DecisionState;
      candidates: import('./control.js').ModelRoute[];
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<import('./control.js').ModelSelectionDecision>>;

  /** Select zero or more useful tool families from the supplied family IDs. */
  selectToolFamilies(
    input: {
      state: import('./control.js').DecisionState;
      candidateFamilies: string[];
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<import('./control.js').ToolFamilySelectionDecision>>;

  /** Select zero or more tools from policy-eligible descriptor metadata. */
  selectTools(
    input: {
      state: import('./control.js').DecisionState;
      candidates: import('./control.js').ToolDescriptor[];
      maxTools?: number;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<import('./control.js').ToolSelectionDecision>>;

  /** Recommend semantic action policy; deterministic AgentOS policy remains final. */
  recommendActionPolicy(
    input: {
      action: import('./control.js').ToolAction;
      descriptor: import('./control.js').ToolDescriptor;
      state: import('./control.js').DecisionState;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<import('./control.js').ActionPolicyRecommendation>>;

  /** Judge a sanitized checkpoint as done, continue, or blocked. */
  judgeCompletion(
    input: {
      checkpoint: import('./control.js').SessionCheckpoint;
      sanitizedState: import('./control.js').DecisionState;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<import('./control.js').CompletionJudgment>>;

  /**
   * Route a subtask BEFORE it starts: pick a model tier and filter the
   * candidate tool list down to what the agent runtime is allowed to see.
   * This is the actual mechanism behind "expose only Jev-selected tools" —
   * filtering happens here, at subtask granularity, not by intercepting the
   * runtime's internal per-turn loop (which we have no visibility into).
   */
  route(
    input: { task: string; availableTools: string[]; context?: string },
    ctx: ProviderCallContext,
  ): Promise<
    ProviderResult<{
      privacy: PrivacyRoute;
      intelligence: IntelligenceLevel;
      privacyConfidence: number;
      intelligenceConfidence: number;
      modelTier: ModelTier;
      exposedTools: string[];
      confidence: number;
      rationale?: string;
    }>
  >;
}

export interface BrowserAdapter extends ProviderAdapter {
  /** Freeze human control and verify/revoke it before an approval is committed. */
  prepareResume?(input: { sessionId: string; expectedUrl?: string }, ctx: ProviderCallContext): Promise<void>;
  ownershipStatus?(
    sessionId: string,
    ctx: ProviderCallContext,
  ): Promise<import('./browser.js').BrowserControlState>;
  viewer?(
    input: { sessionId: string; mode: 'watch' | 'control' },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<import('./browser.js').BrowserViewer>>;
  captureFrame?(
    sessionId: string,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ bytes: Uint8Array; width: number; height: number }>>;
  humanInput?(
    input: {
      sessionId: string;
      input: import('./browser.js').BrowserHumanInput;
      expectedRevision?: number;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<null>>;
  revokeControl?(sessionId: string, ctx: ProviderCallContext): Promise<ProviderResult<null>>;
  invalidateSnapshot?(sessionId: string, ctx: ProviderCallContext): Promise<ProviderResult<null>>;
  /** Change who may control a run-owned session. Human ownership blocks agent I/O. */
  setOwnership?(
    input: { sessionId: string; owner: 'agent' | 'human'; expectedRevision?: number },
    ctx: ProviderCallContext,
  ): Promise<void>;
  /** Close all browser sessions still owned by a run. */
  releaseRun?(runId: string, ctx: ProviderCallContext): Promise<void>;
  openSession(
    input: { startUrl?: string },
    ctx: ProviderCallContext,
  ): Promise<
    ProviderResult<{
      sessionId: string;
      liveViewUrl?: string;
      /**
       * True ONLY when a human can type into `liveViewUrl`. A `handoff` node
       * refuses to run without it, so it must be a promise the adapter can
       * actually keep — never inferred from the URL merely existing. An
       * adapter that serves a recording, a screenshot strip or a read-only
       * stream leaves this false.
       */
      interactive?: boolean;
    }>
  >;
  act(
    input: { sessionId: string; instruction: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ url: string; screenshotUrl?: string }>>;
  extract<T = unknown>(
    input: { sessionId: string; instruction: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<T>>;
  closeSession(sessionId: string, ctx: ProviderCallContext): Promise<ProviderResult<null>>;
  /**
   * Point an open session's page at a new URL. Optional: lets stateless
   * research reuse one session instead of opening (and paying for) one per
   * call. Callers without it fall back to a session per call.
   */
  navigate?(
    input: { sessionId: string; url: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ url: string }>>;

  /**
   * Mint a CURRENT viewer URL for a running session.
   *
   * MUST BE CALLED WHEN THE VIEWER IS WANTED, not when the session opens.
   * Browserbase signs its debug URL with a short-lived token: the URL captured
   * at open time is dead minutes later, and the symptom is a blank page that
   * accepts no input -- which is exactly what a `handoff` hands a person, since
   * they click the link long after the session opened.
   *
   * Optional: an adapter with no viewable session (local, mocked) omits it, and
   * callers must treat a missing URL as a normal state rather than an error.
   */
  liveView?(
    sessionId: string,
    ctx: ProviderCallContext,
  ): Promise<
    ProviderResult<{
      liveViewUrl?: string;
      /**
       * The URL of the page the viewer is pointed at. 'about:blank' is a real,
       * common answer -- a session opened with no start URL has nothing else --
       * and callers should SAY SO rather than hand over a blank viewer.
       */
      pageUrl?: string;
      interactive: boolean;
    }>
  >;

  /** Optional element-table path used by the Jev browser controller. */
  snapshot?(
    input: { sessionId: string; maxElements?: number },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<ElementTable>>;
  perform?(
    input: {
      sessionId: string;
      snapshotId: string;
      operation: BrowserOperation;
      index?: number;
      text?: string;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<BrowserPerformResult>>;
}

export interface ToolboxToolDefinition {
  /** Provider-native immutable tool identifier (for example GMAIL_SEND_EMAIL). */
  name: string;
  description: string;
  version?: string;
  toolkit?: string;
  inputSchema?: import('./domain.js').Json;
  requiredScopes?: string[];
  connectedAccountId?: string;
}

export interface ToolboxAdapter extends ProviderAdapter {
  /** Resolve explicitly configured provider-native tools. */
  listTools(ctx: ProviderCallContext): Promise<ProviderResult<ToolboxToolDefinition[]>>;
  /** Search the provider catalog for a task before the harness starts. */
  searchTools(
    input: { query: string; toolkits?: string[]; limit?: number },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<ToolboxToolDefinition[]>>;
  connectUrl(app: string, ctx: ProviderCallContext): Promise<ProviderResult<{ url: string }>>;
  callTool(
    input: {
      name: string;
      args: Record<string, unknown>;
      version?: string;
      userId?: string;
      connectedAccountId?: string;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<unknown>>;
}

export interface TextModelAdapter extends ProviderAdapter {
  complete(
    input: {
      system?: string;
      prompt: string;
      maxTokens?: number;
      json?: boolean;
      /** Jev's model-tier recommendation. Defaults to 'standard' if omitted. */
      tier?: ModelTier;
      /** 0-1. Omit to use the provider's own default. */
      temperature?: number;
    },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ text: string; tokensIn: number; tokensOut: number }>>;
}

/** Outbound-text authenticity scoring. `score` is normalised to P(ai) in 0..1. */
export interface ContentAnalysisAdapter extends ProviderAdapter {
  analyze(
    input: { text: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ score: number; label: string }>>;
}

/** Maps a capability to the adapter interface that serves it. */
export interface CapabilityMap {
  'agent.runtime': AgentRuntimeAdapter;
  decision: DecisionAdapter;
  browser: BrowserAdapter;
  'browser.local': BrowserAdapter;
  toolbox: ToolboxAdapter;
  'text.model': TextModelAdapter;
  'content.analysis': ContentAnalysisAdapter;
}

/** Shape returned by GET /api/providers. */
export interface ProviderStatus {
  id: ProviderId;
  mode: ProviderMode;
  capabilities: readonly Capability[];
  healthy: boolean;
  detail?: string;
}
