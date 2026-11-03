/**
 * Live Zephyr arms of the coding benchmark: Claude Code (claude-agent-acp) under
 * Zephyr, with the arm's levers. Spends real money; the CLI runs it only with
 * `--mode live --yes-spend`, and the offline check drives it with a fake ACP peer and
 * a fake upstream.
 *
 * Each run gets its own in-process Zephyr stack, bound to the benchmark's temp repo:
 *
 *   - a worktree of that repo (git), checkpointed per turn, which the hidden test runs in;
 *   - the hook endpoint and the permission bridge (every native tool call is authorized);
 *   - the Anthropic Messages gateway, with a per-run token: the tokens and cost
 *     reported are what the gateway's ledger metered, not what the agent said;
 *   - when L1 is on, the MCP gateway serving the shaped tools through the ToolBroker.
 *
 * Nothing here is shared with the dev server's singletons, so a benchmark can run
 * next to a running board without touching its store, tokens or worktrees.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodingTokens, RunEvent } from '@htn/shared';
import type { AgentOutcome, CodingAgent, CodingAgentInput } from '../core/benchmark/coding/index.js';
import { RunBus } from '../core/bus.js';
import { createContextPackBuilder } from '../core/context/index.js';
import type { DecisionService } from '../core/decisions/service.js';
import { HookTokenStore } from '../core/hooks/hookTokens.js';
import type { KnowledgeLoader } from '../core/learning/relevance.js';
import {
  AnthropicMessagesGateway,
  fetchUpstream,
  type AnthropicUpstream,
} from '../core/modelGateway/messages.js';
import { GatewayRunTokenStore } from '../core/modelGateway/runTokens.js';
import { SessionStateService } from '../core/sessions/service.js';
import type { ToolApprovalGate } from '../core/tools/approval.js';
import { ToolBroker } from '../core/tools/broker.js';
import { InMemoryToolExecutorRegistry } from '../core/tools/executors.js';
import { InMemoryToolRegistry } from '../core/tools/registry.js';
import { registerShapedTools, SHAPED_TOOL_IDS } from '../core/tools/shaped/index.js';
import { RunWorktrees } from '../core/tools/shaped/worktrees.js';
import type { AcpHarnessConfig } from '../providers/_acp/config.js';
import { anthropicBaseUrl, claudeCodeHarness, createClaudeCodeRuntime } from '../providers/claudecode/live.js';
import { createLiveGitWorkspaces } from '../providers/git/live.js';
import { createMemoryStore } from '../store/memory.js';
import { createAnthropicMessagesRouter } from '../api/anthropicMessages.routes.js';
import { createHarnessCallbackRouter } from '../api/hooks.routes.js';
import { createMcpGatewayRouter } from '../api/mcpGateway.js';
import { createWorkspacesService } from './workspaces.service.js';

const SHAPED_IDS: string[] = Object.values(SHAPED_TOOL_IDS);

export interface SupervisedAgentOptions {
  /** claude-agent-acp's entry (`dist/index.js`) or executable. Ignored when `harness` is given. */
  binary?: string;
  /** Model for Claude Code (ANTHROPIC_MODEL); pass the vanilla arm's so both arms match. */
  model?: string;
  /** Test seam: the ACP harness to launch, per run (the offline check uses a fake peer). */
  harness?: (input: CodingAgentInput, defaults: AcpHarnessConfig) => AcpHarnessConfig;
  /** Where the gateway forwards `/v1/messages`. Default: Anthropic with ANTHROPIC_API_KEY. */
  upstream?: AnthropicUpstream;
  anthropicBaseUrl?: string;
  anthropicApiKey?: string;
  /** Jev, for the context pack's file ranking and the broker's authorization. */
  decisions: DecisionService;
  /** Step 8 learned knowledge; used only by arms with `skills: true`. */
  knowledge?: () => KnowledgeLoader;
  /** Shaped-tool command overrides (the check pins them; live uses the repo's scripts). */
  shapedOverrides?: Parameters<typeof registerShapedTools>[2] extends infer O
    ? O extends { overrides?: infer V }
      ? V
      : never
    : never;
  /** Per-run limit; the run is cancelled and counted as a failure. Default 15 minutes. */
  timeoutMs?: number;
  /** Per-run spend cap the gateway enforces (USD cents). Default 300 (= $3). */
  budgetCents?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

