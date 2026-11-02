/**
 * check:hermes-live — the REAL Hermes (`uv run hermes-acp`) over ACP, with no
 * paid model and no network: Hermes's model is a scripted OpenAI-compatible
 * server on loopback, and its AgentOS MCP server is a one-tool fake. Everything
 * between them is the production path: hermesHarness, buildHarnessEnv,
 * hermesProfileConfig, createLiveHermes, AcpClient.
 *
 * Which Hermes: HERMES_CWD, else the `hermes-agent` checkout next to this repo.
 * It needs `uv sync --extra acp --extra mcp` run there once.
 *
 * The scripted model reads one directive from the latest user message:
 *   ZEPHYR {"do":"text","nonce":"…"}            reply "PONG <nonce>"
 *   ZEPHYR {"do":"write","path":"…","content":"…"}  call Hermes's write_file
 *   ZEPHYR {"do":"mcp","nonce":"…"}             call the AgentOS MCP probe tool
 *   ZEPHYR {"do":"hang"}                        never answer (cancellation)
 * After a tool result it replies "TOOL_RESULT <result>" and the turn ends.
 *
 * Opt-in (spawns a real Python agent, ~1 min): not part of check:all.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PERSIST_TO_DISK = 'false';

const { AcpClient } = await import('../src/providers/_acp/client.js');
const { buildHarnessEnv } = await import('../src/providers/_acp/config.js');
const { createLiveHermes, hermesHarness, hermesLaunchContext, hermesProfileConfig } = await import(
  '../src/providers/hermes/live.js'
);
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = await import(
  '@modelcontextprotocol/sdk/server/streamableHttp.js'
);
const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
  '@modelcontextprotocol/sdk/types.js'
);

const here = dirname(fileURLToPath(import.meta.url));
const HERMES_CWD = resolve(process.env.HERMES_CWD ?? join(here, '..', '..', '..', '..', 'hermes-agent'));
const TURN_MS = Number(process.env.HERMES_CHECK_TURN_MS ?? 240_000);

if (!existsSync(join(HERMES_CWD, 'acp_adapter'))) {
  console.error(`check:hermes-live — no Hermes checkout at ${HERMES_CWD}. Set HERMES_CWD.`);
  process.exit(1);
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? error}`);
    await cleanup();
    process.exit(1);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
    }),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(cond: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(200);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/* -------------------------------------------------------------------------- */
/* Process tree                                                               */
/* -------------------------------------------------------------------------- */

function run(file: string, args: string[]): Promise<{ stdout: string; pid?: number }> {
  return new Promise((resolveRun, reject) => {
    const child = execFile(file, args, { windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout) =>
      err ? reject(err) : resolveRun({ stdout, pid: child.pid }),
    );
  });
}

/** Every live descendant of `root`, excluding the helper that listed them. */
async function descendants(root: number): Promise<number[]> {
  const parentOf = new Map<number, number>();
  let helper: number | undefined;
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ]);
    helper = out.pid;
    for (const line of out.stdout.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined) parentOf.set(pid, ppid);
    }
  } else {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // pid (comm) state ppid ... — comm may contain spaces and parens.
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        parentOf.set(Number(name), ppid);
      } catch {
        // exited while listing
      }
    }
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [pid, ppid] of parentOf) {
      if (ppid === parent && pid !== helper && pid !== root && !out.includes(pid)) {
        out.push(pid);
        queue.push(pid);
      }
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* -------------------------------------------------------------------------- */
/* Scripted OpenAI-compatible model                                           */
/* -------------------------------------------------------------------------- */

interface ModelRequest {
  auth: string | undefined;
  tools: string[];
  directive: Record<string, string> | null;
  afterTool: boolean;
}

type ChatMessage = { role: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
      .join('');
  }
  return '';
}

function parseDirective(messages: ChatMessage[]): Record<string, string> | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const match = /ZEPHYR (\{[^\n]*?\})/.exec(textOf(lastUser?.content));
  return match ? (JSON.parse(match[1]!) as Record<string, string>) : null;
}

