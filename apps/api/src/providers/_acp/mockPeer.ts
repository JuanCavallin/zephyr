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
 *   permission          ask session/request_permission; write permitted.txt
 *                       and say "allowed" if granted, say "denied" otherwise
 *   error               answer the prompt with a JSON-RPC error
 *   crash               one chunk, then exit(3) mid-turn
 *   malformed           one chunk, then a non-JSON line, then hang
 *   hang                one chunk, then never answer (ignores session/cancel)
 *   slow                a chunk every 200ms; stops with `cancelled` on cancel
 *   spawn-child         start a long-lived grandchild, say `child:<pid>`, hang
 *
 * Run it with `mockPeerHarness()`, which launches it under tsx.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  const sessions = new Map<string, { cwd: string; cancelled: boolean }>();
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
      sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), cancelled: false });
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