const sumTokens = (u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}): CodingTokens => ({
  input: u.inputTokens,
  output: u.outputTokens,
  cacheRead: u.cacheReadInputTokens,
  cacheWrite: u.cacheCreationInputTokens,
});

/** Arms (b) to (d): Claude Code under Zephyr with the arm's levers. */
export function supervisedClaudeAgent(opts: SupervisedAgentOptions): CodingAgent {
  const log = opts.log ?? ((m: string) => console.warn('[bench] ' + m));
  return async (input): Promise<AgentOutcome> => {
    const { task, arm, rep, repoDir, signal } = input;
    if (!arm.zephyr) throw new Error('supervisedClaudeAgent runs only Zephyr arms, not ' + arm.id);
    const runId = `run_bench_${task.id}_${arm.id}_${rep}`.replace(/[^\w-]/g, '_');
    const stepId = 'stp_' + runId.slice(4);

    // ---- per-run Zephyr stack ------------------------------------------------
    const memory = createMemoryStore();
    const events: RunEvent[] = [];
    const bus = new RunBus(async (id, event) => {
      events.push(event);
      return memory.appendEvent(id, event);
    });
    const emit = (id: string, event: RunEvent) => bus.emit(id, event);
    const sessions = new SessionStateService(memory, bus);
    let approvals = 0;
    const gate: ToolApprovalGate = {
      // The benchmark is unattended: what policy sends to a human is approved and
      // counted, the way the vanilla arm's acceptEdits mode lets it through.
      async request() {
        approvals++;
        return { approvalId: 'apr_bench_' + approvals };
      },
    };
    const worktrees = new RunWorktrees();
    const registry = new InMemoryToolRegistry();
    const executors = new InMemoryToolExecutorRegistry();
    registerShapedTools(registry, executors, {
      worktrees,
      ...(opts.shapedOverrides ? { overrides: opts.shapedOverrides } : {}),
    });
    const broker = new ToolBroker(registry, executors, opts.decisions, sessions, bus, { approvalGate: gate });
    const hookTokens = new HookTokenStore();
    const gatewayTokens = new GatewayRunTokenStore();
    const gateway = new AnthropicMessagesGateway({
      upstream:
        opts.upstream ??
        fetchUpstream({
          baseUrl: opts.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
          apiKey: opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
        }),
      tokens: gatewayTokens,
      emit,
    });

    const app = express();
    app.use('/v1', createAnthropicMessagesRouter(() => gateway));
    app.use(express.json({ limit: '8mb' }));
    app.use('/api', createHarnessCallbackRouter({ tokens: hookTokens, store: memory, emit, log: () => {} }));
    app.use('/mcp', createMcpGatewayRouter({ registry, broker, sessions }));
    const server = await new Promise<import('node:http').Server>((resolvePromise) => {
      const s = app.listen(0, '127.0.0.1', () => resolvePromise(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const workspacesDir = await mkdtemp(join(tmpdir(), 'zephyr-bench-ws-'));
    const gitWorkspaces = createLiveGitWorkspaces({ repoRoot: repoDir, workspacesDir });
    const workspaces = createWorkspacesService(() => gitWorkspaces as never);

    const l1 = arm.levers.shapedTools;
    const base0 = claudeCodeHarness({ ...(opts.binary ? { binary: opts.binary } : {}), mcp: l1 });
    const defaults = opts.model
      ? { ...base0, env: (c: Parameters<typeof base0.env>[0]) => ({ ...base0.env(c), ANTHROPIC_MODEL: opts.model! }) }
      : base0;
    const runtime = createClaudeCodeRuntime({
      harness: opts.harness ? opts.harness(input, defaults) : defaults,
      workspaces: async () => workspaces,
      apiBaseUrl: base,
      gatewayUrl: anthropicBaseUrl(base),
      ...(l1 ? { mcpUrl: base + '/mcp' } : {}),
      tokens: hookTokens,
      gatewayTokens,
      gatewayBudget: { maxCostCents: opts.budgetCents ?? 300 },
      approvals: async () => gate,
      emit,
      worktrees,
      contextPack: createContextPackBuilder({
        decisions: opts.decisions,
        sessions,
        emit,
        ...(arm.skills && opts.knowledge ? { knowledge: opts.knowledge() } : {}),
      }),
      stderr: 'ignore',
      log: (m) => log(runId + ': ' + m),
    });

    let taskId: string | undefined;
    const release = async () => {
      if (taskId) await runtime.cancelTask(taskId, { runId, policyRule: 'benchmark:coding:live' }).catch(() => {});
      taskId = undefined;
      await workspaces.finish(runId, 'succeeded').catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await rm(workspacesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    };

    try {
      const session = await sessions.create({
        runId,
        stepId,
        harness: 'claudecode',
        objective: task.prompt,
        sanitizedObjective: task.prompt,
        dataLabels: ['public'],
        budget: { stepsRemaining: 200 },
        ...(l1 ? { candidateToolIds: SHAPED_IDS } : {}),
      });
      await sessions.beginTurn(session.id);
      if (l1) {
        // Claude Code's tool set is fixed per session (L3), so the shaped tools are
        // exposed once for the whole run instead of per model call.
        await sessions.grantToolExposure(session.id, {
          modelCallId: 'call_' + runId,
          selectedToolVersions: Object.fromEntries(SHAPED_IDS.map((id) => [id, '1'])),
        });
      }
      const gatewayCredentials = sessions.issueGatewayCredentials(session.id);
      const ctx = {
        runId,
        stepId,
        sessionStateId: session.id,
        gatewayCredentials,
        policyRule: 'benchmark:coding:live',
        signal,
      };
      const started = await runtime.startTask(
        { goal: task.prompt, tools: l1 ? SHAPED_IDS : [], levers: arm.levers },
        ctx,
      );
      if (!started.ok) throw new Error('could not start Claude Code: ' + started.error.message);
      taskId = started.data.taskId;
      const worktree = runtime.task(taskId)?.worktree;

      const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
      let detail = '';
      for (;;) {
        if (signal.aborted) throw new Error('cancelled');
        if (Date.now() > deadline) {
          detail = 'timed out';
          break;
        }
        const polled = await runtime.pollTask(taskId, ctx);
        if (!polled.ok) throw new Error(polled.error.message);
        if (polled.data.status === 'done') break;
        if (polled.data.status === 'failed') {
          const why = (polled.data.log ?? []).at(-1) ?? 'failed';
          // Never reached the model at all: let the runner decide if it is retryable.
          if (gateway.ledger.run(runId).calls === 0) throw new Error('Claude Code failed before any model call: ' + why);
          detail = 'ended with an error: ' + why;
          break;
        }
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
      }

      const ledger = gateway.ledger.run(runId);
      const stuckBlocks = events.filter(
        (e) => e.type === 'tool.lifecycle' && (e as { lifecycle?: { phase?: string } }).lifecycle?.phase === 'blocked',
      ).length;
      const shapedCalls = events.filter(
        (e) =>
          e.type === 'tool.lifecycle' &&
          SHAPED_IDS.includes(String((e as { lifecycle?: { action?: { toolId?: string } } }).lifecycle?.action?.toolId)),
      ).length;
      return {
        ...(worktree ? { worktree } : {}),
        tokens: sumTokens(ledger.usage),
        costUsd: ledger.costCents / 100,
        approvals,
        stuckBlocks,
        detail:
          `live: Claude Code under Zephyr, ${ledger.calls} model call(s) metered by the gateway` +
          (ledger.unpricedCalls ? `, ${ledger.unpricedCalls} unpriced` : '') +
          (l1 ? `, ${shapedCalls} shaped-tool event(s)` : '') +
          (detail ? '; ' + detail : ''),
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  };
}