function createModelServer() {
  const requests: ModelRequest[] = [];
  const hung: ServerResponse[] = [];
  let hangs = 0;

  function reply(
    res: ServerResponse,
    stream: boolean,
    model: string,
    out: { text: string } | { tool: string; args: Record<string, unknown> },
  ) {
    const id = 'chatcmpl-zephyr-' + requests.length;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const toolCall =
      'tool' in out
        ? {
            index: 0,
            id: 'call_' + requests.length,
            type: 'function',
            function: { name: out.tool, arguments: JSON.stringify(out.args) },
          }
        : null;
    const finish = toolCall ? 'tool_calls' : 'stop';
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              finish_reason: finish,
              message: toolCall
                ? { role: 'assistant', content: null, tool_calls: [toolCall] }
                : { role: 'assistant', content: (out as { text: string }).text },
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null, extra = {}) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...extra,
          }) +
          '\n\n',
      );
    chunk({ role: 'assistant', content: '' }, null);
    if (toolCall) chunk({ tool_calls: [toolCall] }, null);
    else chunk({ content: (out as { text: string }).text }, null);
    chunk({}, finish, { usage });
    res.end('data: [DONE]\n\n');
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'agentos-router', object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body || '{}') as {
        model?: string;
        stream?: boolean;
        messages?: ChatMessage[];
        tools?: { function?: { name?: string } }[];
      };
      const messages = parsed.messages ?? [];
      const tools = (parsed.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean);
      const last = messages.at(-1);
      const record: ModelRequest = {
        auth: req.headers.authorization,
        tools,
        directive: parseDirective(messages),
        afterTool: last?.role === 'tool',
      };
      requests.push(record);
      const model = parsed.model ?? 'agentos-router';
      const stream = parsed.stream === true;
      const d = record.directive;

      if (record.afterTool) {
        return reply(res, stream, model, { text: 'TOOL_RESULT ' + textOf(last?.content).slice(0, 400) });
      }
      if (!d) return reply(res, stream, model, { text: 'ok' });
      if (d.do === 'text') return reply(res, stream, model, { text: 'PONG ' + d.nonce });
      if (d.do === 'hang') {
        // Only the first such call hangs; auxiliary calls quoting it get an answer.
        if (hangs++ === 0) {
          hung.push(res);
          return;
        }
        return reply(res, stream, model, { text: 'ok' });
      }
      if (d.do === 'write') {
        const tool = tools.find((t) => t === 'write_file');
        if (!tool) return reply(res, stream, model, { text: 'NO_TOOL write_file in ' + tools.join(',') });
        return reply(res, stream, model, { tool, args: { path: d.path, content: d.content } });
      }
      if (d.do === 'mcp') {
        const tool = tools.find((t) => t.includes('zephyr_probe'));
        if (!tool) return reply(res, stream, model, { text: 'NO_TOOL zephyr_probe in ' + tools.join(',') });
        return reply(res, stream, model, { tool, args: { nonce: d.nonce } });
      }
      return reply(res, stream, model, { text: 'ok' });
    });
  });

  return {
    server,
    requests,
    get hanging() {
      return hung.length > 0;
    },
    releaseHung() {
      for (const res of hung.splice(0)) res.destroy();
      hangs = 0; // the next hang directive hangs again
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fake AgentOS MCP server: one probe tool                                    */
/* -------------------------------------------------------------------------- */

function createMcpServer() {
  const auths = new Set<string>();
  const calls: { nonce: string }[] = [];
  const server = createServer((req, res) => {
    auths.add(req.headers.authorization ?? '<none>');
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless' }, id: null }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const mcp = new Server({ name: 'zephyr-probe', version: '0.0.1' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'zephyr_probe',
            description: 'Echo a nonce back. Used by the Hermes live check.',
            inputSchema: {
              type: 'object',
              properties: { nonce: { type: 'string' } },
              required: ['nonce'],
            },
          },
        ],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        const nonce = String((request.params.arguments ?? {}).nonce ?? '');
        calls.push({ nonce });
        return { content: [{ type: 'text', text: 'probe-ack:' + nonce }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } finally {
        await transport.close().catch(() => undefined);
        await mcp.close().catch(() => undefined);
      }
    });
  });
  return { server, auths, calls };
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const scratch = await mkdtemp(join(tmpdir(), 'zephyr-hermes-check-'));
const model = createModelServer();
const mcp = createMcpServer();
const modelUrl = (await listen(model.server)) + '/v1';
const mcpUrl = (await listen(mcp.server)) + '/mcp';
const nonce = Math.random().toString(36).slice(2, 10);
const modelToken = 'model-token-' + nonce;
const mcpToken = 'mcp-token-' + nonce;
const openClients: { close(): Promise<void> }[] = [];

