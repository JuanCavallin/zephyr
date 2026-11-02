/**
 * Claude Code — LIVE ADAPTER over ACP.
 *
 * Claude Code speaks ACP through Zed's adapter, `@agentclientprotocol/claude-agent-acp`
 * (pinned below). Everything transport-level is the shared client in ../_acp; what
 * lives here is Claude Code itself and the run plumbing around it:
 *
 *   startTask   open the run's git worktree (branch zephyr/<runId>), make a private
 *               CLAUDE_CONFIG_DIR, mint a short-TTL hook token, write the per-run
 *               settings.json there (HTTP PreToolUse/PostToolUse/Stop hooks to
 *               /api/hooks/claudecode/<token>), start the adapter with a scrubbed
 *               env and open a session whose cwd is the worktree.
 *   each turn   checkpoint the worktree FIRST (step 2), so every turn can be rewound;
 *               then prompt. The turn's ACP terminal state becomes
 *               `harness.turn.ended` with the real stop reason.
 *   permission  every `session/request_permission` goes through the shared bridge
 *               (core/tools/permissionBridge.ts): native tool → exact action →
 *               authorize → allow/deny, approvals bound to the run. `git push`
 *               binds the approval to (branch, diff hash).
 *   hooks       classify the same call again through the SAME bridge. A hook can
 *               deny or ask, never allow, so either layer denying denies.
 *
 * The model endpoint is Zephyr's gateway (ANTHROPIC_BASE_URL + a scoped token). The
 * Anthropic-compatible `/v1/messages` route lands in step 4; until then a live run
 * reaches the adapter and its permission flow, but model calls fail upstream.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRuntimeAdapter,
  NativeToolRequest,
  PermissionVerdict,
  ProviderCallContext,
  ProviderErrorCode,
  ProviderResult,
  RunEvent,
} from '@htn/shared';
import { resolveLevers } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';
import {
  gatewayRunTokens,
  type GatewayRunTokenStore,
  type RunBudgetCaps,
} from '../../core/modelGateway/runTokens.js';
import { AcpClient, type AcpEvent, type AcpSession, type AcpTerminal } from '../_acp/client.js';
import {
  buildHarnessEnv,
  zephyrMcpServer,
  type AcpHarnessConfig,
  type AcpLaunchContext,
} from '../_acp/config.js';
import {
  createPermissionBridge,
  type Authorizer,
  type PermissionBridge,
} from '../../core/tools/permissionBridge.js';
import type { ToolApprovalGate } from '../../core/tools/approval.js';
import type { ShellPlatform } from '../../core/tools/pathContainment.js';
import { hookTokens, HookTokenStore, MANAGED_HOOK_TTL_MS } from '../../core/hooks/hookTokens.js';
import type { WorkspacesService } from '../../services/workspaces.service.js';
import { newId, nowIso } from '../../lib/ids.js';
import { claudeCodeSettings, hookUrl } from './settings.js';
import { offeredShapedKinds } from '../../core/tools/shaped/index.js';
import { runWorktrees, type RunWorktrees } from '../../core/tools/shaped/worktrees.js';
import { goalWithContextPack, type ContextPackBuilder } from '../../core/context/index.js';

/** The claude-agent-acp release this Zephyr build was verified against. */
export const CLAUDE_AGENT_ACP_VERSION = '0.99.1';

/**
 * Claude Code as an ACP harness. `binary` is the adapter's entry: a `.js` file runs
 * under this Node (no shell, no `.cmd` shim), anything else is spawned as given.
 */
export function claudeCodeHarness(
  opts: { binary?: string; mcp?: boolean } = {},
  overrides: Partial<AcpHarnessConfig> = {},
): AcpHarnessConfig {
  const binary = opts.binary ?? 'claude-agent-acp';
  const isScript = /\.(c|m)?js$/i.test(binary);
  return {
    harness: 'claudecode',
    binary: isScript ? process.execPath : binary,
    args: isScript ? [binary] : [],
    gatewayEnv: (url, token) => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token }),
    env: (ctx) => ({
      // Per-run user settings (the hooks) and session state, outside the worktree.
      ...(ctx.stateDir ? { CLAUDE_CONFIG_DIR: ctx.stateDir } : {}),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }),
    mcpServers: (ctx) =>
      opts.mcp && ctx.mcp?.url ? [zephyrMcpServer(ctx.mcp.url, ctx.mcp.token)] : [],
    pinnedVersion: CLAUDE_AGENT_ACP_VERSION,
    malformedLines: 'ignore',
    // A turn may sit on a human approval for a long time; the bridge pauses the
    // idle clock while a permission request is open.
    timeouts: { initializeMs: 60_000, turnIdleMs: 300_000, cancelGraceMs: 2_000 },
    ...overrides,
  };
}

