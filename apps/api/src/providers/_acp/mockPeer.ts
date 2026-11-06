/**
 * A scripted ACP agent for contract tests (spec §9: "contract-test against a
 * mock ACP peer"). Dependency-free newline-delimited JSON-RPC on stdio, so it
 * exercises our client exactly the way a real harness does — through a real
 * subprocess, real pipes and a real process tree.
 *
 * The FIRST LINE of each prompt picks the scenario:
 *
 *   complete            text chunks + a tool call, then end_turn
 *   write:<name>=<text> write <text> to <session cwd>/<name>, then end_turn
 *   say:<text>          say <text> verbatim (one line), then end_turn
 *   session-meta        write the session/new `_meta` to <cwd>/session-meta.json, then end_turn
 *   permission          ask session/request_permission; write permitted.txt
 *                       and say "allowed" if granted, say "denied" otherwise
 *   error               answer the prompt with a JSON-RPC error
 *   crash               one chunk, then exit(3) mid-turn
 *   malformed           one chunk, then a non-JSON line, then hang
 *   hang                one chunk, then never answer (ignores session/cancel)
 *   slow                a chunk every 200ms; stops with `cancelled` on cancel
 *   spawn-child         start a long-lived grandchild, say `child:<pid>`, hang
 *   request:<Tool>[:nohook]
 *                       act like Claude Code running native tool <Tool> with the
 *                       JSON input on the following prompt lines: POST the
 *                       PreToolUse hook from $CLAUDE_CONFIG_DIR/settings.json (if
 *                       any; `nohook` skips it), then session/request_permission,
 *                       then perform Write/Edit (file_path, content) or "execute"
 *                       Bash (say `executed:<command>`), then POST PostToolUse.
 *                       Says `hook-denied`, `denied` or `allowed`.
 *
 * Run it with `mockPeerHarness()`, which launches it under tsx.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { zephyrGatewayEnv, type AcpHarnessConfig } from './config.js';

const PEER_PATH = fileURLToPath(import.meta.url);

/** Harness config that launches this file as an ACP agent. */
export function mockPeerHarness(overrides: Partial<AcpHarnessConfig> = {}): AcpHarnessConfig {
  return {
    harness: 'mockharness',
    binary: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), PEER_PATH],
    env: () => ({}),
    gatewayEnv: zephyrGatewayEnv,
    mcpServers: () => [],
    pinnedVersion: '0.0.0',
    malformedLines: 'fail',
    ...overrides,
  };
}

/* ------------------------------- the peer -------------------------------- */

type Json = Record<string, unknown>;

