/**
 * Run lifecycle: start -> steps -> (block on approval) -> finish.
 *
 * DEPENDENCY RULE: this file imports no express, no fetch, and no vendor SDK.
 * The store and providers arrive as constructor arguments (the Store *type* is
 * imported type-only, which creates no runtime coupling), so the orchestrator is
 * unit-testable and survives a swap of either.
 */

import type {
  Capability,
  CapabilityMap,
  CompiledNodeDecision,
  CompletionDecision,
  DataLabel,
  DecisionState,
  Json,
  ProposedAction,
  ProviderCallContext,
  ProviderId,
  Run,
  ScheduleDecision,
  SessionCheckpoint,
  Step,
  ToolDescriptor,
} from '@htn/shared';
import { stripPiiValue } from '@htn/shared';
import type { Store } from '../store/types.js';
import { newId, nowIso } from '../lib/ids.js';
import { ApprovalRejectedError, waitForApproval } from './approvalGate.js';
import type { RunBus } from './bus.js';
import { buildEgressEvent } from './ledger.js';
import { clearPause, waitWhilePaused } from './pauseGate.js';
import { detectPii } from './redaction.js';
import { classify } from './risk.js';
import type { DecisionService } from './decisions/service.js';
import type { SessionStateService } from './sessions/service.js';
import type { ToolRegistry } from './tools/registry.js';
import { eligibleTaskTools, mockTwinsOfLiveTools } from './tools/taskEligibility.js';
import { toolVersions, usableAgentRoute } from './graph/compile.js';
import { fanOut, type FanOutOutcome } from './swarm.js';
import { getPlaybook } from './playbooks/registry.js';
import type {
  AgentTaskResult,
  AgentTaskSpec,
  FanOutSpec,
  PlaybookContext,
  RedactionOutput,
  StepSpec,
} from './playbooks/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CachedTaskRoute = {
  privacy: ScheduleDecision['privacy'];
  intelligence: ScheduleDecision['intelligence'];
  privacyConfidence: number;
  intelligenceConfidence: number;
  modelTier: ScheduleDecision['modelTier'];
  exposedTools: string[];
  confidence: number;
  rationale?: string;
};

export interface OrchestratorDeps {
  store: Store;
  bus: RunBus;
  provider: <C extends Capability>(capability: C) => CapabilityMap[C];
  /** Reads the registry's live BINDINGS, so a re-point is reflected everywhere. */
  providerFor: (capability: Capability) => ProviderId;
  browserForSession?: (sessionId: string, runId: string) => import('@htn/shared').BrowserAdapter;
  decisionService: DecisionService;
  sessionStateService: SessionStateService;
  toolRegistry?: ToolRegistry;
  /** The trusted broker. Absent means graph tool nodes have no brokered path. */
  toolBroker?: {
    execute(request: {
      sessionStateId: string;
      toolId: string;
      arguments: Json;
      signal?: AbortSignal;
      forceApproval?: boolean;
    }): Promise<{ output: Json; summary: string; dataLabels?: DataLabel[] }>;
  };
  toolDiscovery?: {
    discoverForTask(input: {
      query: string;
      runId: string;
      stepId?: string;
      signal?: AbortSignal;
    }): Promise<{ registered: string[]; skipped: string[]; warning?: string }>;
  };
  /** Cached/local catalog sources, including user-configured MCP servers. */
  localToolCandidates?: () => Promise<string[]>;
  /** Keep a graph-level Jev decision a run had to make, so the next run reuses it. */
  recordCompiledDecision?: (
    graphId: string,
    nodeId: string,
    entry: CompiledNodeDecision,
  ) => Promise<void>;
  /** Release resources only after the run and all its graph branches have settled. */
  releaseRunResources?: (input: { runId: string; stepId: string }) => Promise<void>;
  /**
   * Cost ceilings applied to every agent task at run time. A node asking for
   * more time is clamped (and the clamp logged) instead of being rejected, so
   * saved graphs keep running. Absent means no ceiling. `networkRetries` is how
   * many times an agent the run could not reach is started again (default 2);
   * it is the ONLY way an agent task runs Hermes more than once.
   */
  agentCeilings?: { maxDurationMs: number; networkRetries?: number };
}

/** Retries for an unreachable agent when no ceiling says otherwise. */
const DEFAULT_AGENT_NETWORK_RETRIES = 2;

import { KeyedLock } from './locks.js';

export class Orchestrator {
  private readonly inFlight = new Map<string, AbortController>();
  private readonly contextLocks = new KeyedLock();
  private readonly taskRouteCache = new Map<string, { expiresAt: number; data: CachedTaskRoute }>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** True while a run is executing in this process. */
  isRunning(runId: string): boolean {
    return this.inFlight.has(runId);
  }

  cancel(runId: string): boolean {
    const controller = this.inFlight.get(runId);
    if (!controller) return false;
    // Release the pause latch first, or a paused run would sit on it and never
    // observe the abort.
    clearPause(runId);
    controller.abort();
    return true;
  }

  /**
   * Fire-and-forget. The HTTP layer responds 201 immediately; progress arrives
   * over SSE. Never await this from a route handler.
   */
  start(run: Run): void {
    void this.execute(run).catch((err) => {
      console.error('[orchestrator] unhandled failure for run ' + run.id, err);
    });
  }

  private async execute(run: Run): Promise<void> {
    const { store, bus } = this.deps;
    const controller = new AbortController();
    this.inFlight.set(run.id, controller);

    try {
      const playbook = getPlaybook(run.kind);
      if (!playbook) throw new Error('No playbook registered for kind "' + run.kind + '"');

      const parsed = playbook.inputSchema.safeParse(run.input);
      if (!parsed.success) {
        throw new Error('Invalid input for playbook "' + run.kind + '": ' + parsed.error.message);
      }

      await this.patchRun(run.id, { status: 'running' });

      const ctx = this.createContext(run.id, controller.signal);
      const outcome = await playbook.execute(ctx, parsed.data as never);

      await this.patchRun(run.id, {
        status: 'succeeded',
        summary: outcome.summary,
        result: outcome.result,
      });
    } catch (err) {
      await this.finishWithError(run.id, err as Error, controller.signal.aborted);
    } finally {
      // Expire suspended handoff/approval work when its enclosing run ends.
      // A late decision must never revive a timed-out run.
      controller.abort();
      for (const approval of await store.listApprovals(run.id))
        if (approval.status === 'pending') {
          const expired = await store.patchApproval(approval.id, {
            status: 'expired',
            decidedAt: nowIso(),
            note: 'Run ended before this approval was resolved.',
          });
          await bus.emit(run.id, { type: 'approval.resolved', approval: expired });
        }
      // Contexts and mutable browser resources belong to the run, not an agent node.
      const finalRun = await store.getRun(run.id);
      for (const session of await store.listSessionStates(run.id)) {
        if (session.harnessSessionId) {
          await this.deps
            .provider('agent.runtime')
            .cancelTask(session.harnessSessionId, {
              runId: run.id,
              stepId: session.stepId,
              policyRule: 'run-context-release',
            })
            .catch(() => undefined);
        }
        if (!['completed', 'failed', 'cancelled'].includes(session.status)) {
          await this.deps.sessionStateService.setStatus(
            session.id,
            finalRun?.status === 'succeeded' ? 'completed' : 'cancelled',
          );
        }
      }
      await this.deps
        .releaseRunResources?.({ runId: run.id, stepId: 'run-finalize' })
        .catch((error) => {
          console.warn(
            '[orchestrator] run resource cleanup failed:',
            error instanceof Error ? error.message : 'unknown',
          );
        });
      this.inFlight.delete(run.id);
      clearPause(run.id);
      void bus;
      void store;
    }
  }

