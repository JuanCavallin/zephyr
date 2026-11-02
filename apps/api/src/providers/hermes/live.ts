/**
 * Hermes Agent (Nous Research) — LIVE ADAPTER, implemented.
 *
 * ============================================================================
 * Drives Hermes as a local subprocess over ACP (Agent Client Protocol) — NOT
 * an HTTP API. `uv run hermes-acp` speaks newline-delimited JSON-RPC over
 * stdio. Each canonical context gets an isolated subprocess/profile and
 * scoped model/MCP credentials. Continuations retain that context's ACP session;
 * unrelated contexts never share process environment or conversation history.
 *
 * The transport (spawn, framing, sessions, drain, permission requests,
 * cancellation, process-tree kill) is the harness-agnostic client in
 * ../_acp/client.ts. What lives here is Hermes itself: its launch config, its
 * profile, and the bridge from ACP sessions to start/poll/cancel.
 *
 * VERIFIED, not guessed: this shape (persistent `.connect()`, `_meta` as the
 * documented extension point on `NewSessionRequest`, `session/cancel` as the
 * real cancellation notification, newline-delimited framing) was proven
 * against a real running Hermes install — a real prompt got a real answer, a
 * stuck tool call was genuinely cancelled and confirmed via Hermes's own
 * "Cancelled session" log line. See hermes-tester/ for that standalone proof.
 *
 * TWO HONEST LIMITS, DO NOT PAPER OVER THESE:
 *
 *   1. `_meta.enabled_toolsets` remains only a best-effort Hermes hint. Actual
 *      model-visible restriction happens in AgentOS's model gateway, which
 *      strips every tool schema lacking a trusted, Jev-selected descriptor.
 *      Calls to configured AgentOS MCP tools are intercepted by the trusted
 *      registry, exact-action broker, and registered local/provider executor.
 *
 *   2. Unmapped native ACP permission requests fail closed. They do not carry
 *      a trusted AgentOS descriptor/destination/exact ToolAction and cannot
 *      safely grant execution from a tool title. AgentOS MCP tools already
 *      pass through the exact-action broker and its real approval flow. A
 *      future native-tool mapping must construct that same trusted contract
 *      before this callback may allow anything.
 *
 * `startTask`/`pollTask` bridge ACP's session+event model onto this
 * interface's start/poll/cancel shape: startTask opens a session and returns
 * immediately with sessionId-as-taskId; a background turn updates an
 * in-memory record; pollTask just reads that record. This deliberately keeps
 * core/orchestrator.ts's existing bounded-polling loop untouched — see its
 * `pollIntervalMs`/`maxPolls` defaults, sized for real Hermes latency
 * (several seconds per call, 40+ seconds observed for a slow tool call).
 * ============================================================================
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { AgentRuntimeAdapter, ProviderErrorCode, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { AcpClient, denyPermission, type AcpEvent, type AcpSession } from '../_acp/client.js';
import {
  buildHarnessEnv,
  type AcpHarnessConfig,
  type AcpLaunchContext,
} from '../_acp/config.js';

interface TaskRecord {
  status: 'running' | 'done' | 'failed';
  log: string[];
  toolCalls: { tool: string; args?: unknown; at: string }[];
  result?: unknown;
  /** The latest assistant message while the run is still going. */
  partialText?: string;
  error?: string;
  session: AcpSession;
}

/** Denial cannot fall back to the last option, which may be an allow option. */
export const denyUnmappedHermesPermission = denyPermission;

/**
 * Hermes as an ACP harness.
 *
 * `inheritEnv`, `malformedLines: 'ignore'` and no timeouts keep the
 * pre-extraction behaviour exactly: Hermes always ran with the parent env, the
 * SDK's tolerance of stray stdout lines, and no client-side deadline
 * (core/orchestrator.ts's `maxPolls` bounds a run instead).
 */