async function cleanup(): Promise<void> {
  await Promise.all(openClients.map((c) => c.close().catch(() => undefined)));
  model.releaseHung();
  model.server.closeAllConnections();
  mcp.server.closeAllConnections();
  model.server.close();
  mcp.server.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
}

console.log(`check:hermes-live — Hermes at ${HERMES_CWD} (${process.platform})`);

/* -------------------------------------------------------------------------- */
/* 1. The production adapter: createLiveHermes start / poll / continue / cancel */
/* -------------------------------------------------------------------------- */

const adapter = createLiveHermes({
  mode: 'live',
  keyVar: 'HERMES_CWD',
  cwd: HERMES_CWD,
  baseUrl: modelUrl,
  mcpUrl,
  profileDir: join(scratch, 'scopes'),
});
const ctx = {
  runId: 'run_hermescheck',
  policyRule: 'check:hermes-live',
  sessionStateId: 'ss_hermescheck0001',
  gatewayCredentials: { model: modelToken, mcp: mcpToken, profileId: 'profile-check' },
};

async function settle(taskId: string) {
  let last: unknown;
  await within(
    eventually(async () => {
      const polled = await adapter.pollTask(taskId, ctx);
      assert(polled.ok, 'pollTask failed: ' + JSON.stringify(polled));
      last = polled.data;
      return polled.data.status !== 'running';
    }, TURN_MS, 'task to settle'),
    TURN_MS + 1000,
    'poll',
  );
  return last as { status: string; result?: { text?: string }; log?: string[] };
}

let taskId = '';

// Processes this script already owns before Hermes starts (tsx's esbuild service).
const baseline = new Set(await descendants(process.pid));

await test('adapter: refuses to start without a scoped gateway binding', async () => {
  const r = await adapter.startTask({ goal: 'x' }, { runId: 'run_hermescheck', policyRule: 'check' });
  assert(!r.ok && r.error.code === 'AUTH', 'expected AUTH failure, got ' + JSON.stringify(r));
});

await test('adapter: startTask -> real Hermes answers through the scripted model', async () => {
  const started = await adapter.startTask(
    { goal: `ZEPHYR {"do":"text","nonce":"first-${nonce}"}` },
    ctx,
  );
  assert(started.ok, 'startTask failed: ' + JSON.stringify(started));
  taskId = started.data.taskId;
  const done = await settle(taskId);
  assert(done.status === 'done', 'task did not finish: ' + JSON.stringify(done));
  assert(done.result?.text?.includes(`PONG first-${nonce}`), 'wrong result: ' + JSON.stringify(done));
});