  private async finishWithError(runId: string, err: Error, aborted: boolean): Promise<void> {
    if (err instanceof ApprovalRejectedError) {
      await this.patchRun(runId, {
        status: 'cancelled',
        summary: 'Stopped: you declined the action.',
        error: { code: err.code, message: err.message },
      });
      return;
    }
    if (aborted) {
      await this.patchRun(runId, { status: 'cancelled', summary: 'Cancelled.' });
      return;
    }
    await this.patchRun(runId, {
      status: 'failed',
      summary: err.message,
      error: { code: 'RUN_FAILED', message: err.message },
    });
  }

  /**
   * Park here while the run is paused, writing 'paused' only if we actually
   * have to wait, and putting the run back to 'running' on the way out.
   */
  private async holdWhilePaused(runId: string, signal: AbortSignal): Promise<void> {
    let held = false;
    await waitWhilePaused(runId, signal, async () => {
      held = true;
      await this.patchRun(runId, { status: 'paused' });
    });
    if (held && !signal.aborted) {
      await this.patchRun(runId, { status: 'running' });
    }
  }

  private async patchRun(runId: string, patch: Partial<Run>): Promise<Run> {
    const run = await this.deps.store.patchRun(runId, patch);
    await this.deps.bus.emit(runId, { type: 'run.updated', run });
    return run;
  }

  private async upsertStep(stepId: string, patch: Partial<Step>): Promise<Step> {
    const step = await this.deps.store.patchStep(stepId, patch);
    await this.deps.bus.emit(step.runId, { type: 'step.upserted', step });
    return step;
  }

  /* ------------------------------------------------------------------ */
  /* The PlaybookContext implementation                                 */
  /* ------------------------------------------------------------------ */