export type StopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | 'error';

/** ACP terminal → `harness.turn.ended` stop reason. */
export function turnStopReason(terminal: AcpTerminal): StopReason {
  if (terminal.kind === 'cancelled') return 'cancelled';
  if (terminal.kind === 'failed') return 'error';
  const reason = terminal.stopReason;
  if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'refusal' || reason === 'cancelled') {
    return reason;
  }
  return reason === 'max_turn_requests' ? 'max_tokens' : 'end_turn';
}

export interface ClaudeCodeRuntimeDeps {
  harness: AcpHarnessConfig;
  workspaces: () => Promise<WorkspacesService>;
  /** Base URL Claude Code reaches Zephyr's API (hooks) on. */
  apiBaseUrl: string;
  /** Zephyr's model gateway (the Anthropic-compatible base URL). */
  gatewayUrl: string;
  mcpUrl?: string;
  tokens: HookTokenStore;
  /**
   * Per-run `/v1/messages` credentials. When set, Claude Code's ANTHROPIC_AUTH_TOKEN
   * is a token minted here (billed to the run, budget-capped, 403 once the task
   * ends) instead of the session's OpenAI-surface credential.
   */
  gatewayTokens?: GatewayRunTokenStore;
  gatewayBudget?: RunBudgetCaps;
  approvals?: () => Promise<ToolApprovalGate | undefined>;
  emit?: (runId: string, event: RunEvent) => Promise<unknown>;
  authorize?: Authorizer;
  platform?: ShellPlatform;
  /** Require a trusted gateway credential on startTask (production: yes). */
  requireGatewayCredentials?: boolean;
  stderr?: 'inherit' | 'ignore';
  log?: (message: string) => void;
  /** Where shaped tools find a run's worktree (Step 5 L1). Defaults to the process registry. */
  worktrees?: RunWorktrees;
  /** Step 5 L2: builds the Jev-ranked context pack prepended to the goal. */
  contextPack?: ContextPackBuilder;
}

interface TaskRecord {
  taskId: string;
  runId: string;
  stepId: string;
  sessionStateId?: string;
  status: 'running' | 'done' | 'failed';
  log: string[];
  toolCalls: { tool: string; args?: unknown; at: string }[];
  result?: unknown;
  partialText?: string;
  error?: string;
  client: AcpClient;
  session: AcpSession;
  bridge: PermissionBridge;
  token: string;
  gatewayToken?: string;
  stateDir: string;
  worktree: string;
  branch: string;
  /** Resolves when the current turn's background work (checkpoint + prompt) ends. */
  turn: Promise<void>;
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'claudecode' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination,
  };
}

function failure<T>(op: string, started: number, code: ProviderErrorCode, message: string): ProviderResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: code === 'UPSTREAM' || code === 'TIMEOUT' },
    meta: meta(op, started, null),
  };
}

const DESTINATION = 'claude-agent-acp://local';

export interface ClaudeCodeRuntime extends AgentRuntimeAdapter {
  /** Test/inspection hook: the live record for a task. */
  task(taskId: string): Readonly<Pick<TaskRecord, 'worktree' | 'branch' | 'token' | 'stateDir' | 'turn'>> | undefined;
}

