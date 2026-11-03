// A fake claude-agent-acp for `check:benchmark-coding` section 8. Plain Node, no deps.
//
// It talks ACP on stdio the way Claude Code does, and on its one prompt it:
//   1. calls the model through ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN (Zephyr's gateway);
//   2. if session/new carried an MCP server, initializes it, lists tools and calls
//      zephyr_run_tests over raw streamable HTTP;
//   3. replays BENCH_SOLUTION (the task's reference fix) as native tool calls: PreToolUse
//      hook, session/request_permission, perform, PostToolUse hook;
//   4. writes what it saw to BENCH_OUT.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const pending = new Map();
let nextId = 1;
const request = (method, params) =>
  new Promise((r) => {
    const id = nextId++;
    pending.set(id, r);
    send({ id, method, params });
  });
const sessions = new Map();
const report = { mcpServers: [], model: null, mcp: null, tools: [] };
const out = () => process.env.BENCH_OUT && writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));

const hookUrl = (event) => {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir || !existsSync(resolve(dir, 'settings.json'))) return null;
  const s = JSON.parse(readFileSync(resolve(dir, 'settings.json'), 'utf8'));
  return s.hooks?.[event]?.[0]?.hooks?.find((h) => h.type === 'http')?.url ?? null;
};
const postHook = async (event, body) => {
  const url = hookUrl(event);
  if (!url) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, ...body }),
  });
  return res.ok ? res.json() : null;
};

async function rpc(server, id, method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const h of server.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text();
  if (!res.ok) return { httpStatus: res.status, text };
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}

async function tool(sessionId, cwd, name, input, perform) {
  const toolCallId = 'toolu_' + Math.random().toString(36).slice(2, 10);
  const common = { session_id: sessionId, cwd, tool_name: name, tool_input: input, tool_use_id: toolCallId };
  const pre = await postHook('PreToolUse', common);
  if (pre?.hookSpecificOutput?.permissionDecision === 'deny') return 'hook-denied';
  const kind = name === 'Bash' ? 'execute' : name === 'Read' ? 'read' : 'edit';
  const answer = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId, title: name, kind, status: 'pending', rawInput: input, _meta: { claudeCode: { toolName: name } } },
    options: [
      { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
    ],
  });
  if (!(answer.outcome?.outcome === 'selected' && answer.outcome.optionId === 'yes')) return 'denied';
  perform?.();
  await postHook('PostToolUse', { ...common, tool_response: { success: true } });
  return 'allowed';
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const { cwd, mcpServers } = sessions.get(sessionId);
  const text = (params.prompt ?? []).map((b) => b.text ?? '').join('');

  // 1. One model call through the gateway.
  const base = (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL ?? 'unset';
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer ' + (process.env.ANTHROPIC_AUTH_TOKEN ?? ''),
    },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: text }] }),
  });
  report.model = { status: res.status, requested: model, promptChars: text.length, body: (await res.text()).slice(0, 400) };

  // 2. The shaped tools, when Zephyr's MCP server was offered.
  const zephyr = mcpServers.find((s) => s.name === 'zephyr');
  if (zephyr) {
    await rpc(zephyr, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bench-peer', version: '1' } });
    const listed = await rpc(zephyr, 2, 'tools/list', {});
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    const called = names.includes('zephyr_run_tests')
      ? await rpc(zephyr, 3, 'tools/call', { name: 'zephyr_run_tests', arguments: {} })
      : null;
    report.mcp = { listed: names, listError: listed.error ?? listed.httpStatus ?? null, call: called?.result ?? called?.error ?? null };
  }

  // 3. The reference fix, as native tool calls.
  const steps = JSON.parse(process.env.BENCH_SOLUTION ?? '[]');
  for (const step of steps) {
    const path = step.path ? (isAbsolute(step.path) ? step.path : resolve(cwd, step.path)) : undefined;
    if (step.tool === 'Read') continue; // Claude Code reads without asking
    if (step.tool === 'Write') {
      const v = await tool(sessionId, cwd, 'Write', { file_path: path, content: step.content }, () => writeFileSync(path, step.content));
      report.tools.push('Write:' + v);
    } else if (step.tool === 'Edit') {
      const v = await tool(sessionId, cwd, 'Edit', { file_path: path, old_string: step.find, new_string: step.replace }, () =>
        writeFileSync(path, readFileSync(path, 'utf8').replace(step.find, step.replace)),
      );
      report.tools.push('Edit:' + v);
    } else if (step.tool === 'Bash') {
      const v = await tool(sessionId, cwd, 'Bash', { command: step.command });
      report.tools.push('Bash:' + v);
    }
  }
  out();
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
  send({ id, result: { stopReason: 'end_turn' } });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = m;
  const params = m.params ?? {};
  if (method === undefined) {
    pending.get(id)?.(m.result ?? {});
    pending.delete(id);
    return;
  }
  if (method === 'initialize')
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [], agentInfo: { name: 'bench-peer', version: '0.0.0' } } });
  if (method === 'session/new') {
    const sessionId = 'bench-' + sessions.size;
    sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), mcpServers: params.mcpServers ?? [] });
    report.mcpServers = (params.mcpServers ?? []).map((s) => s.name);
    out();
    return send({ id, result: { sessionId } });
  }
  if (method === 'session/prompt') {
    prompt(id, params).catch((e) => {
      report.error = String(e?.stack ?? e);
      out();
      send({ id, error: { code: -32000, message: String(e?.message ?? e) } });
    });
    return;
  }
  if (method === 'session/cancel') return;
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
});
lines.on('close', () => process.exit(0));