  private createContext(runId: string, signal: AbortSignal): PlaybookContext {
    const { store, bus, provider, providerFor, decisionService, sessionStateService } = this.deps;
    /** Keeps placeholder numbering unique across every field in this run. */
    let piiCounter = 0;
    const contextScopes = new Map<string, { sessionStateId: string; taskId: string }>();

    /** Shared by ctx.callContext and runAgentTask's own internal provider calls. */
    const buildCallContext = (args: {
      stepId?: string;
      policyRule: string;
      redactions?: { placeholder: string; type: string }[];
    }): ProviderCallContext => ({
      runId,
      stepId: args.stepId,
      policyRule: args.policyRule,
      redactions: args.redactions,
      signal,
    });

    const createStep = async (spec: StepSpec): Promise<Step> => {
      const step = await store.appendStep({
        id: newId('step'),
        runId,
        nodeId: spec.nodeId,
        parentStepId: spec.parentStepId ?? null,
        kind: spec.kind ?? 'task',
        label: spec.label,
        status: 'running',
        providerId: spec.providerId,
        input: spec.input,
        startedAt: nowIso(),
      });
      await bus.emit(runId, { type: 'step.upserted', step });
      return step;
    };

    const judgeCheckpoint = async (
      checkpoint: SessionCheckpoint,
      stepId?: string,
    ): Promise<CompletionDecision> => {
      const decision = await decisionService.judgeCompletion(
        checkpoint,
        buildCallContext({ stepId, policyRule: 'verified-completion-checkpoint' }),
      );
      const fallback = decision.reasonCodes.some(
        (reason) => reason.includes('fallback') || reason.includes('deterministic'),
      );
      await bus.emit(runId, {
        type: 'control.decided',
        decision: {
          id: newId('ctl'),
          runId,
          stepId,
          operation: 'judge_completion',
          candidateIds: ['done', 'continue', 'blocked'],
          selectedIds: [decision.status],
          confidence: decision.confidence,
          reasonCodes: decision.reasonCodes,
          source: fallback ? 'fallback' : 'jev',
          at: nowIso(),
        },
      });
      return decision;
    };

    const ctx: PlaybookContext = {
      runId,
      signal,

      log: async (level, message) => {
        await bus.emit(runId, { type: 'log', runId, level, message, at: nowIso() });
      },

      step: async (spec, fn) => {
        // The pause checkpoint. Before a step starts is the only place a pause
        // can take effect without leaving a half-done step behind.
        await this.holdWhilePaused(runId, signal);
        const step = await createStep(spec);
        try {
          const output = await fn(step);
          await this.upsertStep(step.id, {
            status: 'succeeded',
            output: toJson(output),
            endedAt: nowIso(),
          });
          return output;
        } catch (err) {
          await this.upsertStep(step.id, {
            status: 'failed',
            error: { code: 'STEP_FAILED', message: (err as Error).message },
            endedAt: nowIso(),
          });
          throw err;
        }
      },

      fanOut: async <I, O>(spec: FanOutSpec<I, O>): Promise<FanOutOutcome<O>[]> => {
        const parent = await createStep({ label: spec.label, kind: 'swarm', nodeId: spec.nodeId });

        const outcomes = await fanOut<I, O>(
          spec.items,
          async (item, index) => {
            const child = await createStep({
              label: spec.workerLabel(item, index),
              kind: 'worker',
              // Same nodeId as the parent: the whole fan-out is one graph node.
              nodeId: spec.nodeId,
              parentStepId: parent.id,
            });
            try {
              const value = await spec.worker(item, index, child);
              await this.upsertStep(child.id, {
                status: 'succeeded',
                output: toJson(value),
                endedAt: nowIso(),
              });
              return value;
            } catch (err) {
              await this.upsertStep(child.id, {
                status: 'failed',
                error: { code: 'WORKER_FAILED', message: (err as Error).message },
                endedAt: nowIso(),
              });
              throw err;
            }
          },
          { concurrency: spec.concurrency, signal },
        );

        const failed = outcomes.filter((o) => !o.ok).length;
        // A partial swarm result is still useful, so the parent succeeds unless
        // every worker failed. Independent evidence, independently reported.
        await this.upsertStep(parent.id, {
          status: failed === outcomes.length && outcomes.length > 0 ? 'failed' : 'succeeded',
          output: { workers: outcomes.length, failed } as Json,
          endedAt: nowIso(),
        });
        return outcomes;
      },

      requireApproval: async (stepId: string, action: ProposedAction) => {
        const decision = classify(action);
        await this.upsertStep(stepId, { riskClass: decision.riskClass });

        // Ungated actions return the action unchanged, so every caller can use
        // the return value uniformly instead of branching on whether a human
        // was involved.
        if (decision.riskClass !== 'ask_human') return action;

        const approval = {
          id: newId('apr'),
          runId,
          stepId,
          question: action.description,
          proposedAction: toJson(action.payload ?? action) ?? null,
          reversibility: decision.reversibility,
          riskClass: decision.riskClass,
          policyRule: decision.rule,
          status: 'pending' as const,
          createdAt: nowIso(),
        };

        await store.createApproval(approval);
        await this.upsertStep(stepId, { status: 'blocked', approvalId: approval.id });
        await this.patchRun(runId, { status: 'awaiting_approval' });
        await bus.emit(runId, { type: 'approval.requested', approval });

        // Blocks here. The decide endpoint patches the Approval, emits
        // approval.resolved, and calls settleApproval() to release this promise.
        const outcome = await waitForApproval(approval.id, action, signal);

        await this.patchRun(runId, { status: 'running' });
        await this.upsertStep(stepId, { status: 'running' });

        if (outcome.verdict === 'rejected') throw new ApprovalRejectedError(approval.id);

        if (outcome.verdict === 'revised') {
          await bus.emit(runId, {
            type: 'log',
            runId,
            level: 'info',
            message:
              'Approval ' +
              approval.id +
              ' was revised by a human and reauthorized; executing the revised ' +
              'payload, not the proposed one.',
            at: nowIso(),
          });
        }

        // The REVISED action when the human edited it. Callers execute this.
        return outcome.action;
      },

      provider,
      providerFor,
      browserForSession: this.deps.browserForSession
        ? (sessionId) => this.deps.browserForSession!(sessionId, runId)
        : undefined,

      redact: async (text: string, field: string): Promise<RedactionOutput> => {
        const { redacted, spans } = detectPii(text, piiCounter);
        piiCounter += spans.length;

        for (const span of spans) {
          const stored = {
            id: newId('pii'),
            runId,
            type: span.type,
            placeholder: span.placeholder,
            field,
            // Sensitive values are pinned local. Only the placeholder may travel.
            routedTo: 'local' as const,
            value: span.value,
          };
          await store.appendPiiSpan(stored);
          // stripPiiValue is what keeps the raw value off the wire.
          await bus.emit(runId, { type: 'pii.detected', span: stripPiiValue(stored) });
        }

        return {
          redacted,
          redactions: spans.map((s) => ({ placeholder: s.placeholder, type: s.type })),
          hadSensitive: spans.length > 0,
        };
      },

      registeredToolIds: async (candidates: string[]): Promise<string[]> => {
        const registry = this.deps.toolRegistry;
        if (!registry) return candidates;
        const resolved = await registry.resolve(candidates);
        const executable = new Set(
          resolved
            .filter((descriptor) => descriptor.availability === 'available')
            .map((descriptor) => descriptor.id),
        );
        // Preserve the caller's ordering; it is the author's stated preference.
        return candidates.filter((id) => executable.has(id));
      },

      callBrokeredTool: async ({ stepId, toolId, args, dataLabels, forceApproval }) => {
        const broker = this.deps.toolBroker;
        const registry = this.deps.toolRegistry;
        if (!broker || !registry) return null;

        const [descriptor] = await registry.resolve([toolId]);
        if (!descriptor)
          throw new Error(
            'TOOL_NOT_REGISTERED: ' +
              toolId +
              '. Discover and register the provider tool before execution.',
          );

        // A short-lived session state whose ONLY purpose is to carry the
        // author's pinned choice as a grant the broker can verify. One tool,
        // one turn. It is not a harness session and never binds one.
        // HARNESS IS DELIBERATELY NOT 'hermes'.
        //
        // resolveActiveHarnessSession('hermes') requires exactly ONE active
        // hermes session and throws "multiple active sessions are ambiguous"
        // otherwise -- which is how Hermes's own MCP tool calls find their
        // context. Labelling this ephemeral grant-carrier as hermes made every
        // graph tool node leave a phantom hermes session behind, and the next
        // agent_task died with a 409 it had nothing to do with.
        //
        // This is not a harness session. It is a one-call grant, so it says so.
        const session = await sessionStateService.create({
          runId,
          stepId,
          harness: 'graph',
          objective: 'graph tool node: ' + toolId,
          dataLabels: dataLabels ?? ['private'],
          // One call, so one step of budget. This session exists to carry a
          // grant, not to run a loop.
          budget: { stepsRemaining: 1 },
          candidateToolIds: [toolId],
        });
        await sessionStateService.beginTurn(session.id);
        await sessionStateService.grantToolExposure(session.id, {
          modelCallId: 'graph-node:' + stepId,
          selectedToolVersions: { [descriptor.id]: descriptor.version },
        });

        try {
          const result = await broker.execute({
            sessionStateId: session.id,
            toolId: descriptor.id,
            arguments: args as Json,
            signal,
            forceApproval,
          });
          return { output: result.output, summary: result.summary, dataLabels: result.dataLabels };
        } finally {
          // The grant must not outlive the one call it was minted for, and
          // neither must the session: an ACTIVE one left behind is state that
          // later lookups have to disambiguate. Terminal status first, which
          // also clears the grant (see savePatch), then belt and braces.
          await sessionStateService.setStatus(session.id, 'completed').catch(() => undefined);
          await sessionStateService.clearToolExposure(session.id).catch(() => undefined);
        }
      },

      announceBrowserSession: async (session) => {
        await bus.emit(runId, {
          type: 'browser.session.opened',
          session: { runId, openedAt: nowIso(), ...session },
        });
      },

      releaseBrowserSession: async (sessionId) => {
        await bus.emit(runId, {
          type: 'browser.session.closed',
          runId,
          sessionId,
          at: nowIso(),
        });
      },

      recordSchedule: async (input) => {
        const decision: ScheduleDecision = {
          id: newId('sch'),
          runId,
          privacy: input.privacy ?? 'cloud',
          intelligence: input.intelligence ?? 'low',
          privacyConfidence: input.privacyConfidence ?? input.confidence,
          intelligenceConfidence: input.intelligenceConfidence ?? input.confidence,
          escalated: false,
          at: nowIso(),
          ...input,
        };
        await store.createScheduleDecision(decision);
        await bus.emit(runId, { type: 'schedule.decided', decision });
        return decision;
      },

      callContext: buildCallContext,

      judgeCompletion: judgeCheckpoint,

      recordCompiledDecision: async (graphId, nodeId, entry) => {
        await this.deps.recordCompiledDecision?.(graphId, nodeId, entry).catch(() => undefined);
      },

      runAgentTask: async (spec: AgentTaskSpec): Promise<AgentTaskResult> => {
        const step = await createStep({
          label: spec.label,
          kind: 'agent_task',
          nodeId: spec.nodeId,
          parentStepId: spec.parentStepId ?? null,
          // Read from the registry rather than hardcoded, so re-pointing
          // 'agent.runtime' in BINDINGS relabels the step too.
          providerId: providerFor('agent.runtime'),
        });

        // 1.5s x 40 = 60s total budget. A real Hermes turn commonly takes
        // several seconds per model call and 40+ seconds for a slow tool call
        // (observed directly against a live install) — the old 400ms x 20
        // (~8s) default was sized for the mock and would cancel a real,
        // healthy call almost immediately.
        const pollIntervalMs = spec.pollIntervalMs ?? 1500;
        const ceilings = this.deps.agentCeilings;
        // A node's time budget, clamped to the run-wide cost ceiling. Clamped
        // rather than rejected so saved graphs keep running. `spec.maxTurns` is
        // accepted for saved graphs and ignored: an agent task is one Hermes run.
        const maxDurationMs =
          ceilings && (spec.maxDurationMs ?? Infinity) > ceilings.maxDurationMs
            ? ceilings.maxDurationMs
            : spec.maxDurationMs;
        if (ceilings && (spec.maxDurationMs ?? 0) > (maxDurationMs ?? 0)) {
          await ctx.log(
            'info',
            'Agent task "' +
              spec.label +
              '" time budget clamped to the cost ceiling: ' +
              Math.round((maxDurationMs ?? 0) / 1000).toString() +
              's (node asked for ' +
              Math.round((spec.maxDurationMs ?? 0) / 1000).toString() +
              's).',
          );
        }
        const networkRetries = ceilings?.networkRetries ?? DEFAULT_AGENT_NETWORK_RETRIES;
        // An explicit wall-clock budget sizes the per-turn poll budget too.
        // Otherwise the fixed 60s default cut a healthy multi-tool research
        // turn off at ~61s of a 600s maxDurationMs (observed live).
        const maxPolls =
          spec.maxPolls ??
          (maxDurationMs !== undefined ? Math.ceil(maxDurationMs / pollIntervalMs) : 40);
        const maxFailedToolCalls = spec.maxFailedToolCalls;
        const startedAt = Date.now();
        let sessionStateId: string | undefined;
        let activeTaskId: string | undefined;
        let retainContext = false;
        let releaseScope: (() => void) | undefined;

        try {
          if (spec.contextScope)
            releaseScope = await this.contextLocks.acquire(
              runId + ':' + spec.contextScope.id,
              signal,
            );
          const previous = spec.contextScope ? contextScopes.get(spec.contextScope.id) : undefined;
          if (spec.contextScope?.mode === 'fresh' && previous)
            throw new Error('Context scope already exists; use continue.');
          if (spec.contextScope?.mode === 'continue' && !previous)
            throw new Error('Missing or expired context scope; refusing to start a replacement.');
          const priorState = previous
            ? await sessionStateService.get(previous.sessionStateId)
            : null;
          if (previous && priorState?.status !== 'quiescent')
            throw new Error('Context scope is not available for continuation.');
          const ceiling =
            priorState?.toolCeiling === undefined
              ? spec.toolCeiling
              : spec.toolCeiling === undefined
                ? priorState.toolCeiling
                : spec.toolCeiling.filter((id) => priorState.toolCeiling!.includes(id));
          if (
            priorState?.boundBrowserSessionId &&
            spec.resourceBindings?.browserSession &&
            priorState.boundBrowserSessionId !== spec.resourceBindings.browserSession
          ) {
            throw new Error('A continued agent context cannot switch its bound browser session.');
          }
          const boundBrowserSessionId =
            spec.resourceBindings?.browserSession ?? priorState?.boundBrowserSessionId;
          // 1. Search and normalize only task-relevant provider tools. Private
          //    objectives use an explicitly sanitized query; secret/local-only
          //    objectives never leave the machine for catalog discovery.
          const labels: DataLabel[] = [
            ...new Set([...(priorState?.dataLabels ?? []), ...(spec.dataLabels ?? ['public'])]),
          ];
          const sanitizedTask =
            spec.sanitizedGoal ??
            (labels.every((label) => label === 'public') ? spec.goal : undefined);
          const remoteForbidden = labels.some(
            (label) => label === 'secret' || label === 'local_only',
          );
          const decisionState: DecisionState = {
            taskSummary: sanitizedTask ?? 'Sensitive objective withheld.',
            dataLabels: labels,
            sanitizedForRemote: Boolean(sanitizedTask) && !remoteForbidden,
          };

          const allToolsBaseline = spec.routing === 'all_tools_frontier';
          const discoveredIds: string[] = [];
          if (this.deps.localToolCandidates) {
            discoveredIds.push(...(await this.deps.localToolCandidates()));
          }
          if (allToolsBaseline && this.deps.toolRegistry) {
            // The baseline arm starts from EVERY registered tool; eligibility
            // below still drops what this task's labels may not use.
            discoveredIds.push(
              ...(await this.deps.toolRegistry.list()).map((tool) => tool.descriptor.id),
            );
          }
          if (
            this.deps.toolDiscovery &&
            sanitizedTask &&
            !remoteForbidden &&
            ceiling?.length !== 0
          ) {
            const discovery = await this.deps.toolDiscovery.discoverForTask({
              query: sanitizedTask,
              runId,
              stepId: step.id,
              signal,
            });
            discoveredIds.push(...discovery.registered);
            if (discovery.warning) {
              await ctx.log('warn', 'Tool discovery failed closed: ' + discovery.warning);
            }
            if (discovery.skipped.length > 0) {
              await ctx.log(
                'info',
                'Skipped ' + discovery.skipped.length + ' unclassified provider tool(s).',
              );
            }
          } else if (this.deps.toolDiscovery && (!sanitizedTask || remoteForbidden)) {
            await ctx.log('info', 'Skipped remote tool discovery for sensitive task state.');
          }

          // Resolve all candidates through the trusted registry, then use Jev's
          // typed family/tool decisions before Hermes can start its inner loop.
          let availableTools = [...new Set([...spec.availableTools, ...discoveredIds])];
          // Exact candidate set (id -> version) a frozen route must match.
          let candidateVersions: Record<string, string> | undefined;
          if (ceiling !== undefined)
            availableTools = availableTools.filter((id) => ceiling.includes(id));
          if (this.deps.toolRegistry) {
            const resolved = await this.deps.toolRegistry.resolve(availableTools);

            // SAY SO WHEN A CANDIDATE DOES NOT EXIST. `resolve` drops unknown
            // ids silently, and `eligibleTaskTools` drops unavailable ones, so
            // a graph naming tools that were renamed or never registered hands
            // the harness an EMPTY toolset and looks, from the outside, like
            // the harness simply failing at its job. That is exactly what
            // happened with `web.search`/`docs.read` in demo.graph: 0 of 7
            // resolved, Hermes fell back to its own tools, and the only symptom
            // was three `browser_exec` failures in a row.
            //
            // Warn, do not throw: an unknown candidate is an authoring mistake
            // to surface, not a reason to abort a run that may still succeed on
            // the tools that did resolve.
            const unknown = availableTools.filter(
              (id) => !resolved.some((descriptor) => descriptor.id === id),
            );
            if (unknown.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" named ' +
                  unknown.length +
                  ' tool(s) that are not in the registry, so they were dropped: ' +
                  unknown.join(', ') +
                  '. Use the ids from GET /api/tools.',
              );
            }

            const eligible = eligibleTaskTools(resolved, decisionState);
            const mockTwins = mockTwinsOfLiveTools(eligible);
            const descriptors = eligible.filter((descriptor) => !mockTwins.includes(descriptor));

            // Report WHY each tool was dropped, separately. Lumping these
            // together sends you hunting the wrong cause: the first time this
            // fired it blamed data labels when the real reason was that every
            // browser tool registers as `unavailable` outside live mode.
            const unavailable = resolved.filter(
              (descriptor) =>
                descriptor.availability !== 'available' ||
                descriptor.baselineEffect === 'unknown' ||
                descriptor.simulated === true,
            );
            const mislabelled = resolved.filter(
              (descriptor) =>
                !unavailable.includes(descriptor) &&
                !eligible.some((kept) => kept.id === descriptor.id),
            );
            if (mockTwins.length > 0) {
              await ctx.log(
                'info',
                'Subtask "' +
                  spec.label +
                  '" left out ' +
                  mockTwins.length +
                  ' mocked duplicate(s) of live tools: ' +
                  mockTwins.map((descriptor) => descriptor.id).join(', '),
              );
            }
            if (unavailable.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" dropped ' +
                  unavailable.length +
                  ' tool(s) as unavailable or unclassified: ' +
                  unavailable
                    .map((descriptor) => descriptor.id + ' (' + descriptor.availability + ')')
                    .join(', '),
              );
            }
            if (mislabelled.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" dropped ' +
                  mislabelled.length +
                  ' tool(s) whose data labels do not cover this task (' +
                  decisionState.dataLabels.join(', ') +
                  '): ' +
                  mislabelled.map((descriptor) => descriptor.id).join(', '),
              );
            }

            if (descriptors.length === 0 && availableTools.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" has NO usable tools after resolution. The harness will run as a ' +
                  'tool-less turn; any tool it appears to call is its own, not ours.',
              );
            }

            availableTools = descriptors.map((descriptor) => descriptor.id);
            candidateVersions = toolVersions(descriptors);
          }