export const hermesHarness: AcpHarnessConfig = {
  harness: 'hermes',
  // Spawned with argv, NOT shell:true. `uv` is a real .exe on PATH — Windows
  // CreateProcess resolves that directly. shell:true instead routes through
  // cmd.exe (resolved via process.env.ComSpec), which broke under `tsx watch`
  // specifically (ComSpec apparently doesn't survive tsx watch's nested
  // process spawn) with `spawn C:\WINDOWS\system32\cmd.exe ENOENT` —
  // reproduced live, not theoretical.
  binary: 'uv',
  args: ['run', 'hermes-acp'],
  inheritEnv: true,
  gatewayEnv: (url, token) => ({
    AGENTOS_GATEWAY_API_KEY: token,
    // `key_env` in config.yaml does NOT reach the key Hermes actually
    // sends. For a `custom` provider it resolves, in order:
    //   explicit api_key -> OPENAI_API_KEY -> same-host main key
    //   -> the literal "no-key-required"
    // (hermes-agent/agent/auxiliary_client.py). With none of those set it
    // sent "no-key-required" and every model call came back 401 against a
    // gateway token that was correct on both sides -- which reads as a
    // credentials bug and is not one.
    //
    // OPENAI_API_KEY is the supported hook, so it carries the same local
    // gateway token. Scoped to this child process, and the base URL it
    // pairs with is loopback, so the value never leaves the machine.
    OPENAI_API_KEY: token,
    OPENAI_BASE_URL: url,
  }),
  env: (ctx) => ({
    HERMES_HOME: ctx.stateDir ?? '',
    HERMES_ACP_SKIP_CONFIGURED_MCP: '0',
    AGENTOS_MCP_API_KEY: ctx.mcp?.token ?? 'agentos-mcp-local',
  }),
  // Hermes reads its MCP servers from the profile's config.yaml, not session/new.
  mcpServers: () => [],
  pinnedVersion: null,
  malformedLines: 'ignore',
  timeouts: { initializeMs: 0, turnIdleMs: 0, cancelGraceMs: 0 },
};

/** The launch context a Hermes process gets for this config and profile. */
export function hermesLaunchContext(cfg: ProviderConfig, profileDir: string): AcpLaunchContext {
  return {
    cwd: cfg.cwd ?? process.cwd(),
    gateway: { url: cfg.baseUrl ?? '', token: cfg.apiKey ?? 'agentos-local' },
    mcp: { url: cfg.mcpUrl ?? '', token: cfg.mcpApiKey ?? 'agentos-mcp-local' },
    stateDir: profileDir,
  };
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'hermes' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination,
  };
}

function failure<T>(
  op: string,
  started: number,
  code: ProviderErrorCode,
  message: string,
): ProviderResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: code === 'UPSTREAM' || code === 'TIMEOUT' },
    meta: meta(op, started, null),
  };
}

export function createLiveHermes(cfg: ProviderConfig): AgentRuntimeAdapter {
  // Gateway credentials are process environment, so isolate a subprocess per
  // canonical context. No process-global catalog or credentials can cross runs.
  const workers = new Map<string, AgentRuntimeAdapter>();
  return {
    id: 'hermes',
    mode: 'live',
    capabilities: ['agent.runtime'],
    async health() {
      return cfg.cwd
        ? {
            ok: true,
            data: { detail: 'Configured; ACP starts on an authenticated task.' },
            meta: meta('health', Date.now(), null),
          }
        : failure('health', Date.now(), 'AUTH', 'HERMES_CWD is not set');
    },
    async invoke(op) {
      return failure(op, Date.now(), 'BAD_INPUT', 'Unsupported Hermes operation.');
    },
    async startTask(input, ctx) {
      if (!ctx.gatewayCredentials || !ctx.sessionStateId)
        return failure(
          'startTask',
          Date.now(),
          'AUTH',
          'A trusted scoped gateway binding is required.',
        );
      const worker = createHermesProcess({
        ...cfg,
        apiKey: ctx.gatewayCredentials.model,
        mcpApiKey: ctx.gatewayCredentials.mcp,
        profileDir: resolve(
          cfg.profileDir ?? resolve(process.cwd(), '.data/hermes-scopes'),
          ctx.gatewayCredentials.profileId,
        ),
      });
      const result = await worker.startTask(input, ctx);
      if (result.ok) workers.set(result.data.taskId, worker);
      return result;
    },
    async pollTask(id, ctx) {
      return (
        workers.get(id)?.pollTask(id, ctx) ??
        failure('pollTask', Date.now(), 'BAD_INPUT', 'Expired Hermes context.')
      );
    },
    async continueTask(id, input, ctx) {
      return (
        workers.get(id)?.continueTask(id, input, ctx) ??
        failure(
          'continueTask',
          Date.now(),
          'BAD_INPUT',
          'Expired Hermes context; refusing to start a replacement.',
        )
      );
    },
    async cancelTask(id, ctx) {
      const worker = workers.get(id);
      workers.delete(id);
      return worker
        ? worker.cancelTask(id, ctx)
        : { ok: true, data: null, meta: meta('cancelTask', Date.now(), null) };
    },
  };
}