await test('adapter: the profile scopes credentials to this run', async () => {
  const main = model.requests.filter((r) => r.directive);
  assert(main.length > 0, 'the model never saw the prompt');
  const auths = new Set(model.requests.map((r) => r.auth));
  assert(
    auths.size === 1 && auths.has('Bearer ' + modelToken),
    'model calls must carry only the run token, saw ' + [...auths].join(', '),
  );
  const config = readFileSync(join(scratch, 'scopes', 'profile-check', 'config.yaml'), 'utf8');
  assert(config.includes(JSON.stringify(modelUrl)) && config.includes(JSON.stringify(mcpUrl)), 'profile urls');
  assert(!config.includes(modelToken) && !config.includes(mcpToken), 'a secret was written to the profile');
  await eventually(() => mcp.auths.size > 0, 30_000, 'Hermes to reach the MCP server');
  assert(
    [...mcp.auths].every((a) => a === 'Bearer ' + mcpToken),
    'MCP calls must carry only the run MCP token, saw ' + [...mcp.auths].join(', '),
  );
});

await test('adapter: continueTask keeps the same Hermes session', async () => {
  const cont = await adapter.continueTask(
    taskId,
    { instruction: `ZEPHYR {"do":"text","nonce":"second-${nonce}"}` },
    ctx,
  );
  assert(cont.ok, 'continueTask failed: ' + JSON.stringify(cont));
  const done = await settle(taskId);
  assert(done.result?.text?.includes(`PONG second-${nonce}`), 'wrong result: ' + JSON.stringify(done));
});

await test('adapter: cancelTask stops a hung turn and kills the Hermes process tree', async () => {
  const before = (await descendants(process.pid)).filter((pid) => !baseline.has(pid));
  assert(before.length >= 1, 'no Hermes process found under this process');
  const cont = await adapter.continueTask(taskId, { instruction: 'ZEPHYR {"do":"hang"}' }, ctx);
  assert(cont.ok, 'continueTask failed: ' + JSON.stringify(cont));
  await within(eventually(() => model.hanging, TURN_MS, 'the hung model call'), TURN_MS + 1000, 'hang');
  const cancelled = await within(adapter.cancelTask(taskId, ctx), 30_000, 'cancelTask');
  assert(cancelled.ok, 'cancelTask failed');
  await eventually(() => before.every((pid) => !alive(pid)), 15_000, 'Hermes processes to exit');
  const polled = await adapter.pollTask(taskId, ctx);
  assert(!polled.ok && polled.error.code === 'BAD_INPUT', 'a cancelled task must be forgotten');
  model.releaseHung();
});

/* -------------------------------------------------------------------------- */
/* 2. The ACP client against real Hermes: permissions, MCP, cancel, tree kill   */
/* -------------------------------------------------------------------------- */

const profileDir = join(scratch, 'client-profile');
await mkdir(profileDir, { recursive: true });
await writeFile(join(profileDir, 'config.yaml'), hermesProfileConfig(modelUrl, mcpUrl), 'utf8');
const workDir = join(scratch, 'work');
await mkdir(workDir, { recursive: true });

let verdict: 'allow' | 'deny' = 'deny';
const permissionRequests: { toolName: string; rawInput: unknown }[] = [];
const client = await within(
  AcpClient.start({
    harness: hermesHarness,
    cwd: HERMES_CWD,
    env: buildHarnessEnv(
      hermesHarness,
      hermesLaunchContext(
        { mode: 'live', keyVar: 'HERMES_CWD', cwd: HERMES_CWD, baseUrl: modelUrl, mcpUrl, apiKey: modelToken, mcpApiKey: mcpToken },
        profileDir,
      ),
    ),
    stderr: process.env.HERMES_CHECK_VERBOSE ? 'inherit' : 'ignore',
    log: (m) => console.error('[hermes] ' + m),
    onPermission: (request) => {
      permissionRequests.push({ toolName: request.toolName, rawInput: request.rawInput });
      return verdict;
    },
  }),
  TURN_MS,
  'AcpClient.start',
);
openClients.push(client);
const session = await within(client.newSession({ cwd: workDir }), TURN_MS, 'session/new');