          // Jev makes the one task-level capability decision. Its exposedTools
          // result is the hard grant passed to Hermes, not advisory context.
          // The model gateway may narrow a single turn, but can never widen it.
          const decider = provider('decision');
          const routeCacheKey =
            !allToolsBaseline && decisionState.sanitizedForRemote && availableTools.length > 0
              ? JSON.stringify({
                  task: decisionState.taskSummary,
                  labels: decisionState.dataLabels,
                  tools: availableTools,
                  ceiling,
                })
              : undefined;
          const cachedRoute = routeCacheKey ? this.getCachedTaskRoute(routeCacheKey) : undefined;
          // A route frozen when the graph was saved replaces the Jev call, and
          // only where that call would have happened: never for the baseline
          // arm, never for state the live decider may not see.
          const mayAskDecider = decider.mode !== 'live' || decisionState.sanitizedForRemote;
          const frozenRoute =
            !allToolsBaseline && mayAskDecider && spec.compiledRoute && candidateVersions
              ? usableAgentRoute(spec.compiledRoute.entry, {
                  nodeHash: spec.compiledRoute.nodeHash,
                  decisionMode: decider.mode,
                  tools: candidateVersions,
                })
              : undefined;
          // The all-tools baseline deliberately skips Jev: it IS the "no
          // routing" arm. This is an explicit opt-in, not a failure path, so
          // the fail-closed rule below (failure never exposes all tools) is
          // untouched.
          const routed = allToolsBaseline
            ? {
                ok: true as const,
                data: {
                  privacy: decisionState.sanitizedForRemote
                    ? ('cloud' as const)
                    : ('private' as const),
                  intelligence: 'high' as const,
                  privacyConfidence: 1,
                  intelligenceConfidence: 1,
                  modelTier: 'frontier' as const,
                  exposedTools: availableTools,
                  confidence: 1,
                  rationale: 'Baseline arm: every eligible tool exposed, frontier model, no Jev.',
                },
              }
            : frozenRoute
              ? { ok: true as const, data: frozenRoute }
              : cachedRoute
                ? { ok: true as const, data: cachedRoute }
                : mayAskDecider
                  ? await decider.route(
                      { task: decisionState.taskSummary, availableTools },
                      buildCallContext({ stepId: step.id, policyRule: 'subtask-routing' }),
                    )
                  : null;
          if (routeCacheKey && routed?.ok && !frozenRoute)
            this.cacheTaskRoute(routeCacheKey, routed.data);
          // No usable frozen route: keep what Jev decided for the next run.
          if (
            routed?.ok &&
            !frozenRoute &&
            !allToolsBaseline &&
            spec.compiledRoute &&
            spec.nodeId &&
            candidateVersions &&
            this.deps.recordCompiledDecision
          ) {
            await this.deps
              .recordCompiledDecision(spec.compiledRoute.graphId, spec.nodeId, {
                kind: 'agent_route',
                nodeHash: spec.compiledRoute.nodeHash,
                decisionMode: decider.mode,
                tools: candidateVersions,
                privacy: routed.data.privacy,
                intelligence: routed.data.intelligence,
                privacyConfidence: routed.data.privacyConfidence,
                intelligenceConfidence: routed.data.intelligenceConfidence,
                modelTier: routed.data.modelTier,
                exposedTools: routed.data.exposedTools.filter((id) => availableTools.includes(id)),
                confidence: routed.data.confidence,
                ...(routed.data.rationale ? { rationale: routed.data.rationale } : {}),
                source: 'run',
                at: nowIso(),
              })
              .catch(() => undefined);
          }
          if (routed && !routed.ok && availableTools.length > 0) {
            // Without this the run just shows an agent that never calls a
            // tool; the reason (e.g. a Jev AUTH failure) was invisible.
            await ctx.log(
              'warn',
              'Subtask "' +
                spec.label +
                '" runs with NO tools: Jev routing failed (' +
                routed.error.code +
                '): ' +
                routed.error.message,
            );
          }