export function createClaudeCodeRuntime(deps: ClaudeCodeRuntimeDeps): ClaudeCodeRuntime {
  const tasks = new Map<string, TaskRecord>();
  const worktrees = deps.worktrees ?? runWorktrees;
  const log = deps.log ?? ((m: string) => console.warn('[claudecode] ' + m));
  const emit = async (runId: string, event: RunEvent) => {
    try {
      await deps.emit?.(runId, event);
    } catch (error) {
      log('emit failed: ' + (error as Error).message);
    }
  };

  async function teardown(record: TaskRecord): Promise<void> {
    deps.tokens.revoke(record.token);
    worktrees.unbind(record.runId, record.worktree);
    if (record.gatewayToken) deps.gatewayTokens?.finish(record.gatewayToken);
    record.session.dispose();
    await record.client.close();
    await rm(record.stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  /** Checkpoint, then prompt; runs in the background, pollTask reads `record`. */
  function runTurn(record: TaskRecord, text: string): void {
    const messages: string[] = [];
    let messageId: string | null = null;
    let toolCallSinceText = false;
    const seen = new Set<string>();
    const onEvent = (event: AcpEvent) => {
      if (event.type === 'text') {
        if (messages.length === 0 || toolCallSinceText || (event.messageId !== null && event.messageId !== messageId)) {
          messages.push('');
        }
        messageId = event.messageId;
        toolCallSinceText = false;
        messages[messages.length - 1] += event.text;
        record.partialText = messages[messages.length - 1];
      } else if (event.type === 'tool_call') {
        if (seen.has(event.toolCallId)) return;
        seen.add(event.toolCallId);
        toolCallSinceText = true;
        record.toolCalls.push({ tool: (!event.isUpdate && event.title) || event.toolCallId, at: nowIso() });
      }
    };

    record.turn = (async () => {
      try {
        const ws = await deps.workspaces();
        const checkpoint = await ws.checkpointTurn(record.runId);
        record.log.push('checkpoint: turn ' + checkpoint.turn + ' @ ' + checkpoint.ref);
      } catch (error) {
        // No checkpoint means the turn could not be rewound: do not run it.
        record.status = 'failed';
        record.error = 'workspace checkpoint failed: ' + (error as Error).message;
        return;
      }
      const terminal = await record.session.prompt(text, onEvent);
      await emit(record.runId, {
        type: 'harness.turn.ended',
        runId: record.runId,
        sessionId: record.session.sessionId,
        turnId: newId('turn'),
        harness: 'claudecode',
        stopReason: turnStopReason(terminal),
        at: nowIso(),
      });
      if (terminal.kind === 'failed') {
        record.status = 'failed';
        record.error = terminal.message;
        return;
      }
      record.result = { text: (messages.at(-1) ?? '').trim() };
      record.log.push('stop: ' + (terminal.kind === 'completed' ? terminal.stopReason : 'cancelled'));
      record.status = 'done';
    })();
  }

  return {
    id: 'claudecode',
    mode: 'live',
    capabilities: ['agent.runtime'],

    task(taskId) {
      return tasks.get(taskId);
    },

    async health() {
      return {
        ok: true,
        data: { detail: 'Configured; claude-agent-acp starts per run.' },
        meta: meta('health', Date.now(), null),
      };
    },

    async invoke(op) {
      return failure(op, Date.now(), 'BAD_INPUT', 'No generic invoke() op is defined for claudecode.');
    },

    async startTask(input, ctx) {
      const started = Date.now();
      if (deps.requireGatewayCredentials !== false && !ctx.gatewayCredentials) {
        return failure('startTask', started, 'AUTH', 'A trusted scoped gateway binding is required.');
      }
      const stepId = ctx.stepId ?? 'unbound';
      let stateDir: string | undefined;
      let token: string | undefined;
      let gatewayToken: string | undefined;
      let client: AcpClient | undefined;
      let boundWorktree: string | undefined;
      const levers = resolveLevers(input.levers);
      try {
        const ws = await deps.workspaces();
        const workspace = await ws.open(ctx.runId);
        worktrees.bind(ctx.runId, workspace.path);
        boundWorktree = workspace.path;
        stateDir = await mkdtemp(join(tmpdir(), 'zephyr-claudecode-'));
        // Step 5 L1: deny raw test/build/lint only for the kinds whose shaped
        // tool this task was actually offered over MCP.
        const shapedTools =
          levers.shapedTools && deps.mcpUrl ? offeredShapedKinds(input.tools) : [];
        const approvals = ctx.stepId ? await deps.approvals?.() : undefined;
        const bridge = createPermissionBridge({
          harness: 'claudecode',
          worktree: workspace.path,
          ...(deps.platform ? { platform: deps.platform } : {}),
          ...(shapedTools.length > 0 ? { shapedTools } : {}),
          ...(ctx.stepId
            ? {
                run: {
                  runId: ctx.runId,
                  stepId: ctx.stepId,
                  ...(ctx.sessionStateId ? { sessionStateId: ctx.sessionStateId } : {}),
                },
              }
            : {}),
          ...(deps.authorize ? { authorize: deps.authorize } : {}),
          ...(approvals ? { approvals } : {}),
          publishBinding: async () => ({
            branch: workspace.branch,
            diffHash: (await ws.diff(ctx.runId)).hash,
          }),
          onLifecycle: (lifecycle) => emit(ctx.runId, { type: 'tool.lifecycle', lifecycle }).then(() => {}),
          log: (m) => log('native permission: ' + m),
        });
        token = deps.tokens.mint(
          {
            harness: 'claudecode',
            runId: ctx.runId,
            stepId,
            ...(ctx.sessionStateId ? { sessionStateId: ctx.sessionStateId } : {}),
            mode: 'managed',
            bridge,
          },
          MANAGED_HOOK_TTL_MS,
        );
        const settings = claudeCodeSettings({ hookUrl: hookUrl(deps.apiBaseUrl, token) });
        await writeFile(join(stateDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

        gatewayToken = deps.gatewayTokens?.mint({
          runId: ctx.runId,
          harness: 'claudecode',
          ...(ctx.sessionStateId ? { sessionStateId: ctx.sessionStateId } : {}),
          budget: deps.gatewayBudget ?? {},
        });
        const launch: AcpLaunchContext = {
          cwd: workspace.path,
          gateway: {
            url: deps.gatewayUrl,
            token: gatewayToken ?? ctx.gatewayCredentials?.model ?? 'zephyr-local',
          },
          ...(deps.mcpUrl ? { mcp: { url: deps.mcpUrl, token: ctx.gatewayCredentials?.mcp ?? '' } } : {}),
          stateDir,
        };
        let record: TaskRecord | undefined;
        client = await AcpClient.start({
          harness: deps.harness,
          cwd: workspace.path,
          env: buildHarnessEnv(deps.harness, launch),
          stderr: deps.stderr ?? 'inherit',
          log: (m) => log(m),
          onExit: () => {
            if (record && record.status === 'running') {
              record.status = 'failed';
              record.error = 'claude-agent-acp exited';
            }
          },
          onPermission: (req) => bridge.handler(req, ctx.signal),
        });
        const session = await client.newSession({
          cwd: workspace.path,
          mcpServers: deps.harness.mcpServers(launch),
        });
        record = {
          taskId: session.sessionId,
          runId: ctx.runId,
          stepId,
          ...(ctx.sessionStateId ? { sessionStateId: ctx.sessionStateId } : {}),
          status: 'running',
          log: ['started in ' + workspace.branch],
          toolCalls: [],
          client,
          session,
          bridge,
          token,
          ...(gatewayToken ? { gatewayToken } : {}),
          stateDir,
          worktree: workspace.path,
          branch: workspace.branch,
          turn: Promise.resolve(),
        };
        tasks.set(record.taskId, record);
        // Step 5 L2: a pack failure costs the pack, never the task.
        let pack: Awaited<ReturnType<ContextPackBuilder>> | null = null;
        if (levers.contextPack && deps.contextPack) {
          try {
            pack = await deps.contextPack({ task: input.goal, worktree: workspace.path }, ctx);
            record.log.push(
              `context pack: ${pack.files.length} file(s), ~${pack.tokens} tokens, source=${pack.source}` +
                (pack.cached ? ' (cached)' : ''),
            );
          } catch (error) {
            log('context pack failed: ' + (error as Error).message);
          }
        }
        const goal = goalWithContextPack(input.goal, pack);
        runTurn(record, input.context ? goal + '\n\nContext:\n' + JSON.stringify(input.context) : goal);
        return { ok: true, data: { taskId: record.taskId }, meta: meta('startTask', started, DESTINATION) };
      } catch (error) {
        if (token) deps.tokens.revoke(token);
        if (gatewayToken) deps.gatewayTokens?.finish(gatewayToken);
        if (client) await client.close().catch(() => {});
        if (stateDir) await rm(stateDir, { recursive: true, force: true }).catch(() => {});
        if (boundWorktree) worktrees.unbind(ctx.runId, boundWorktree);
        return failure('startTask', started, 'UPSTREAM', (error as Error).message);
      }
    },

    async pollTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return failure('pollTask', started, 'BAD_INPUT', 'Unknown taskId: ' + taskId);
      if (record.status === 'running') {
        const partial = record.partialText?.trim();
        return {
          ok: true,
          data: {
            status: 'running',
            log: record.log,
            ...(partial ? { partial: { text: partial } } : {}),
            toolCalls: [...record.toolCalls],
          },
          meta: meta('pollTask', started, DESTINATION),
        };
      }
      return {
        ok: true,
        data: {
          status: record.status,
          result: record.result,
          log: record.error ? [...record.log, record.error] : record.log,
          toolCalls: record.toolCalls,
        },
        meta: meta('pollTask', started, DESTINATION),
      };
    },

    async continueTask(taskId, input) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return failure('continueTask', started, 'BAD_INPUT', 'Unknown taskId: ' + taskId);
      if (record.status === 'running') {
        return failure('continueTask', started, 'BAD_INPUT', 'Task is still running: ' + taskId);
      }
      record.status = 'running';
      record.result = undefined;
      record.partialText = undefined;
      record.error = undefined;
      record.toolCalls = [];
      record.log.push('continued');
      runTurn(
        record,
        input.context ? input.instruction + '\n\nContext:\n' + JSON.stringify(input.context) : input.instruction,
      );
      return { ok: true, data: null, meta: meta('continueTask', started, DESTINATION) };
    },

    async cancelTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return { ok: true, data: null, meta: meta('cancelTask', started, null) };
      tasks.delete(taskId);
      await record.session.cancel({ graceMs: 2_000 });
      await teardown(record);
      return { ok: true, data: null, meta: meta('cancelTask', started, DESTINATION) };
    },

    async onPermissionRequest(req: NativeToolRequest, ctx: ProviderCallContext): Promise<PermissionVerdict> {
      const record = [...tasks.values()].find((t) => t.session.sessionId === req.sessionId);
      // No live session for this request: nothing has authorized it.
      if (!record) return 'deny';
      return record.bridge.handler(req, ctx.signal);
    },
  };
}

/** Claude Code appends `/v1/messages` itself; the gateway base may already end in /v1. */
export function anthropicBaseUrl(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Production wiring: the shared workspaces service, approval gate, bus and tokens. */
export function createLiveClaudeCode(cfg: ProviderConfig): AgentRuntimeAdapter {
  if (!cfg.binary) {
    const missing = <T>(op: string) =>
      failure<T>(op, Date.now(), 'AUTH', 'CLAUDECODE_BINARY (claude-agent-acp dist/index.js) is not set');
    return {
      id: 'claudecode',
      mode: 'live',
      capabilities: ['agent.runtime'],
      health: async () => missing('health'),
      invoke: async (op) => missing(op),
      startTask: async () => missing('startTask'),
      pollTask: async () => missing('pollTask'),
      continueTask: async () => missing('continueTask'),
      cancelTask: async () => missing('cancelTask'),
      onPermissionRequest: async () => 'deny',
    };
  }
  return createClaudeCodeRuntime({
    harness: claudeCodeHarness({ binary: cfg.binary, mcp: Boolean(cfg.mcpUrl) }),
    // Lazy: runtime.ts builds the registry, so importing it at load time would cycle.
    workspaces: async () => (await import('../../services/workspaces.service.js')).workspaces(),
    approvals: async () => (await import('../../services/runtime.js')).toolApprovalGate,
    emit: async (runId, event) => (await import('../../services/runtime.js')).bus.emit(runId, event),
    contextPack: async (input, ctx) => {
      const runtime = await import('../../services/runtime.js');
      const { createContextPackBuilder } = await import('../../core/context/index.js');
      return createContextPackBuilder({
        decisions: runtime.decisionService,
        sessions: runtime.sessionStateService,
        emit: (runId, event) => runtime.bus.emit(runId, event),
      })(input, ctx);
    },
    tokens: hookTokens,
    gatewayTokens: gatewayRunTokens,
    gatewayBudget: config.modelGateway.messagesBudget,
    apiBaseUrl: `http://127.0.0.1:${config.port}`,
    gatewayUrl: anthropicBaseUrl(cfg.baseUrl ?? config.modelGateway.baseUrl),
    ...(cfg.mcpUrl ? { mcpUrl: cfg.mcpUrl } : {}),
  });
}
