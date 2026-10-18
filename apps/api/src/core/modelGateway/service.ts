import type {
  AgentSessionState,
  ControlDecisionOperation,
  DataLabel,
  DecisionState,
  ModelRoute,
  ModelTier,
  ProviderCallContext,
  TextModelAdapter,
  ToolDescriptor,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { RunBus } from '../bus.js';
import { NoEligibleModelRouteError, type DecisionService } from '../decisions/service.js';
import { eligibleModelRoutes } from '../decisions/eligibility.js';
import { decisionStateFromSession } from '../sessions/decisionState.js';
import type { GatewayTurnBinding, SessionStateService } from '../sessions/service.js';
import { KeyedLock } from '../locks.js';
import { waitWhilePaused } from '../pauseGate.js';
import type { RegisteredTool } from '../tools/registry.js';
import { modelRoutesFor } from './catalog.js';
import type { ToolDescriptorCatalog } from './toolCatalog.js';

export interface OpenAiMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface OpenAiTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

export interface OpenAiChatRequest {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: OpenAiTool[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

export interface GatewayCompletion {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls: GatewayToolCall[];
  tokensIn: number;
  tokensOut: number;
  runId: string;
  sessionStateId: string;
  selectedToolIds: string[];
}

export interface GatewayToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatModelBackendInput {
  route: ModelRoute;
  messages: OpenAiMessage[];
  tools: OpenAiTool[];
  /**
   * 'none' keeps the tool definitions -- the transcript already holds calls
   * to them -- but forbids a new call. Backends with no native switch drop
   * the tools instead. Defaults to 'auto'.
   */
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
}

export interface ChatModelBackendResult {
  text: string;
  toolCalls?: GatewayToolCall[];
  tokensIn: number;
  tokensOut: number;
  actualModel?: string;
  estimatedCostCents?: number;
}

/** Provider-specific tool-capable backends implement this seam. */
export interface ChatModelBackend {
  complete(input: ChatModelBackendInput, ctx: ProviderCallContext): Promise<ChatModelBackendResult>;
}

export interface ModelGatewayOptions {
  modelRoutes?: (adapter: TextModelAdapter) => ModelRoute[];
  backend?: ChatModelBackend;
  /** Tool calls the model may make in one harness turn before it must report. */
  maxToolCallsPerTurn?: number;
  /** Trusted credential eligibility, checked before routing; never supplied by Hermes. */
  routeAvailable?: (route: ModelRoute, ctx: ProviderCallContext) => boolean;
}

const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * Hermes's ACP adapter builds every agent with an unlimited per-prompt
 * iteration budget and ignores `agent.max_turns`, so one turn could chain
 * tool calls until the wall-clock budget ran out (35 calls in a single
 * 7-minute turn, observed live). The orchestrator's completion judge only runs
 * BETWEEN turns, so it never got a say. Once a turn spends its budget, the
 * next model call gets no tools and this instruction, the model answers in
 * text, Hermes ends the turn, and the judge decides whether to continue.
 *
 * It asks for a final answer, not a progress report: "list what is still
 * missing" turned every capped turn into a to-do list the judge then
 * (reasonably) sent back for another full turn.
 */
const TOOL_BUDGET_EXHAUSTED_INSTRUCTION =
  'Tool budget for this turn is used up; tools are unavailable. Do not call tools. ' +
  'Give your final answer now from what you have found: the concrete results and their ' +
  'sources. If a requested item could not be found, say so in one sentence.';

/**
 * Model calls a turn may make beyond one per allowed tool call: the final
 * answer plus a few Hermes retries/nudges. Past that the turn is looping --
 * typically empty replies that Hermes answers with "continue" -- and the
 * gateway ends it itself rather than paying for another model and Jev call.
 */
const MODEL_CALL_HEADROOM = 4;
/** Bound on remembered per-task model picks; the oldest is forgotten first. */
const MAX_TASK_MODEL_CHOICES = 2000;

const TURN_LIMIT_REPLY =
  '[AgentOS] Stopped this agent run: it reached its limit of model calls without ' +
  'giving a final answer.';

export class ModelGatewayService {
  private readonly calls = new KeyedLock();
  private readonly routes: ModelRoute[];
  private readonly backend: ChatModelBackend;
  private readonly maxToolCallsPerTurn: number;
  private readonly routeAvailable: NonNullable<ModelGatewayOptions['routeAvailable']>;
  /** Tool calls made per `${sessionStateId}:${turn}`. In memory: a turn never outlives the process. */
  private readonly turnToolCalls = new Map<string, number>();
  /** Model calls made per `${sessionStateId}:${turn}`, for the same reason. */
  private readonly turnModelCalls = new Map<string, number>();
  /**
   * Jev's model pick per agent task, keyed by `${sessionStateId}|labels|eligible
   * route ids`. One task asks once instead of once per turn; a label change or a
   * different eligible set (credentials, tool support) is a new key, so it asks
   * again. In memory: a restart simply asks again.
   */
  private readonly taskModelChoices = new Map<string, string>();

  constructor(
    private readonly decisionService: DecisionService,
    private readonly sessions: SessionStateService,
    private readonly model: TextModelAdapter,
    private readonly tools: ToolDescriptorCatalog,
    private readonly bus: RunBus,
    options: ModelGatewayOptions = {},
  ) {
    this.routes = (options.modelRoutes ?? modelRoutesFor)(model);
    this.backend = options.backend ?? textAdapterBackend(model);
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    this.routeAvailable = options.routeAvailable ?? (() => true);
  }

  listModels(): ModelRoute[] {
    return this.routes.filter((route) => route.enabled);
  }

  async complete(
    request: OpenAiChatRequest,
    binding: GatewayTurnBinding,
  ): Promise<GatewayCompletion> {
    const release = await this.calls.acquire(binding.sessionStateId);
    try {
      return await this.completeBound(request, binding);
    } finally {
      release();
    }
  }

  private async completeBound(
    request: OpenAiChatRequest,
    binding: GatewayTurnBinding,
  ): Promise<GatewayCompletion> {
    const initialSession = await this.sessions.requireGatewayTurn(binding);
    await waitWhilePaused(initialSession.runId);
    await this.sessions.requireGatewayTurn(binding);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (messages.length === 0) throw new Error('messages must contain at least one item');

    await this.sessions.appendContext(
      initialSession.id,
      messages.map((message) => summarizeMessage(message, initialSession)),
    );
    const session = await this.sessions.get(initialSession.id);
    if (!session) throw new Error('Active AgentOS session disappeared during model routing.');

    const turnKey = binding.sessionStateId + ':' + binding.turn.toString();
    const modelCalls = (this.turnModelCalls.get(turnKey) ?? 0) + 1;
    this.turnModelCalls.set(turnKey, modelCalls);
    const modelCallLimit = this.maxToolCallsPerTurn + MODEL_CALL_HEADROOM;
    if (modelCalls > modelCallLimit) {
      return this.finalReply(
        session,
        TURN_LIMIT_REPLY,
        // Said once, the first time; Hermes may still call again.
        modelCalls === modelCallLimit + 1
          ? 'The agent made ' +
              modelCallLimit.toString() +
              ' model calls in one run without finishing; AgentOS ended the run instead of ' +
              'calling the model again.'
          : undefined,
      );
    }

    const decisionState = decisionStateFromSession(session);
    const callContext: ProviderCallContext = {
      runId: session.runId,
      stepId: session.stepId,
      policyRule: 'agentos-model-gateway',
    };

    const requestedToolNames = extractToolNames(request.tools ?? []);
    const taskGrant = session.taskToolIds ?? session.candidateToolIds;
    const requestTools = await this.resolveRequestedTools(
      request.tools ?? [],
      taskGrant.filter(
        (id) => session.toolCeiling === undefined || session.toolCeiling.includes(id),
      ),
    );
    const trustedDescriptors = requestTools
      .map((tool) => tool.registered.descriptor)
      .filter((descriptor) =>
        session.boundBrowserSessionId ? !isSeparateBrowserOperation(descriptor.id) : true,
      );
    if (
      session.candidateToolIds.length > 0 &&
      requestedToolNames.length > 0 &&
      trustedDescriptors.length === 0
    ) {
      // Names and stable IDs are safe operational metadata; never log schemas
      // or arguments here because those can contain user/private task data.
      console.warn(
        '[model-gateway] no trusted schema resolved; candidates=' +
          JSON.stringify(session.candidateToolIds) +
          ' requestNames=' +
          JSON.stringify(requestedToolNames),
      );
    }
    // The task-level Jev grant is already the hard capability decision passed
    // into Hermes. Re-running family/tool Jev on every gateway turn adds
    // latency and can only narrow a set that is already bounded. Preserve the
    // legacy per-turn selector for sessions created before taskToolIds existed.
    const selectedTools =
      session.taskToolIds !== undefined
        ? trustedDescriptors
        : await this.selectTools(
            decisionState,
            trustedDescriptors,
            callContext,
            session.runId,
            session.stepId,
          );
    const selectedIds = new Set(selectedTools.map((descriptor) => descriptor.id));
    const selectedRequestTools = requestTools.filter((tool) =>
      selectedIds.has(tool.registered.descriptor.id),
    );
    // Privacy eligibility applies before ANY selection, including the baseline
    // pin below, so no route choice can reach a model barred from the data.
    const credentialedRoutes = this.routes.filter(
      (route) =>
        route.enabled &&
        this.routeAvailable(route, callContext) &&
        (selectedTools.length === 0 || route.supportsTools),
    );
    const modelCandidates = eligibleModelRoutes(decisionState, credentialedRoutes);
    if (modelCandidates.length === 0 && credentialedRoutes.length > 0) {
      return this.finalReply(
        session,
        '[AgentOS] Stopped this agent run: its data is now labelled ' +
          session.dataLabels.join(', ') +
          ', and no available model is allowed to see that. Only a local model may continue ' +
          'a task like this; turn on Ollama to run it locally.',
      );
    }
    if (modelCandidates.length === 0) {
      return this.finalReply(
        session,
        '[AgentOS] Stopped this agent run: no model with eligible credentials is available. ' +
          'Configure model credentials in Connections or enable local Ollama.',
      );
    }
    // The all-tools baseline arm pins a cost tier so it measures "frontier
    // model" rather than whatever Jev would pick. With no eligible route of
    // that tier the baseline is unavailable; it never falls back to Jev.
    const pinnedRoute = session.pinnedCostTier
      ? modelCandidates.find(
          (route) => route.deployment !== 'local' && route.costTier === session.pinnedCostTier,
        )
      : undefined;
    if (session.pinnedCostTier && !pinnedRoute) {
      return this.finalReply(session, '[AgentOS] Baseline unavailable: no privacy-eligible ' + session.pinnedCostTier + ' cloud model is configured. No alternative route was used.');
    }
    let modelDecision: Pick<
      Awaited<ReturnType<DecisionService['selectModel']>>,
      'selectedRouteId' | 'confidence' | 'reasonCodes'
    >;
    const choiceKey = [
      session.id,
      [...session.dataLabels].sort().join(','),
      modelCandidates
        .map((route) => route.id)
        .sort()
        .join(','),
    ].join('|');
    const reusedRouteId = pinnedRoute ? undefined : this.taskModelChoices.get(choiceKey);
    // A compiled graph route already chose this task's tier. Take an ELIGIBLE
    // route of that tier without asking Jev; with none eligible (labels have
    // tightened, say), Jev picks among what is left as usual.
    const tier = session.preferredModelTier;
    const preferredRoute =
      pinnedRoute || reusedRouteId || !tier
        ? undefined
        : modelCandidates.find((route) =>
            tier === 'local'
              ? route.deployment === 'local'
              : route.deployment !== 'local' && route.costTier === tier,
          );
    try {
      modelDecision = pinnedRoute
        ? {
            selectedRouteId: pinnedRoute.id,
            confidence: 1,
            reasonCodes: ['baseline-pinned-' + pinnedRoute.costTier],
          }
        : reusedRouteId
          ? { selectedRouteId: reusedRouteId, confidence: 1, reasonCodes: ['task-model-reused'] }
          : preferredRoute
            ? {
                selectedRouteId: preferredRoute.id,
                confidence: 1,
                reasonCodes: ['compiled-model-tier-' + tier],
              }
            : await this.decisionService.selectModel(decisionState, modelCandidates, callContext);
    } catch (error) {
      if (!(error instanceof NoEligibleModelRouteError)) throw error;
      // The session now holds data no available model may see -- typically a
      // private tool result, since the cloud routes take public data only.
      return this.finalReply(
        session,
        '[AgentOS] Stopped this agent run: its data is now labelled ' +
          session.dataLabels.join(', ') +
          ', and no available model is allowed to see that. Only a local model may continue ' +
          'a task like this; turn on Ollama to run it locally.',
      );
    }
    const selectedRoute = modelCandidates.find(
      (route) => route.id === modelDecision.selectedRouteId,
    );
    if (!selectedRoute) throw new Error('Selected model route is no longer available.');
    // A reused or compiled pick is not a new Jev decision: logging one would
    // show calls that never happened. The `requested` lifecycle names the route.
    if (!reusedRouteId && !preferredRoute) {
      await this.emitDecision(
        session.runId,
        session.stepId,
        'select_model',
        modelCandidates.map((route) => route.id),
        [selectedRoute.id],
        modelDecision.confidence,
        modelDecision.reasonCodes,
      );
      if (!pinnedRoute) {
        this.taskModelChoices.set(choiceKey, selectedRoute.id);
        if (this.taskModelChoices.size > MAX_TASK_MODEL_CHOICES) {
          const oldest = this.taskModelChoices.keys().next().value;
          if (oldest !== undefined) this.taskModelChoices.delete(oldest);
        }
      }
    }

    const selectedToolSchemas = await Promise.all(
      selectedRequestTools.map(async ({ requestName, registered }): Promise<OpenAiTool> => {
        const descriptor = registered.descriptor;
        const current = await this.tools.get(descriptor.id);
        if (!current || current.descriptor.version !== descriptor.version) {
          throw new Error('Selected tool changed before its trusted schema was exposed.');
        }
        return {
          type: 'function',
          function: {
            name: requestName,
            description: descriptor.description,
            parameters: current.inputSchema,
          },
        };
      }),
    );

    const modelCallId = newId('chatcmpl');
    await this.sessions.requireGatewayTurn(binding);
    // Hermes can send built-in/core schemas that are not AgentOS capabilities.
    // Those must not erase the outer Jev selection. The task grant remains
    // immutable; only the selected descriptor versions are updated here.
    const trustedToolBearingRequest = trustedDescriptors.length > 0;
    await this.sessions.recordRouting(session.id, {
      candidateModelRouteIds: modelCandidates.map((route) => route.id),
      selectedModelRouteId: selectedRoute.id,
      ...(trustedToolBearingRequest
        ? {
            selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
            selectedToolVersions: Object.fromEntries(
              selectedTools.map((descriptor) => [descriptor.id, descriptor.version]),
            ),
          }
        : {}),
    });
    if (trustedToolBearingRequest) {
      await this.sessions.grantToolExposure(session.id, {
        modelCallId,
        selectedToolVersions: Object.fromEntries(
          selectedTools.map((descriptor) => [descriptor.id, descriptor.version]),
        ),
      });
    }

    const modelStartedAt = Date.now();
    await this.emitModelLifecycle({
      modelCallId,
      runId: session.runId,
      stepId: session.stepId,
      sessionStateId: session.id,
      phase: 'requested',
      routeId: selectedRoute.id,
      providerId: selectedRoute.providerId,
      configuredModelId: selectedRoute.modelId,
      selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
      dataLabels: session.dataLabels,
      messageCount: messages.length,
    });

    const turnBudgetSpent =
      selectedToolSchemas.length > 0 &&
      (this.turnToolCalls.get(turnKey) ?? 0) >= this.maxToolCallsPerTurn;
    let completed: ChatModelBackendResult;
    try {
      await waitWhilePaused(session.runId, callContext.signal);
      callContext.signal?.throwIfAborted();
      // Labels or credentials can change while paused; recheck eligibility
      // against the current session state, not the one routing saw.
      const dispatchState = await this.sessions.requireGatewayTurn(binding);
      if (!eligibleModelRoutes(decisionStateFromSession(dispatchState), [selectedRoute]).length || !this.routeAvailable(selectedRoute, callContext)) {
        return this.finalReply(dispatchState, '[AgentOS] Model context or credentials changed. Review the current privacy requirements before continuing.');
      }
      completed = await this.backend.complete(
        {
          route: selectedRoute,
          // A USER message, so it lands right after the tool results. As a
          // system message it was hoisted into the system prompt, the
          // conversation still ended on a tool result, and the model replied
          // with nothing; Hermes's "continue with the task" nudge then turned
          // the turn's last reply into a progress note instead of an answer.
          messages: turnBudgetSpent
            ? [...messages, { role: 'user', content: TOOL_BUDGET_EXHAUSTED_INSTRUCTION }]
            : messages,
          // Stripping the tools from a transcript full of tool calls made
          // Anthropic return an EMPTY reply; Hermes then nudged the model,
          // which narrated a next step it could not take, and the turn ended
          // with no answer. Keep the definitions and forbid the call instead.
          tools: selectedToolSchemas,
          ...(turnBudgetSpent ? { toolChoice: 'none' as const } : {}),
          maxTokens: request.max_completion_tokens ?? request.max_tokens,
        },
        callContext,
      );
      if (turnBudgetSpent) completed = { ...completed, toolCalls: [] };
      const madeCalls = completed.toolCalls?.length ?? 0;
      if (madeCalls > 0) {
        this.turnToolCalls.set(turnKey, (this.turnToolCalls.get(turnKey) ?? 0) + madeCalls);
      }
    } catch (error) {
      if (trustedToolBearingRequest) await this.sessions.clearToolExposure(session.id);
      await this.emitModelLifecycle({
        modelCallId,
        runId: session.runId,
        stepId: session.stepId,
        sessionStateId: session.id,
        phase: 'failed',
        routeId: selectedRoute.id,
        providerId: selectedRoute.providerId,
        configuredModelId: selectedRoute.modelId,
        selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
        dataLabels: session.dataLabels,
        messageCount: messages.length,
        latencyMs: Date.now() - modelStartedAt,
        ...ioPreview(
          session.dataLabels,
          messages,
          selectedTools.map((descriptor) => descriptor.id),
        ),
        error: {
          code: 'MODEL_CALL_FAILED',
          message: error instanceof Error ? compactSummary(error.message) : 'Model call failed.',
        },
      });
      throw error;
    }

    await this.sessions.requireGatewayTurn(binding);
    await this.emitModelLifecycle({
      modelCallId,
      runId: session.runId,
      stepId: session.stepId,
      sessionStateId: session.id,
      phase: 'completed',
      routeId: selectedRoute.id,
      providerId: selectedRoute.providerId,
      configuredModelId: selectedRoute.modelId,
      actualModelId: completed.actualModel ?? selectedRoute.modelId,
      selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
      dataLabels: session.dataLabels,
      messageCount: messages.length,
      latencyMs: Date.now() - modelStartedAt,
      tokensIn: completed.tokensIn,
      tokensOut: completed.tokensOut,
      estimatedCostCents: completed.estimatedCostCents,
      toolCallCount: completed.toolCalls?.length ?? 0,
      ...ioPreview(
        session.dataLabels,
        messages,
        selectedTools.map((descriptor) => descriptor.id),
        completed,
      ),
    });

    const latest = await this.sessions.get(session.id);
    await this.sessions.appendContext(session.id, [
      {
        role: 'assistant',
        summary: session.dataLabels.every(label => label === 'public') ? compactSummary(completed.text || '(model proposed tool calls)') : '(Private model result withheld from persisted context.)',
        // A model answer may incorporate a harness system prompt, so it is not
        // automatically promoted into remote-safe Jev context.
        sanitizedSummary: undefined,
        dataLabels: session.dataLabels,
        tokenEstimate: completed.tokensOut,
      },
    ]);

    return {
      id: modelCallId,
      created: Math.floor(Date.now() / 1000),
      model: completed.actualModel ?? selectedRoute.modelId,
      text: completed.text,
      toolCalls: completed.toolCalls ?? [],
      tokensIn: completed.tokensIn,
      tokensOut: completed.tokensOut,
      runId: session.runId,
      sessionStateId: latest?.id ?? session.id,
      selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
    };
  }

  /**
   * Answer without calling a model: a plain final reply with no tool calls,
   * which ends the Hermes turn cleanly. For when another model call would be
   * wrong (a looping turn) or is impossible (no model may see the session's
   * data). Throwing instead made Hermes retry three times and then report the
   * gateway as "temporarily unavailable, wait and /retry" -- untrue for both.
   * The reply is also written to the run log, where a person will look.
   */
  private async finalReply(
    session: AgentSessionState,
    text: string,
    log: string | undefined = text,
  ): Promise<GatewayCompletion> {
    if (log) {
      await this.bus.emit(session.runId, {
        type: 'log',
        runId: session.runId,
        level: 'warn',
        message: log,
        at: nowIso(),
      });
    }
    return {
      id: newId('chatcmpl'),
      created: Math.floor(Date.now() / 1000),
      model: 'agentos-stop',
      text,
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      runId: session.runId,
      sessionStateId: session.id,
      selectedToolIds: [],
    };
  }

  private async resolveRequestedTools(
    tools: OpenAiTool[],
    allowedToolIds: string[],
  ): Promise<{ requestName: string; registered: RegisteredTool }[]> {
    const allowed = new Set(allowedToolIds);
    const resolved: { requestName: string; registered: RegisteredTool }[] = [];
    const seenToolIds = new Set<string>();
    for (const requestName of extractToolNames(tools)) {
      const rawWireName = requestName.startsWith('mcp__agentos__')
        ? requestName.slice('mcp__agentos__'.length)
        : requestName;
      const registered =
        (await this.tools.get(requestName)) ?? (await this.tools.getByWireName(rawWireName));
      if (
        !registered ||
        !allowed.has(registered.descriptor.id) ||
        seenToolIds.has(registered.descriptor.id)
      ) {
        continue;
      }
      seenToolIds.add(registered.descriptor.id);
      resolved.push({ requestName, registered });
    }
    return resolved;
  }

  private async selectTools(
    state: DecisionState,
    candidates: ToolDescriptor[],
    ctx: ProviderCallContext,
    runId: string,
    stepId: string,
  ): Promise<ToolDescriptor[]> {
    const families = [...new Set(candidates.map((candidate) => candidate.family))];
    const familyDecision = await this.decisionService.selectToolFamilies(state, families, ctx);
    await this.emitDecision(
      runId,
      stepId,
      'select_tool_families',
      families,
      familyDecision.selectedFamilies,
      average(Object.values(familyDecision.confidences)),
      familyDecision.reasonCodes,
    );
    const familySet = new Set(familyDecision.selectedFamilies);
    const narrowed = candidates.filter((candidate) => familySet.has(candidate.family));
    const toolDecision = await this.decisionService.selectTools(state, narrowed, ctx);
    await this.emitDecision(
      runId,
      stepId,
      'select_tools',
      narrowed.map((candidate) => candidate.id),
      toolDecision.selectedToolIds,
      average(Object.values(toolDecision.confidences)),
      toolDecision.reasonCodes,
    );
    const selected = new Set(toolDecision.selectedToolIds);
    return narrowed.filter((candidate) => selected.has(candidate.id));
  }

  private async emitDecision(
    runId: string,
    stepId: string,
    operation: ControlDecisionOperation,
    candidateIds: string[],
    selectedIds: string[],
    confidence: number,
    reasonCodes: string[],
  ): Promise<void> {
    const fallback = reasonCodes.some(
      (reason) => reason.includes('fallback') || reason.includes('deterministic'),
    );
    await this.bus.emit(runId, {
      type: 'control.decided',
      decision: {
        id: newId('ctl'),
        runId,
        stepId,
        operation,
        candidateIds,
        selectedIds,
        confidence,
        reasonCodes,
        source: fallback ? 'fallback' : 'jev',
        at: nowIso(),
      },
    });
  }

  private async emitModelLifecycle(input: {
    modelCallId: string;
    runId: string;
    stepId?: string;
    sessionStateId: string;
    phase: 'requested' | 'completed' | 'failed';
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
    inputPreview?: string;
    outputPreview?: string;
    ioWithheld?: boolean;
    error?: { code: string; message: string };
  }): Promise<void> {
    await this.bus.emit(input.runId, {
      type: 'model.lifecycle',
      lifecycle: {
        id: newId('model_evt'),
        ...input,
        dataLabels: [...input.dataLabels],
        selectedToolIds: [...input.selectedToolIds],
        at: nowIso(),
      },
    });
  }
}

/**
 * Debug-log copy of a model call's input and output. Truncated per message, and
 * only built for all-public sessions: the event stream is UI-safe by contract,
 * so anything that might carry private data is withheld rather than redacted.
 */
function ioPreview(
  labels: readonly DataLabel[],
  messages: OpenAiMessage[],
  toolNames: string[],
  output?: ChatModelBackendResult,
): { inputPreview?: string; outputPreview?: string; ioWithheld?: boolean } {
  if (!labels.every((label) => label === 'public')) return { ioWithheld: true };
  const clip = (text: string, max: number) =>
    text.length <= max ? text : text.slice(0, max) + '… [+' + (text.length - max).toString() + ' chars]';
  const shown = messages.slice(-8);
  const skipped = messages.length - shown.length;
  const input = [
    ...(skipped > 0 ? ['… ' + skipped.toString() + ' earlier message(s) not shown'] : []),
    ...shown.map((message) => {
      const text = contentText(message.content).trim();
      const calls = (message as { tool_calls?: GatewayToolCall[] }).tool_calls ?? [];
      return (
        '[' +
        message.role +
        '] ' +
        clip(text, message.role === 'system' ? 300 : 1500) +
        calls.map((call) => '\n  -> ' + call.function.name + ' ' + clip(call.function.arguments, 300)).join('')
      );
    }),
    ...(toolNames.length > 0 ? ['tools offered: ' + toolNames.join(', ')] : ['tools offered: none']),
  ].join('\n\n');
  if (!output) return { inputPreview: input };
  const outputText = [
    output.text ? clip(output.text.trim(), 3000) : '',
    ...(output.toolCalls ?? []).map(
      (call) => 'tool call: ' + call.function.name + ' ' + clip(call.function.arguments, 600),
    ),
  ]
    .filter(Boolean)
    .join('\n');
  return { inputPreview: input, outputPreview: outputText || '(empty response)' };
}

function isSeparateBrowserOperation(toolId: string): boolean {
  return (
    (toolId.startsWith('browserbase.') ||
      toolId.startsWith('browserless.') ||
      toolId.startsWith('localbrowser.')) &&
    ['open', 'search', 'read'].includes(toolId.slice(toolId.lastIndexOf('.') + 1))
  );
}

function summarizeMessage(
  message: OpenAiMessage,
  session: AgentSessionState,
): {
  role: 'system' | 'user' | 'assistant' | 'tool';
  summary: string;
  sanitizedSummary?: string;
  dataLabels: DataLabel[];
  tokenEstimate: number;
} {
  const role =
    message.role === 'system' || message.role === 'assistant' || message.role === 'tool'
      ? message.role
      : 'user';
  const text =
    role === 'tool'
      ? unwrapHermesToolEnvelope(contentText(message.content))
      : contentText(message.content);
  const summary = compactSummary(text);
  const trustedToolEntry =
    role === 'tool'
      ? [...session.context]
          .reverse()
          .find(
            (entry) =>
              entry.role === 'tool' &&
              Boolean(entry.sanitizedSummary) &&
              entry.sanitizedSummary === summary,
          )
      : undefined;
  const dataLabels = trustedToolEntry
    ? trustedToolEntry.dataLabels
    : role === 'tool'
      ? [...new Set<DataLabel>([...session.dataLabels, 'local_only'])]
      : session.dataLabels;
  const maySanitize =
    (role === 'user' && labelsArePublic(dataLabels)) ||
    (role === 'tool' && Boolean(trustedToolEntry) && labelsArePublic(dataLabels));
  return {
    role,
    summary: labelsArePublic(dataLabels) ? summary : '(Private harness message withheld from persisted context.)',
    sanitizedSummary: maySanitize ? summary : undefined,
    dataLabels,
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

/**
 * Hermes wraps external tool results in a fixed prompt-injection envelope
 * (hermes-agent/agent/tool_dispatch_helpers.py `_maybe_wrap_untrusted`) before
 * echoing them back. Unwrapped, the body is byte-identical to the MCP result,
 * so it can match the broker's trusted entry. Without this every browser
 * result was labelled local_only, which then spread to the whole session and
 * blocked every cloud route ("No policy-eligible model route is available").
 *
 * Unwrapping grants nothing on its own: the body must still equal a summary
 * AgentOS recorded as public, or it gets local_only as before.
 */
const HERMES_TOOL_ENVELOPE =
  /^<untrusted_tool_result source="[^"\n]*">\n[^\n]*\n\n([\s\S]*)\n<\/untrusted_tool_result>$/;

function unwrapHermesToolEnvelope(text: string): string {
  const body = HERMES_TOOL_ENVELOPE.exec(text)?.[1] ?? text;
  // Hermes re-encodes an MCP call's text as exactly {"result": "<text>"} on
  // success or {"error": "<text>"} on failure. The inner text is what AgentOS
  // recorded (broker for results, core/mcp/server.ts for errors).
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      const value = (parsed as Record<string, unknown>)[keys[0] ?? ''];
      if (keys.length === 1 && (keys[0] === 'result' || keys[0] === 'error')) {
        if (typeof value === 'string') return value;
      }
    }
  } catch {
    // Not JSON: an ordinary tool result.
  }
  return body;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return typeof part.text === 'string' ? part.text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function compactSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty message)';
  return normalized.length <= 320 ? normalized : normalized.slice(0, 317) + '...';
}

function extractToolNames(tools: OpenAiTool[]): string[] {
  return [
    ...new Set(
      tools.flatMap((tool) =>
        typeof tool.function?.name === 'string' && tool.function.name ? [tool.function.name] : [],
      ),
    ),
  ];
}

function labelsArePublic(labels: DataLabel[]): boolean {
  return labels.every((label) => label === 'public');
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function routeToTier(route: ModelRoute): ModelTier {
  return route.deployment === 'local' ? 'local' : route.costTier;
}

export function textAdapterBackend(model: TextModelAdapter): ChatModelBackend {
  return {
    async complete(input, ctx) {
      const prompt = input.messages
        .filter((message) => message.role !== 'system')
        .map((message) => message.role + ': ' + contentText(message.content))
        .join('\n');
      const system = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => contentText(message.content))
        .join('\n');
      const completed = await model.complete(
        {
          system: system || undefined,
          prompt,
          maxTokens: input.maxTokens,
          tier: routeToTier(input.route),
        },
        ctx,
      );
      if (!completed.ok) throw new Error('Selected model failed: ' + completed.error.message);
      return completed.data;
    },
  };
}