          // FAIL CLOSED, not open — docs/agentos-design.md is explicit:
          // "Routing... failures fail closed; failure never exposes all
          // tools." A Jev outage must narrow what the harness can touch, not
          // widen it. The task still runs (as a tool-less LLM turn) rather
          // than aborting outright — that's a judgment call, not a spec
          // requirement, and worth revisiting if it turns out to be wrong.
          const routeResult = routed?.ok
            ? {
                ...routed.data,
                exposedTools: routed.data.exposedTools.filter((toolId) =>
                  availableTools.includes(toolId),
                ),
              }
            : {
                privacy: 'private' as const,
                intelligence: 'high' as const,
                privacyConfidence: 0,
                intelligenceConfidence: 0,
                modelTier: 'local' as const,
                exposedTools: [],
                confidence: 0,
                rationale:
                  (routed
                    ? 'Routing failed (' + routed.error.code + ')'
                    : 'Remote routing was ineligible for unsanitized state') +
                  '; using safe local execution with no tools.',
              };

          const decision: ScheduleDecision = {
            id: newId('sch'),
            runId,
            stepId: step.id,
            requestedCapability: 'agent.runtime',
            selectedProvider: providerFor('agent.runtime'),
            privacy: routeResult.privacy,
            intelligence: routeResult.intelligence,
            privacyConfidence: routeResult.privacyConfidence,
            intelligenceConfidence: routeResult.intelligenceConfidence,
            modelTier: routeResult.modelTier,
            availableTools,
            exposedTools: priorState?.taskToolIds
              ? routeResult.exposedTools.filter((id) => priorState.taskToolIds!.includes(id))
              : routeResult.exposedTools,
            confidence: routeResult.confidence,
            escalated: false,
            rule: allToolsBaseline
              ? 'baseline-all-tools-frontier'
              : frozenRoute
                ? 'compiled-graph-route'
                : routed?.ok
                  ? 'jev-routed'
                  : 'route-failed-safe-local',
            at: nowIso(),
          };
          await store.createScheduleDecision(decision);
          await bus.emit(runId, { type: 'schedule.decided', decision });