function runPeer(): void {
  const sessions = new Map<string, { cwd: string; cancelled: boolean; meta?: unknown }>();
  const pending = new Map<number, (result: Json) => void>();
  let nextId = 1;
  let nextSession = 1;

  const send = (message: Json): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  };
  const respond = (id: unknown, result: Json) => send({ id, result });
  const update = (sessionId: string, u: Json) =>
    send({ method: 'session/update', params: { sessionId, update: u } });
  const say = (sessionId: string, text: string) =>
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const request = (method: string, params: Json) =>
    new Promise<Json>((r) => {
      const id = nextId++;
      pending.set(id, r);
      send({ id, method, params });
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The http hook URL Claude Code would call for `event`, from the per-run settings. */
  const hookUrlFor = (event: string): string | null => {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    if (!dir || !existsSync(resolve(dir, 'settings.json'))) return null;
    try {
      const settings = JSON.parse(readFileSync(resolve(dir, 'settings.json'), 'utf8')) as {
        hooks?: Record<string, { hooks?: { type?: string; url?: string }[] }[]>;
      };
      return settings.hooks?.[event]?.[0]?.hooks?.find((h) => h.type === 'http')?.url ?? null;
    } catch {
      return null;
    }
  };
  const postHook = async (event: string, body: Json): Promise<Json | null> => {
    const url = hookUrlFor(event);
    if (!url) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: event, ...body }),
      });
      // Claude Code treats a non-2xx http hook as a non-blocking error.
      return res.ok ? ((await res.json()) as Json) : { status: res.status };
    } catch {
      return null;
    }
  };
  const hang = () => new Promise<never>(() => {});

  async function prompt(id: unknown, params: Json): Promise<void> {
    const sessionId = String(params.sessionId);
    const session = sessions.get(sessionId);
    if (!session) return send({ id, error: { code: -32602, message: 'unknown session' } });
    session.cancelled = false;
    const blocks = (params.prompt as { type: string; text?: string }[]) ?? [];
    const text = blocks.map((b) => b.text ?? '').join('');
    const scenario = text.split('\n')[0]!.trim();
    const done = (stopReason = 'end_turn') => respond(id, { stopReason });

    if (scenario === 'session-meta') {
      // Echo the `_meta` this session was opened with, so a check can see it.
      writeFileSync(resolve(session.cwd, 'session-meta.json'), JSON.stringify(session.meta ?? null));
      return done();
    }
    if (scenario === 'complete') {
      say(sessionId, 'hello ');
      say(sessionId, 'world');
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read README.md',
        kind: 'read',
        status: 'pending',
        rawInput: { path: 'README.md' },
      });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });
      say(sessionId, 'done');
      return done();
    }

    if (scenario.startsWith('write:')) {
      const [name, ...rest] = scenario.slice('write:'.length).split('=');
      const target = resolve(session.cwd, name!);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, rest.join('='));
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'write-' + name,
        title: 'Write ' + name,
        kind: 'edit',
        status: 'completed',
        rawInput: { path: name },
      });
      say(sessionId, 'wrote ' + name);
      return done();
    }

    if (scenario === 'permission') {
      const answer = await request('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'perm-1',
          title: 'Write',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: 'permitted.txt', content: 'granted' },
        },
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      const outcome = (answer.outcome ?? {}) as { outcome?: string; optionId?: string };
      if (outcome.outcome === 'selected' && outcome.optionId === 'yes') {
        writeFileSync(resolve(session.cwd, 'permitted.txt'), 'granted');
        say(sessionId, 'allowed');
      } else {
        say(sessionId, 'denied');
      }
      return done();
    }

    if (scenario.startsWith('request:')) {
      const [, toolName = '', flag] = scenario.split(':');
      const input = JSON.parse(text.split('\n').slice(1).join('\n') || '{}') as Json;
      const toolCallId = 'toolu_' + Math.random().toString(36).slice(2, 10);
      const common = { session_id: sessionId, cwd: session.cwd, tool_name: toolName, tool_input: input, tool_use_id: toolCallId };
      if (flag !== 'nohook') {
        const pre = (await postHook('PreToolUse', common)) as
          | { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
          | null;
        if (pre?.hookSpecificOutput?.permissionDecision === 'deny') {
          say(sessionId, 'hook-denied:' + toolName + ' ' + (pre.hookSpecificOutput.permissionDecisionReason ?? ''));
          return done();
        }
      }
      const kind = toolName === 'Bash' ? 'execute' : toolName === 'Read' ? 'read' : 'edit';
      const answer = await request('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId,
          title: toolName,
          kind,
          status: 'pending',
          rawInput: input,
          _meta: { claudeCode: { toolName } },
        },
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      const outcome = (answer.outcome ?? {}) as { outcome?: string; optionId?: string };
      if (!(outcome.outcome === 'selected' && outcome.optionId === 'yes')) {
        say(sessionId, 'denied:' + toolName);
        return done();
      }
      let response: Json = { success: true };
      if (toolName === 'Write' || toolName === 'Edit') {
        const path = String(input.file_path ?? '');
        const target = isAbsolute(path) ? path : resolve(session.cwd, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(input.content ?? input.new_string ?? ''));
        response = { success: true, filePath: target };
      } else if (toolName === 'Bash') {
        say(sessionId, 'executed:' + String(input.command ?? ''));
        response = { stdout: '', stderr: '', interrupted: false };
      }
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: toolName, kind, status: 'completed', rawInput: input });
      if (flag !== 'nohook') await postHook('PostToolUse', { ...common, tool_response: response });
      say(sessionId, 'allowed:' + toolName);
      return done();
    }

    if (scenario.startsWith('say:')) {
      say(sessionId, scenario.slice('say:'.length));
      return done();
    }

    if (scenario === 'error') return send({ id, error: { code: -32000, message: 'scripted failure' } });

    if (scenario === 'crash') {
      say(sessionId, 'about to crash');
      await sleep(20);
      process.exit(3);
    }

    if (scenario === 'malformed') {
      say(sessionId, 'about to misbehave');
      process.stdout.write('{not json\n');
      return hang();
    }

    if (scenario === 'hang') {
      say(sessionId, 'thinking forever');
      return hang();
    }

    if (scenario === 'slow') {
      for (let i = 0; i < 100; i++) {
        if (session.cancelled) return done('cancelled');
        say(sessionId, 'tick ' + i + ' ');
        await sleep(200);
      }
      return done();
    }

    if (scenario === 'spawn-child') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      say(sessionId, 'child:' + child.pid);
      return hang();
    }

    say(sessionId, 'unknown scenario: ' + scenario);
    return done('refusal');
  }

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const { id, method } = message;
    const params = (message.params ?? {}) as Json;

    if (method === undefined) {
      // A response to one of our requests.
      const resolveIt = pending.get(id as number);
      pending.delete(id as number);
      resolveIt?.((message.result ?? {}) as Json);
      return;
    }
    if (method === 'initialize') {
      return respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
        agentInfo: { name: 'mockpeer', version: '0.0.0' },
      });
    }
    if (method === 'session/new') {
      const sessionId = 'mock-session-' + nextSession++;
      sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), cancelled: false, meta: params._meta });
      return respond(id, { sessionId });
    }
    if (method === 'session/prompt') {
      void prompt(id, params);
      return;
    }
    if (method === 'session/cancel') {
      const session = sessions.get(String(params.sessionId));
      if (session) session.cancelled = true;
      return;
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
  });
  lines.on('close', () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === PEER_PATH) runPeer();