/** The Hermes profile directory: explicit, or derived from the gateway URL (see prepareProfile). */
function profileDirFor(cfg: ProviderConfig): string {
  const profileKey = (cfg.baseUrl ?? '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cfg.profileDir ?? resolve(process.cwd(), '.data/hermes-agentos-' + profileKey);
}

function createHermesProcess(cfg: ProviderConfig): AgentRuntimeAdapter {
  const tasks = new Map<string, TaskRecord>();
  let client: AcpClient | null = null;
  let connecting: Promise<AcpClient> | null = null;
  const connectedToolIds = new Set<string>();

  function resetConnection(): void {
    const toClose = client;
    client = null;
    connecting = null;
    connectedToolIds.clear();
    // Kills the whole process tree: `uv` AND the Python it started.
    if (toClose) void toClose.close();
  }

  async function prepareProfile(): Promise<string> {
    if (!cfg.baseUrl) throw new Error('AgentOS model gateway base URL is not configured');
    if (!cfg.mcpUrl) throw new Error('AgentOS MCP gateway URL is not configured');
    // SCOPED TO THIS INSTANCE'S GATEWAY, not just to the repo.
    //
    // The profile holds a config.yaml naming the model gateway and MCP URLs,
    // both of which carry THIS process's port. A second API instance --
    // a verification run on another port, a colleague's server, a stale
    // watcher -- would otherwise write the same file and the last writer would
    // win, silently pointing a running Hermes at a port that may no longer
    // exist. The symptom is a 401 from "a custom endpoint", which looks like a
    // credentials problem and is not one.
    //
    // Deriving the directory from the gateway URL makes that collision
    // impossible instead of merely unlikely. An explicit HERMES_PROFILE_DIR
    // still wins, for anyone who wants one shared profile on purpose.
    const profileDir = profileDirFor(cfg);
    await mkdir(profileDir, { recursive: true });
    const configYaml = [
      'model:',
      '  default: agentos-router',
      '  provider: custom:agentos',
      '  base_url: ' + JSON.stringify(cfg.baseUrl),
      '  key_env: AGENTOS_GATEWAY_API_KEY',
      '  context_length: 131072',
      // Named custom providers honor key_env in the installed Hermes resolver.
      // The secret stays in the child environment, never in the profile file.
      'custom_providers:',
      '  - name: agentos',
      '    base_url: ' + JSON.stringify(cfg.baseUrl),
      '    key_env: AGENTOS_GATEWAY_API_KEY',
      '    api_mode: chat_completions',
      'agent:',
      '  max_turns: 20',
      // AgentOS already narrows the catalog before starting Hermes and its
      // model gateway independently filters every schema against the current
      // Jev-selected capability set. Keep those MCP schemas eager here so
      // Hermes cannot hide the selected tool behind its own tool-search
      // bridge before the request reaches AgentOS.
      'tools:',
      '  tool_search:',
      '    enabled: off',
      'mcp_servers:',
      '  agentos:',
      '    enabled: true',
      '    url: ' + JSON.stringify(cfg.mcpUrl),
      '    headers:',
      '      Authorization: "Bearer ${AGENTOS_MCP_API_KEY}"',
      '    trust: full',
      '    timeout: 900',
      '    tools:',
      '      resources: false',
      '      prompts: false',
      '',
    ].join('\n');
    await writeFile(resolve(profileDir, 'config.yaml'), configYaml, 'utf8');
    return profileDir;
  }

  async function connect(): Promise<AcpClient> {
    if (client) return client;
    if (connecting) return connecting;

    connecting = (async () => {
      if (!cfg.cwd) throw new Error('HERMES_CWD is not set');
      const profileDir = await prepareProfile();
      const started = await AcpClient.start({
        harness: hermesHarness,
        cwd: cfg.cwd,
        env: buildHarnessEnv(hermesHarness, hermesLaunchContext(cfg, profileDir)),
        stderr: 'inherit', // Hermes's own logs stay visible
        log: (m) => console.error('[hermes:live] ' + m),
        onExit: () => {
          if (client === started) resetConnection();
        },
        onPermission: () => {
          // FAIL CLOSED — see the file header. Never silently approve here.
          console.warn(
            '[hermes:live] denied unmapped native permission; use AgentOS broker tools.',
          );
          return 'deny';
        },
      });
      client = started;
      return started;
    })();

    try {
      return await connecting;
    } catch (err) {
      connecting = null;
      throw err;
    }
  }

  /** Runs one turn in the background; pollTask only ever reads `record`. */
  function runTurn(record: TaskRecord, text: string): void {
    // Hermes streams EVERY assistant message of a turn as agent_message_chunk:
    // the "Let me search for X" narration before each tool call, then the final
    // answer. Joined into one string, the turn's "result" opened with narration,
    // and the completion judge -- which sees a 1500-char excerpt -- was judging
    // the plan instead of the answer, so it kept asking for another turn. A new
    // messageId, or a tool call in between, starts a new message; the result is
    // the last one.
    const messages: string[] = [];
    let messageId: string | null = null;
    let toolCallSinceText = false;
    // ACP announces a call with `tool_call`, then reports progress on the same
    // toolCallId with `tool_call_update`. Recording both counted every call
    // twice (a turn of 8 calls reported toolCallCount 16).
    const seenToolCallIds = new Set<string>();

    const onEvent = (event: AcpEvent) => {
      if (event.type === 'text') {
        if (
          messages.length === 0 ||
          toolCallSinceText ||
          (event.messageId !== null && event.messageId !== messageId)
        ) {
          messages.push('');
        }
        messageId = event.messageId;
        toolCallSinceText = false;
        messages[messages.length - 1] += event.text;
        record.partialText = messages[messages.length - 1];
      } else if (event.type === 'tool_call') {
        // Only a NEW call ends the message before it; a late progress update
        // for an earlier call must not split the final answer.
        if (seenToolCallIds.has(event.toolCallId)) return;
        seenToolCallIds.add(event.toolCallId);
        toolCallSinceText = true;
        record.toolCalls.push({
          tool: (!event.isUpdate && event.title) || event.toolCallId,
          at: new Date().toISOString(),
        });
      }
    };

    void record.session.prompt(text, onEvent).then((terminal) => {
      if (terminal.kind === 'failed') {
        record.status = 'failed';
        record.error = terminal.message;
        return;
      }
      record.result = { text: (messages.at(-1) ?? '').trim() };
      record.log.push(
        'stop: ' + (terminal.kind === 'completed' ? terminal.stopReason : 'cancelled'),
      );
      record.status = 'done';
    });
  }

  return {
    id: 'hermes',
    mode: 'live',
    capabilities: ['agent.runtime'],

    async health() {
      const started = Date.now();
      if (!cfg.cwd) return failure('health', started, 'AUTH', 'HERMES_CWD is not set');
      try {
        await connect();
        return { ok: true, data: {}, meta: meta('health', started, 'hermes-acp://local') };
      } catch (err) {
        return failure('health', started, 'UPSTREAM', (err as Error).message);
      }
    },

    async invoke(op) {
      return failure(op, Date.now(), 'BAD_INPUT', 'No generic invoke() op is defined for hermes.');
    },

    async startTask(input) {
      const started = Date.now();
      try {
        const requestedTools = [...new Set(input.tools ?? [])];
        const catalogChanged = requestedTools.some((toolId) => !connectedToolIds.has(toolId));
        if (client && catalogChanged) {
          if ([...tasks.values()].some((task) => task.status === 'running')) {
            return failure(
              'startTask',
              started,
              'UPSTREAM',
              'Hermes must finish the current session before its MCP catalog can refresh.',
            );
          }
          // Hermes discovers MCP schemas when its ACP process starts. Restart
          // between sessions when task-time discovery added a new selected tool.
          for (const task of tasks.values()) task.session.dispose();
          tasks.clear();
          resetConnection();
        }
        const conn = await connect();
        requestedTools.forEach((toolId) => connectedToolIds.add(toolId));

        // Best-effort only — see file header limit #1. Never treat this as
        // an enforced boundary.
        // The SESSION cwd is an empty directory outside any git repo, not the
        // Hermes checkout. Hermes injects AGENTS.md/CLAUDE.md from the git root
        // down to the session cwd into EVERY model call: with the checkout as
        // cwd that was Hermes's own 31k-char developer guide, ~8k tokens per
        // call that no AgentOS task needs. The process still starts in
        // cfg.cwd, which `uv run` requires.
        const workDir = resolve(tmpdir(), 'agentos-hermes-work', basename(profileDirFor(cfg)));
        await mkdir(workDir, { recursive: true });
        const session = await conn.newSession({
          cwd: workDir,
          meta: { enabled_toolsets: requestedTools },
        });

        const record: TaskRecord = { status: 'running', log: ['started'], toolCalls: [], session };
        tasks.set(session.sessionId, record);

        runTurn(
          record,
          input.context
            ? input.goal + '\n\nContext:\n' + JSON.stringify(input.context)
            : input.goal,
        );

        return {
          ok: true,
          data: { taskId: session.sessionId },
          meta: meta('startTask', started, 'hermes-acp://local'),
        };
      } catch (err) {
        resetConnection();
        return failure('startTask', started, 'UPSTREAM', (err as Error).message);
      }
    },

    async pollTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return failure('pollTask', started, 'BAD_INPUT', 'Unknown taskId: ' + taskId);

      if (record.status === 'running') {
        // What it has said and done so far: a run that a budget stops still
        // hands its findings on instead of nothing.
        const partial = record.partialText?.trim();
        return {
          ok: true,
          data: {
            status: 'running',
            log: record.log,
            ...(partial ? { partial: { text: partial } } : {}),
            toolCalls: [...record.toolCalls],
          },
          meta: meta('pollTask', started, 'hermes-acp://local'),
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
        meta: meta('pollTask', started, 'hermes-acp://local'),
      };
    },

    async continueTask(taskId, input) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record)
        return failure('continueTask', started, 'BAD_INPUT', 'Unknown taskId: ' + taskId);
      if (record.status === 'running') {
        return failure('continueTask', started, 'BAD_INPUT', 'Task is still running: ' + taskId);
      }

      try {
        record.status = 'running';
        record.result = undefined;
        record.partialText = undefined;
        record.error = undefined;
        record.toolCalls = [];
        record.log.push('continued');
        runTurn(
          record,
          input.context
            ? input.instruction + '\n\nContext:\n' + JSON.stringify(input.context)
            : input.instruction,
        );
        return {
          ok: true,
          data: null,
          meta: meta('continueTask', started, 'hermes-acp://local'),
        };
      } catch (err) {
        record.status = 'failed';
        return failure('continueTask', started, 'UPSTREAM', (err as Error).message);
      }
    },

    async cancelTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return { ok: true, data: null, meta: meta('cancelTask', started, null) };

      // Verified real: Hermes logs "Interrupt requested" / "Cancelled session"
      // in direct response to session/cancel. A client-side give-up alone does
      // NOT stop the turn on Hermes's side — this does. No grace period: the
      // process is torn down right after, as it always was.
      await record.session.cancel({ graceMs: 0 });
      record.session.dispose();
      tasks.delete(taskId);
      resetConnection();
      return { ok: true, data: null, meta: meta('cancelTask', started, 'hermes-acp://local') };
    },
  };
}