          // 2. Register AgentOS's canonical state BEFORE Hermes can make its
          // first model request. The model gateway resolves this active record
          // and never treats Hermes's internal transcript as canonical state.
          const sessionInput = {
            runId,
            stepId: step.id,
            harness: 'hermes',
            objective: spec.goal,
            sanitizedObjective:
              spec.sanitizedGoal ??
              (labels.every((label) => label === 'public') ? spec.goal : undefined),
            dataLabels: labels,
            budget: { stepsRemaining: 1 },
            candidateToolIds: availableTools,
            taskToolIds: decision.exposedTools,
            toolCeiling: ceiling,
            boundBrowserSessionId,
            contextScopeId: spec.contextScope?.id,
            ...(allToolsBaseline ? { pinnedCostTier: 'frontier' as const } : {}),
            // The frozen route's tier picks the model without a per-task Jev call.
            ...(frozenRoute ? { preferredModelTier: frozenRoute.modelTier } : {}),
          };
          const sessionState = priorState
            ? await sessionStateService.patch(priorState.id, {
                ...sessionInput,
                status: 'created',
                latestCheckpoint: undefined,
              })
            : await sessionStateService.create(sessionInput);
          sessionStateId = sessionState.id;
          await sessionStateService.appendContext(sessionState.id, [
            {
              role: 'user',
              summary: 'Graph task inputs updated for ' + (spec.nodeId ?? step.id) + '.',
              dataLabels: labels,
              provenance: spec.contextProvenance ?? [],
            },
          ]);
          const begun = await sessionStateService.beginTurn(sessionState.id);

          // 3. Run the agent ONCE, with only the tools Jev exposed.
          //
          // An agent task is a single Hermes run. Its result goes to Jev's
          // completion judge, the verdict is recorded, and the graph moves on
          // whatever the verdict is: AgentOS never re-prompts the agent for
          // another turn. Re-prompting on `continue`, on a low-confidence `done`
          // and after a `blocked` pause is what kept restarting research that had
          // already finished. The one exception is a run that never happened --
          // the agent or its model could not be reached -- which is started
          // again, at most `networkRetries` times.
          const runtime = provider('agent.runtime');
          const requiresToolAction = requiresExternalAction(spec.goal);
          // Human time -- an approval under review, a pause -- is not harness
          // execution time, so it never counts against maxDurationMs. Counting
          // it made maxDurationMs an unannounced approval timeout: a run whose
          // click waited five minutes for review failed as "did not reach
          // verified completion" the moment the budget ran out.
          let humanWaitMs = 0;
          const holdForHuman = async () => {
            const heldAt = Date.now();
            await this.holdWhilePaused(runId, signal);
            humanWaitMs += Date.now() - heldAt;
          };

          const launch = async (): Promise<{ taskId: string } | { unreachable: string }> => {
            if (previous) {
              const continued = await runtime.continueTask(
                previous.taskId,
                { instruction: spec.goal, context: spec.context },
                buildCallContext({ stepId: step.id, policyRule: 'graph-context-continuation' }),
              );
              return continued.ok
                ? { taskId: previous.taskId }
                : { unreachable: 'could not continue the agent: ' + continued.error.message };
            }
            const started = await runtime.startTask(
              { goal: spec.goal, context: spec.context, tools: decision.exposedTools },
              {
                ...buildCallContext({ stepId: step.id, policyRule: 'jev-filtered-toolset' }),
                sessionStateId: sessionState.id,
                gatewayCredentials: sessionStateService.issueGatewayCredentials(sessionState.id),
              },
            );
            return started.ok
              ? { taskId: started.data.taskId }
              : { unreachable: 'could not start the agent: ' + started.error.message };
          };

          /**
           * The error that ended a run whose LAST model call failed for a
           * network reason. Hermes retries a failed call itself and, once it
           * gives up, ends the run with the error as its "answer"; that run
           * never got to work, so it is unreachable rather than finished.
           */
          const unreachableModel = async (sinceSeq: number): Promise<string | undefined> => {
            const calls = (await store.eventsSince(runId, sinceSeq)).flatMap(({ event }) =>
              event.type === 'model.lifecycle' &&
              event.lifecycle.stepId === step.id &&
              event.lifecycle.phase !== 'requested'
                ? [event.lifecycle]
                : [],
            );
            const last = calls.at(-1);
            const message = last?.phase === 'failed' ? (last.error?.message ?? '') : '';
            return isNetworkFailure(message) ? message : undefined;
          };

          /** Poll one Hermes run until it answers, is stopped by a budget, or proves unreachable. */
          const awaitRun = async (taskId: string, sinceSeq: number): Promise<AgentRunOutcome> => {
            let pollAttempts = 0;
            let partial: unknown;
            let partialToolCalls: AgentToolCall[] = [];
            const stopped = (endedBy: AgentRunEnd): AgentRunOutcome => ({
              kind: 'stopped',
              endedBy,
              result: partial ?? null,
              toolCalls: partialToolCalls,
            });
            while (pollAttempts < maxPolls) {
              if (signal.aborted) throw new Error('Run aborted while awaiting agent task');

              if (
                maxDurationMs !== undefined &&
                Date.now() - startedAt - humanWaitMs >= maxDurationMs
              ) {
                await ctx.log(
                  'warn',
                  'Agent task ' + taskId + ' hit its maxDurationMs budget; stopping it.',
                );
                return stopped('duration-budget');
              }
              if (maxFailedToolCalls !== undefined) {
                const failedCount = (await store.eventsSince(runId, 0)).filter(
                  ({ event }) =>
                    event.type === 'tool.lifecycle' &&
                    event.lifecycle.stepId === step.id &&
                    event.lifecycle.phase === 'failed',
                ).length;
                if (failedCount > maxFailedToolCalls) {
                  await ctx.log(
                    'warn',
                    'Agent task ' +
                      taskId +
                      ' exceeded its maxFailedToolCalls budget; stopping it.',
                  );
                  return stopped('failed-tool-budget');
                }
              }

              const polled = await runtime.pollTask(
                taskId,
                buildCallContext({ stepId: step.id, policyRule: 'jev-filtered-toolset' }),
              );
              if (!polled.ok) return { kind: 'unreachable', reason: polled.error.message };
              if (polled.data.status === 'failed') {
                return {
                  kind: 'unreachable',
                  reason: 'the agent session failed: ' + (polled.data.log?.at(-1) ?? 'no detail'),
                };
              }
              if (polled.data.status === 'done') {
                const modelFailure = await unreachableModel(sinceSeq);
                if (modelFailure)
                  return {
                    kind: 'unreachable',
                    reason: 'its model was unreachable: ' + modelFailure,
                  };
                return {
                  kind: 'answered',
                  endedBy: 'answer',
                  result: polled.data.result ?? null,
                  toolCalls: polled.data.toolCalls ?? [],
                };
              }
              if (polled.data.partial !== undefined) partial = polled.data.partial;
              if (polled.data.toolCalls) partialToolCalls = polled.data.toolCalls;

              // Human review time is not harness execution time. Keep polling
              // while the exact action is awaiting approval without consuming
              // the bounded Hermes poll budget or its wall-clock budget.
              const awaitingHuman = (await store.getRun(runId))?.status === 'awaiting_approval';
              if (!awaitingHuman) pollAttempts += 1;
              const sleptAt = Date.now();
              await sleep(pollIntervalMs);
              if (awaitingHuman) humanWaitMs += Date.now() - sleptAt;
            }
            await ctx.log(
              'warn',
              'Agent task ' +
                taskId +
                ' was still working when its poll budget ran out (' +
                Math.round((maxPolls * pollIntervalMs) / 1000).toString() +
                's); stopping it. Raise maxDurationMs or maxPolls on the node.',
            );
            return stopped('poll-budget');
          };