async function turn(directive: Record<string, string>) {
  const events: { type: string; text?: string; title?: string }[] = [];
  const terminal = await within(
    session.prompt('ZEPHYR ' + JSON.stringify(directive), (e) =>
      events.push(
        e.type === 'text'
          ? { type: 'text', text: e.text }
          : e.type === 'tool_call'
            ? { type: 'tool_call', title: e.title }
            : { type: e.type },
      ),
    ),
    TURN_MS,
    'turn ' + directive.do,
  );
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  return { terminal, events, text };
}

await test('client: initialize + session/new against real Hermes', async () => {
  assert(client.pid, 'no pid');
  assert(session.sessionId.length > 0, 'empty session id');
  assert(client.deadReason() === null, 'client unusable: ' + client.deadReason());
});

await test('client: a denied write_file permission writes nothing (fail closed)', async () => {
  verdict = 'deny';
  const target = join(workDir, 'denied.txt');
  const r = await turn({ do: 'write', path: target, content: 'must-not-exist' });
  assert(r.terminal.kind === 'completed', 'turn: ' + JSON.stringify(r.terminal));
  assert(!r.text.includes('NO_TOOL'), 'Hermes offered no write_file tool: ' + r.text);
  assert(permissionRequests.length >= 1, 'Hermes never asked for permission');
  assert(!existsSync(target), 'denied write still created the file');
  assert(r.text.includes('TOOL_RESULT'), 'the model never got the denial back: ' + r.text);
});

await test('client: an allowed write_file permission writes the file', async () => {
  verdict = 'allow';
  const asked = permissionRequests.length;
  const target = join(workDir, 'allowed.txt');
  const r = await turn({ do: 'write', path: target, content: 'written-by-hermes-' + nonce });
  assert(r.terminal.kind === 'completed', 'turn: ' + JSON.stringify(r.terminal));
  assert(permissionRequests.length > asked, 'Hermes did not ask for this write');
  assert(existsSync(target), 'allowed write did not create the file');
  assert(readFileSync(target, 'utf8') === 'written-by-hermes-' + nonce, 'wrong file content');
  assert(r.events.some((e) => e.type === 'tool_call'), 'no tool_call event was streamed');
  verdict = 'deny';
});

await test('client: Hermes calls the AgentOS MCP tool with the run MCP token', async () => {
  const r = await turn({ do: 'mcp', nonce: 'mcp-' + nonce });
  assert(r.terminal.kind === 'completed', 'turn: ' + JSON.stringify(r.terminal));
  assert(!r.text.includes('NO_TOOL'), 'Hermes did not expose the MCP tool: ' + r.text);
  assert(
    mcp.calls.some((c) => c.nonce === 'mcp-' + nonce),
    'the MCP server never received the call',
  );
  assert(r.text.includes('probe-ack:mcp-' + nonce), 'the MCP result never reached the model: ' + r.text);
});

await test('client: session/cancel ends a hung turn as cancelled', async () => {
  model.releaseHung();
  const hangsBefore = model.requests.filter((r) => r.directive?.do === 'hang').length;
  const pending = session.prompt('ZEPHYR {"do":"hang"}');
  await eventually(
    () => model.requests.filter((r) => r.directive?.do === 'hang').length > hangsBefore,
    TURN_MS,
    'the model call',
  );
  const terminal = await within(session.cancel({ graceMs: 20_000 }), 30_000, 'cancel');
  assert(terminal.kind === 'cancelled', 'expected cancelled, got ' + JSON.stringify(terminal));
  const settled = await pending;
  assert(settled.kind === 'cancelled', 'prompt promise disagrees: ' + JSON.stringify(settled));
});

await test('client: close() kills uv and the Python it started', async () => {
  const tree = await descendants(client.pid!);
  const all = [client.pid!, ...tree];
  assert(all.length >= 2, 'expected uv plus Python, saw ' + all.join(','));
  await client.close();
  await eventually(() => all.every((pid) => !alive(pid)), 15_000, 'every Hermes process to exit');
});

await cleanup();
console.log(`check:hermes-live — ${passed} passed`);
process.exit(0);