          let taskId: string | undefined;
          let attempts = 0;
          const runAgent = async (): Promise<FinishedAgentRun> => {
            for (;;) {
              attempts += 1;
              // The pause checkpoint. An agent task is one `ctx.step`, so
              // without this a paused run would still start Hermes.
              await holdForHuman();
              if (signal.aborted) throw new Error('Run aborted while awaiting agent task');
              const turn =
                attempts === 1
                  ? begun.turn
                  : (await sessionStateService.beginTurn(sessionState.id)).turn;
              const sinceSeq = (await store.eventsSince(runId, 0)).at(-1)?.seq ?? 0;
              const launched = await launch();
              let outcome: AgentRunOutcome;
              if ('taskId' in launched) {
                taskId = launched.taskId;
                activeTaskId = taskId;
                await sessionStateService.bindHarnessSession(sessionState.id, taskId);
                if (spec.contextScope)
                  contextScopes.set(spec.contextScope.id, {
                    sessionStateId: sessionState.id,
                    taskId,
                  });
                await bus.emit(runId, {
                  type: 'harness.turn',
                  turn: {
                    id: newId('turn'),
                    runId,
                    sessionId: taskId,
                    turnId: taskId + ':' + turn,
                    phase: 'started',
                    at: nowIso(),
                  },
                });
                outcome = await awaitRun(taskId, sinceSeq);
              } else {
                outcome = { kind: 'unreachable', reason: launched.unreachable };
              }
              if (outcome.kind !== 'unreachable') return outcome;

              if (attempts > networkRetries) {
                throw new Error(
                  'Agent task "' +
                    spec.label +
                    '" could not reach its agent after ' +
                    attempts.toString() +
                    ' attempt(s): ' +
                    outcome.reason,
                );
              }
              await ctx.log(
                'warn',
                'Agent task "' +
                  spec.label +
                  '" could not reach its agent (' +
                  outcome.reason +
                  '). Starting it again, retry ' +
                  attempts.toString() +
                  ' of ' +
                  networkRetries.toString() +
                  ': the only case in which AgentOS runs an agent twice.',
              );
              // A fresh run needs the old process gone and its gateway tokens
              // dead, so nothing still in flight can act inside the new turn.
              // A shared context is re-prompted in place instead: replacing it
              // would drop the transcript the scope exists to keep.
              if (!previous) {
                if (taskId) {
                  await runtime
                    .cancelTask(
                      taskId,
                      buildCallContext({
                        stepId: step.id,
                        policyRule: 'unreachable-agent-restart',
                      }),
                    )
                    .catch(() => undefined);
                  activeTaskId = undefined;
                }
                sessionStateService.revokeGatewayCredentials(sessionState.id);
              }
              await sleep(attempts * 2000);
            }
          };
          const outcome = await runAgent();

          const toolCalls = outcome.toolCalls;
          const finalResult = outcome.result;
          if (outcome.kind === 'stopped' && taskId) {
            // Stop Hermes where it is. What it had said so far is its result.
            await runtime.cancelTask(
              taskId,
              buildCallContext({ stepId: step.id, policyRule: 'agent-budget-stop' }),
            );
            if (spec.contextScope) contextScopes.delete(spec.contextScope.id);
          }
          await bus.emit(runId, {
            type: 'harness.turn',
            turn: {
              id: newId('turn'),
              runId,
              sessionId: taskId ?? step.id,
              turnId: (taskId ?? step.id) + ':' + (begun.turn + attempts - 1).toString(),
              phase: outcome.kind === 'answered' ? 'quiescent' : 'cancelled',
              payload: toJson({ toolCallCount: toolCalls.length, endedBy: outcome.endedBy }),
              at: nowIso(),
            },
          });

          // 4. Jev judges the run once. Its verdict is recorded and followed as
          //    given; whatever it is, the graph continues with this result.
          const hasResult = harnessResultPresent(finalResult);
          // Harness tool-result messages include provider errors as well as
          // successes. Only the broker's authoritative lifecycle event proves
          // that the exact action passed policy, approval, execution, and
          // verification; never infer success from a role=tool transcript entry.
          const successfulToolCalls = (await store.eventsSince(runId, 0)).filter(
            ({ event }) =>
              event.type === 'tool.lifecycle' &&
              event.lifecycle.stepId === step.id &&
              event.lifecycle.phase === 'succeeded',
          ).length;
          const hasSuccessfulToolResult = successfulToolCalls > 0;
          const verifiedOutcome = hasResult && (!requiresToolAction || hasSuccessfulToolResult);
          const outstandingRequirements = [
            ...(!hasResult ? ['agent-result-missing'] : []),
            ...(requiresToolAction && !hasSuccessfulToolResult
              ? ['required-tool-action-not-completed']
              : []),
          ];
          const isPublic = labels.every((label) => label === 'public');
          const checkpoint: SessionCheckpoint = {
            runId,
            objective: spec.goal,
            sanitizedObjective: spec.sanitizedGoal ?? (isPublic ? spec.goal : undefined),
            steps: [
              {
                id: step.id + ':run',
                label: spec.label,
                status: outcome.kind === 'answered' ? 'succeeded' : 'failed',
                required: true,
                sanitizedSummary: hasResult
                  ? completionEvidence(finalResult, successfulToolCalls, isPublic)
                  : outcome.kind === 'answered'
                    ? 'Harness produced no result.'
                    : 'Harness was stopped by its ' + outcome.endedBy + ' before it answered.',
              },
            ],
            artifacts: [
              {
                id: step.id + ':result',
                kind: 'harness_result',
                required: true,
                verified: verifiedOutcome,
                dataLabels: labels,
                sanitizedSummary: verifiedOutcome
                  ? 'The required harness result and tool action are present and verified.'
                  : undefined,
              },
            ],
            verifications: [
              {
                id: step.id + ':result-present',
                passed: hasResult,
                required: true,
                reasonCode: hasResult ? 'result-present' : 'result-missing',
              },
              ...(requiresToolAction
                ? [
                    {
                      id: step.id + ':tool-action-completed',
                      passed: hasSuccessfulToolResult,
                      required: true,
                      reasonCode: hasSuccessfulToolResult
                        ? 'required-tool-action-completed'
                        : 'required-tool-action-not-completed',
                    },
                  ]
                : []),
            ],
            outstandingRequirements,
            pendingApprovalIds: [],
            dataLabels: labels,
            // No further turns exist, and Jev is told so.
            budget: { stepsRemaining: 0 },
            at: nowIso(),
          };
          await sessionStateService.checkpoint(sessionState.id, checkpoint);
          const completionDecision = await judgeCheckpoint(checkpoint, step.id);
          if (!(completionDecision.status === 'done' && completionDecision.verified)) {
            const reasons = [
              ...completionDecision.verificationFailures,
              ...completionDecision.reasonCodes,
            ];
            await ctx.log(
              completionDecision.status === 'done' ? 'info' : 'warn',
              'Jev judged agent task "' +
                spec.label +
                '" `' +
                completionDecision.status +
                '`' +
                (reasons.length > 0 ? ' (' + [...new Set(reasons)].join(', ') + ')' : '') +
                '. The agent is not run again; the graph continues with its result.',
            );
          }

          // A shared context stays available to the next node in its scope
          // whatever the verdict, so the rest of the graph can still run.
          retainContext = Boolean(spec.contextScope) && outcome.kind === 'answered';
          await sessionStateService.setStatus(
            sessionState.id,
            retainContext
              ? 'quiescent'
              : completionDecision.status === 'done'
                ? 'completed'
                : 'blocked',
          );
          if (!retainContext && outcome.kind === 'answered' && taskId)
            await runtime.cancelTask(
              taskId,
              buildCallContext({ stepId: step.id, policyRule: 'completed-session-close' }),
            );

          // 5. Post-hoc audit. The runtime ran its own loop internally, so this
          //    is our only visibility into what it touched — recorded into the
          //    SAME ledger real provider calls go through, so "every outbound
          //    call is logged" still holds, just after the fact rather than
          //    gated in real time.
          for (const call of toolCalls) {
            const egress = buildEgressEvent(
              {
                id: newId('egr'),
                runId,
                stepId: step.id,
                providerId: 'hermes',
                op: 'internal.tool_call:' + call.tool,
                destination: 'hermes-internal://' + call.tool,
                policyRule: 'reported-post-hoc-by-hermes',
              },
              call.at,
            );
            await store.appendEgress(egress);
            await bus.emit(runId, { type: 'egress.logged', egress });
          }

          // `succeeded` means the agent ran and the graph moves on; Jev's verdict
          // on the result is the `completionDecision` beside it.
          await this.upsertStep(step.id, {
            status: 'succeeded',
            output: toJson({
              resultPresent: harnessResultPresent(finalResult),
              toolCallCount: toolCalls.length,
              toolCalls,
              completionDecision,
              endedBy: outcome.endedBy,
              attempts,
            }),
            endedAt: nowIso(),
          });

          return {
            result: finalResult,
            scheduleDecision: decision,
            toolCalls,
            completionDecision,
            dataLabels: (await sessionStateService.get(sessionState.id))?.dataLabels ?? labels,
          };
        } catch (err) {
          if (sessionStateId) {
            const state = await sessionStateService.get(sessionStateId);
            if (state && !['completed', 'blocked', 'cancelled'].includes(state.status)) {
              await sessionStateService.setStatus(
                sessionStateId,
                signal.aborted ? 'cancelled' : 'failed',
              );
            }
          }
          await this.upsertStep(step.id, {
            status: 'failed',
            error: { code: 'AGENT_TASK_FAILED', message: (err as Error).message },
            endedAt: nowIso(),
          });
          throw err;
        } finally {
          if (activeTaskId && !retainContext) {
            await provider('agent.runtime')
              .cancelTask(
                activeTaskId,
                buildCallContext({ stepId: step.id, policyRule: 'task-finally-close' }),
              )
              .catch(() => undefined);
          }
          releaseScope?.();
        }
      },
    };

    return ctx;
  }

  private getCachedTaskRoute(key: string): CachedTaskRoute | undefined {
    const cached = this.taskRouteCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
      if (cached) this.taskRouteCache.delete(key);
      return undefined;
    }
    return { ...cached.data, exposedTools: [...cached.data.exposedTools] };
  }

  private cacheTaskRoute(key: string, data: CachedTaskRoute): void {
    if (this.taskRouteCache.size >= 128) {
      const oldest = this.taskRouteCache.keys().next().value;
      if (oldest) this.taskRouteCache.delete(oldest);
    }
    this.taskRouteCache.set(key, {
      data: { ...data, exposedTools: [...data.exposedTools] },
      expiresAt: Date.now() + 5 * 60_000,
    });
  }
}

/** A live Hermes turn that ended on a tool call reports `{ text: '' }`: no answer. */
function harnessResultPresent(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === 'string') return result.trim().length > 0;
  if (typeof result === 'object' && 'text' in result && typeof result.text === 'string')
    return result.text.trim().length > 0;
  return true;
}

/**
 * What the completion judge is told about a finished turn. A bare "Hermes
 * produced a result" gave Jev nothing to judge, so it guessed `continue` at ~0.5
 * confidence and the run kept searching. The excerpt only goes out when every
 * data label is public; otherwise the judge gets size and tool-call counts only.
 */
function completionEvidence(result: unknown, toolCalls: number, isPublic: boolean): string {
  let text: string;
  if (typeof result === 'string') text = result;
  else if (
    result &&
    typeof result === 'object' &&
    'text' in result &&
    typeof result.text === 'string'
  )
    text = result.text;
  else text = JSON.stringify(result) ?? '';
  const head =
    'Hermes returned a ' +
    text.length.toString() +
    '-character answer after ' +
    toolCalls.toString() +
    ' successful tool call(s).';
  return isPublic && text ? head + ' Answer excerpt: ' + text.slice(0, 1500) : head;
}

type AgentToolCall = { tool: string; args?: unknown; at: string };
type AgentRunEnd = 'answer' | 'duration-budget' | 'poll-budget' | 'failed-tool-budget';

/** A Hermes run that happened: it answered, or a budget stopped it. */
type FinishedAgentRun = {
  kind: 'answered' | 'stopped';
  endedBy: AgentRunEnd;
  /** The final message, or for a stopped run whatever it had said so far. */
  result: unknown;
  toolCalls: AgentToolCall[];
};

/** How one launch ended. Only `unreachable` ever leads to a second run. */
type AgentRunOutcome = FinishedAgentRun | { kind: 'unreachable'; reason: string };

/**
 * Transport-level failures: the network, a provider that is down or
 * overloaded, a connection that closed. These mean the agent never got to
 * work. A refused request, a bad route or a policy error is NOT one of these,
 * and retrying it would only repeat it.
 */
function isNetworkFailure(message: string): boolean {
  return /\b(?:ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_\w+)\b|socket hang up|fetch failed|network|connection (?:error|closed|reset|refused|lost)|timed out|timeout|overloaded|rate.?limit|too many requests|service unavailable|bad gateway|\b(?:429|500|502|503|504|529)\b/i.test(
    message,
  );
}

function requiresExternalAction(goal: string): boolean {
  return /^(?:please\s+)?(?:send|email|message|reply|forward|post|publish|submit|create|update|delete|remove|invite|schedule|book|purchase|pay|transfer)\b/i.test(
    goal.trim(),
  );
}

/** Best-effort conversion to a storable Json value. Never throws. */
function toJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}
