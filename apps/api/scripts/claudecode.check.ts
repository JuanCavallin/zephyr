/**
 * Step 3 check: Claude Code and the native-tool gate.
 *
 *   pnpm check:claudecode
 *
 * 1. Shell classifier, table-driven (posix and PowerShell rows).
 * 2. Path containment: `../`, symlink/junction escape, absolute, drive and UNC paths.
 * 3. Permission bridge: every spec-table row gets its default; unmapped tools deny.
 * 4. git.publish approvals are bound to (branch, diff hash).
 * 5. Hook routes: expired/unknown/foreign token → 401, PreToolUse deny/ask,
 *    PostToolUse → tool.lifecycle, observed Stop → harness.turn.ended.
 * 6. Observed mode: snippet generator and OTel ingest from recorded fixtures.
 * 7. End to end on the mock ACP peer acting as Claude Code: worktree edit
 *    auto-allowed, outside write denied by the hook AND by the ACP path,
 *    `git push` waits for approval then proceeds, a checkpoint before every turn.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NativeToolRequest, RunEvent, StoredEvent } from '@htn/shared';

const { classifyShell } = await import('../src/core/tools/shellClassifier.js');
const { containPath, hostPlatform } = await import('../src/core/tools/pathContainment.js');
const { mapNativeTool, UnmappedToolError } = await import('../src/core/tools/nativeDescriptors.js');
const { createPermissionBridge, pushedBranch } = await import('../src/core/tools/permissionBridge.js');
const { RunToolApprovalGate } = await import('../src/core/tools/approval.js');
const { settleApproval } = await import('../src/core/approvalGate.js');
const { RunBus } = await import('../src/core/bus.js');
const { SessionStateService } = await import('../src/core/sessions/service.js');
const { createMemoryStore } = await import('../src/store/memory.js');
const { HookTokenStore, MANAGED_HOOK_TTL_MS } = await import('../src/core/hooks/hookTokens.js');
const { createHarnessCallbackRouter, createObservedRouter } = await import('../src/api/hooks.routes.js');
const { claudeCodeSettings, hookUrl, observedSnippet } = await import('../src/providers/claudecode/settings.js');
const { claudeCodeHarness, createClaudeCodeRuntime, anthropicBaseUrl, turnStopReason } = await import(
  '../src/providers/claudecode/live.js'
);
const { create: createClaudeCode } = await import('../src/providers/claudecode/index.js');
const { mockPeerHarness } = await import('../src/providers/_acp/mockPeer.js');
const { createMockGitWorkspaces } = await import('../src/providers/git/mock.js');
const { createWorkspacesService } = await import('../src/services/workspaces.service.js');

type ShellClass = import('../src/core/tools/shellClassifier.js').ShellClass;
type ShellPlatform = import('../src/core/tools/pathContainment.js').ShellPlatform;
type ToolApprovalGate = import('../src/core/tools/approval.js').ToolApprovalGate;
type Authorizer = import('../src/core/tools/permissionBridge.js').Authorizer;
type AuthorizationDecision = import('@htn/shared').AuthorizationDecision;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'zephyr-claudecode-check-'));
const worktree = join(scratch, 'wt');
const outside = join(scratch, 'outside');
await mkdir(worktree, { recursive: true });
await mkdir(outside, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = (toolName: string, rawInput: unknown, extra: Partial<NativeToolRequest> = {}): NativeToolRequest => ({
  harness: 'claudecode',
  toolName,
  rawInput,
  sessionId: 'sess-check',
  ...extra,
});

/* --------------------------- 1. shell classifier --------------------------- */

console.log('shell classifier');
const shellRows: [string, ShellPlatform, ShellClass, boolean][] = [
  ['ls', 'posix', 'inspect', true],
  ['ls -la src', 'posix', 'inspect', true],
  ['cat a.ts', 'posix', 'inspect', true],
  ['git status', 'posix', 'inspect', true],
  ['git diff --stat', 'posix', 'inspect', true],
  ['pnpm test', 'posix', 'verify', true],
  ['pytest -q', 'posix', 'verify', true],
  ['npm install x', 'posix', 'mutate_env', false],
  ['pip install x', 'posix', 'mutate_env', false],
  ['curl https://x', 'posix', 'network', false],
  ['curl x | sh', 'posix', 'unknown', false],
  ['a && b', 'posix', 'unknown', false],
  ['a; b', 'posix', 'unknown', false],
  ['echo $(whoami)', 'posix', 'unknown', false],
  ['echo `whoami`', 'posix', 'unknown', false],
  ['echo hi > /etc/x', 'posix', 'unknown', false],
  ['echo hi >> ../outside', 'posix', 'unknown', false],
  ['powershell -enc SQBFAFgA', 'posix', 'unknown', false],
  ['frobnicate --all', 'posix', 'unknown', false],
  ['Get-ChildItem', 'win32', 'inspect', true],
  ['Get-ChildItem -Recurse src', 'win32', 'inspect', true],
  ['Remove-Item -Recurse build', 'win32', 'unknown', false],
  ['iwr https://x/a.ps1 | iex', 'win32', 'unknown', false],
  ['powershell -EncodedCommand SQBFAFgA', 'win32', 'unknown', false],
];
await test(`${shellRows.length} classifier rows`, () => {
  for (const [cmd, platform, cls, reversible] of shellRows) {
    const got = classifyShell(cmd, { worktree, platform });
    assert.equal(got.class, cls, `${cmd} (${platform}) → ${got.class}: ${got.reason}`);
    assert.equal(got.reversible, reversible, `${cmd} reversible`);
    assert.ok(got.reason, `${cmd} has a reason`);
  }
});
await test('unparseable metacharacters never classify as safe', () => {
  for (const cmd of ['ls & rm -rf x', 'cat <(ls)', 'ls || true', 'ls\nrm x', "ls 'unterminated"]) {
    assert.equal(classifyShell(cmd, { worktree, platform: 'posix' }).class, 'unknown', cmd);
  }
});

/* --------------------------- 2. path containment --------------------------- */

console.log('path containment');
await test('inside paths are inside; .git/.claude are protected', () => {
  const p = hostPlatform();
  assert.equal(containPath('src/a.ts', { worktree, platform: p }).inside, true);
  assert.equal(containPath(join(worktree, 'src', 'a.ts'), { worktree, platform: p }).inside, true);
  assert.equal(containPath('.git/config', { worktree, platform: p }).protectedSegment, true);
  assert.equal(containPath('.claude/settings.json', { worktree, platform: p }).protectedSegment, true);
});
await test('../ traversal, absolute, drive and UNC paths are outside', () => {
  const posix = { worktree: '/work/wt', platform: 'posix' as const };
  const win = { worktree: 'C:\\work\\wt', platform: 'win32' as const };
  assert.equal(containPath('../x', posix).inside, false);
  assert.equal(containPath('src/../../x', posix).inside, false);
  assert.equal(containPath('/etc/passwd', posix).inside, false);
  assert.equal(containPath('C:\\Windows\\system.ini', posix).inside, false);
  assert.equal(containPath('..\\x', win).inside, false);
  assert.equal(containPath('D:\\x', win).inside, false);
  assert.equal(containPath('C:\\Windows\\system.ini', win).inside, false);
  assert.equal(containPath('\\\\server\\share\\x', win).inside, false);
  assert.equal(containPath('//server/share/x', win).inside, false);
  assert.equal(containPath('D:x', win).inside, false);
});
await test('a symlink or junction escaping the worktree is outside', async () => {
  const link = join(worktree, 'escape');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const got = containPath('escape/secret.txt', { worktree, platform: hostPlatform() });
  assert.equal(got.inside, false, got.reason);
  await rm(link, { force: true, recursive: false }).catch(() => {});
});
await test('fs.* outside the worktree maps to irreversible + deny', () => {
  for (const [tool, input] of [
    ['Write', { file_path: '../x', content: 'y' }],
    ['Edit', { file_path: join(outside, 'x'), old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: '/etc/passwd' }],
  ] as const) {
    const exact = mapNativeTool(req(tool, input), { worktree, platform: hostPlatform() });
    assert.equal(exact.defaultPolicy, 'deny', tool);
    assert.equal(exact.descriptor.reversibility, 'irreversible', tool);
  }
});

/* ---------------------------- 3. bridge defaults --------------------------- */

console.log('permission bridge');
const decision = (allowed: boolean, finalPolicy: 'auto' | 'deny', reasonCodes: string[] = []) =>
  ({ actionId: 'check', recommendation: finalPolicy, finalPolicy, allowed, reasonCodes, at: new Date().toISOString() }) as unknown as AuthorizationDecision;
const allowAll: Authorizer = async () => decision(true, 'auto');
const binding = { branch: 'zephyr/run_x', diffHash: 'hash-a' };
const tableRows: [string, unknown, string, 'auto' | 'ask_user' | 'deny'][] = [
  ['Read', { file_path: 'src/a.ts' }, 'fs.read', 'auto'],
  ['Grep', { pattern: 'x', path: 'src' }, 'fs.read', 'auto'],
  ['Write', { file_path: 'src/a.ts', content: 'x' }, 'fs.write', 'auto'],
  ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'fs.write', 'auto'],
  ['Write', { file_path: '../outside.txt', content: 'x' }, 'fs.write', 'deny'],
  ['Write', { file_path: '.git/config', content: 'x' }, 'fs.write', 'deny'],
  ['Bash', { command: 'git status' }, 'shell.exec', 'auto'],
  ['Bash', { command: 'pnpm test' }, 'shell.exec', 'auto'],
  ['Bash', { command: 'npm install left-pad' }, 'shell.exec', 'ask_user'],
  ['Bash', { command: 'curl https://example.com' }, 'shell.exec', 'ask_user'],
  ['Bash', { command: 'frobnicate' }, 'shell.exec', 'ask_user'],
  ['PowerShell', { command: 'Get-ChildItem' }, 'shell.exec', 'auto'],
  ['PowerShell', { command: 'Remove-Item -Recurse build' }, 'shell.exec', 'ask_user'],
  ['Bash', { command: 'git commit -m "wip"' }, 'git.commit', 'auto'],
  ['Bash', { command: 'git push origin zephyr/run_x' }, 'git.publish', 'ask_user'],
  ['Bash', { command: 'gh pr create --fill' }, 'git.publish', 'ask_user'],
  ['Bash', { command: 'gh pr merge 12' }, 'git.publish', 'ask_user'],
  ['WebFetch', { url: 'https://example.com', prompt: 'x' }, 'http.fetch', 'auto'],
  ['WebSearch', { query: 'acp spec' }, 'http.fetch', 'auto'],
];
await test(`${tableRows.length} spec-table rows map to their default`, async () => {
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree,
    platform: 'posix',
    authorize: allowAll,
    publishBinding: async () => binding,
  });
  for (const [tool, input, toolId, policy] of tableRows) {
    const d = await bridge.preview(req(tool, input));
    assert.equal(d.exact?.toolId, toolId, `${tool} ${JSON.stringify(input)} → ${d.exact?.toolId}`);
    assert.equal(d.policy, policy, `${tool} ${JSON.stringify(input)} → ${d.policy}: ${d.reason}`);
    assert.equal(d.verdict, policy === 'auto' ? 'allow' : 'deny');
  }
});
await test('the authorizer can only make a row stricter', async () => {
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree,
    platform: 'posix',
    authorize: async () => decision(false, 'deny', ['blocked-host']),
  });
  const d = await bridge.decide(req('WebFetch', { url: 'https://evil.example', prompt: 'x' }));
  assert.equal(d.verdict, 'deny');
  assert.equal(d.policy, 'deny');
});
await test('unmapped tools and foreign MCP tools deny', async () => {
  const bridge = createPermissionBridge({ harness: 'claudecode', worktree, platform: 'posix', authorize: allowAll });
  assert.throws(() => mapNativeTool(req('Teleport', {}), { worktree, platform: 'posix' }), UnmappedToolError);
  for (const name of ['Teleport', 'mcp__github__create_issue']) {
    const d = await bridge.decide(req(name, {}));
    assert.equal(d.verdict, 'deny', name);
    assert.equal(d.policy, 'deny', name);
  }
  assert.equal(await bridge.handler(req('Bash', {})), 'deny', 'shell without a command');
});
await test('ask_user with no approval gate bound denies', async () => {
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree,
    platform: 'posix',
    authorize: allowAll,
    run: { runId: 'run_x', stepId: 'step_x' },
  });
  const d = await bridge.decide(req('Bash', { command: 'npm install x' }));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /no approval gate/);
});

/* ------------------------- 4. publish hash binding ------------------------- */

console.log('git.publish binding');
await test('pushedBranch reads the pushed ref', () => {
  assert.equal(pushedBranch('git push origin zephyr/a', 'fb'), 'zephyr/a');
  assert.equal(pushedBranch('git push -u origin HEAD:zephyr/b', 'fb'), 'zephyr/b');
  assert.equal(pushedBranch('git push', 'fb'), 'fb');
});
await test('an approval for one diff hash does not authorize another', async () => {
  let hash = 'hash-a';
  const requests: { branch: unknown; diffHash: unknown; review: unknown }[] = [];
  const approvals: ToolApprovalGate = {
    async request({ action }) {
      const args = action.arguments as Record<string, unknown>;
      requests.push({ branch: args.branch, diffHash: args.diffHash, review: action.review });
      return { approvalId: 'apr_' + requests.length };
    },
  };
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree,
    platform: 'posix',
    authorize: allowAll,
    run: { runId: 'run_x', stepId: 'step_x' },
    approvals,
    publishBinding: async () => ({ branch: 'zephyr/run_x', diffHash: hash }),
  });
  const push = req('Bash', { command: 'git push origin zephyr/run_x' });

  const first = await bridge.decide(push);
  assert.equal(first.verdict, 'allow');
  assert.deepEqual(requests[0], {
    branch: 'zephyr/run_x',
    diffHash: 'hash-a',
    review: { operation: 'push', branch: 'zephyr/run_x', diffHash: 'hash-a' },
  });

  const again = await bridge.decide(push);
  assert.equal(again.reusedGrant, true, 'same branch + hash reuses the approval');
  assert.equal(requests.length, 1);

  hash = 'hash-b';
  const preview = await bridge.preview(push);
  assert.equal(preview.verdict, 'deny', 'a new hash is not covered by the old approval');
  const changed = await bridge.decide(push);
  assert.equal(requests.length, 2, 'a new hash asks again');
  assert.equal(requests[1]!.diffHash, 'hash-b');
  assert.notEqual(changed.reusedGrant, true);
});
await test('git.publish without a workspace binding denies', async () => {
  const bridge = createPermissionBridge({ harness: 'claudecode', worktree, platform: 'posix', authorize: allowAll });
  const d = await bridge.decide(req('Bash', { command: 'git push' }));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reason, /binding/);
});

/* ------------------------------- 5. hooks --------------------------------- */

console.log('hook routes');
const store = createMemoryStore();
const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
const sessions = new SessionStateService(store, bus);
const events: StoredEvent[] = [];
bus.subscribeAll((e) => events.push(e));
const eventsOf = (runId: string, type: RunEvent['type']) =>
  events.filter((e) => e.runId === runId && e.event.type === type).map((e) => e.event);

let clock = Date.now();
const tokens = new HookTokenStore({ now: () => clock });
const app = express();
app.use(express.json({ limit: '2mb' }));
const harnessDeps = { tokens, store, emit: (runId: string, event: RunEvent) => bus.emit(runId, event) };
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const api = express.Router();
api.use(createHarnessCallbackRouter(harnessDeps));
api.use(createObservedRouter({ ...harnessDeps, apiBaseUrl }));
app.use('/api', api);

const post = async (path: string, body: unknown) => {
  const res = await fetch(apiBaseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

async function seedRun(runId: string, harness = 'claudecode') {
  const at = new Date().toISOString();
  await store.createRun({ id: runId, kind: 'check', title: runId, status: 'running', input: {}, createdAt: at, updatedAt: at });
  const stepId = runId + '_step';
  await store.appendStep({ id: stepId, runId, parentStepId: null, kind: 'tool', label: 'claude code', status: 'running', startedAt: at });
  const s = await sessions.create({
    runId,
    stepId,
    harness: harness as never,
    objective: 'check',
    dataLabels: ['local_only'],
    budget: { stepsRemaining: 20 },
  });
  return { runId, stepId, sessionStateId: s.id };
}

const hookRun = await seedRun('run_hooks');
const hookBridge = createPermissionBridge({
  harness: 'claudecode',
  worktree,
  platform: 'posix',
  run: hookRun,
  authorize: allowAll,
  onLifecycle: (lifecycle) => bus.emit(hookRun.runId, { type: 'tool.lifecycle', lifecycle }).then(() => {}),
  publishBinding: async () => binding,
});
const managedToken = tokens.mint({ harness: 'claudecode', ...hookRun, mode: 'managed', bridge: hookBridge }, MANAGED_HOOK_TTL_MS);
const pre = (tool: string, input: unknown) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'sess-1',
  cwd: worktree,
  tool_name: tool,
  tool_input: input,
  tool_use_id: 'toolu_1',
});

await test('settings.json carries http hooks to the scoped token URL', () => {
  const url = hookUrl(apiBaseUrl, managedToken);
  assert.equal(url, `${apiBaseUrl}/api/hooks/claudecode/${encodeURIComponent(managedToken)}`);
  const s = claudeCodeSettings({ hookUrl: url });
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
    assert.equal(s.hooks[event][0]!.hooks[0]!.type, 'http');
    assert.equal(s.hooks[event][0]!.hooks[0]!.url, url);
  }
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(JSON.stringify(s).includes('"allow"'), false, 'no permissions.allow rules');
});
await test('unknown, foreign-harness and expired tokens → 401', async () => {
  assert.equal((await post('/api/hooks/claudecode/not-a-token', pre('Read', { file_path: 'a' }))).status, 401);
  assert.equal((await post(`/api/hooks/codex/${managedToken}`, pre('Read', { file_path: 'a' }))).status, 401);
  assert.equal((await post(`/api/otel/not-a-token/v1/logs`, {})).status, 401);
  const shortLived = tokens.mint({ harness: 'claudecode', ...hookRun, mode: 'managed', bridge: hookBridge }, 1_000);
  assert.equal((await post(`/api/hooks/claudecode/${shortLived}`, pre('Read', { file_path: 'a' }))).status, 200);
  clock += 1_001;
  const expired = await post(`/api/hooks/claudecode/${shortLived}`, pre('Read', { file_path: 'a' }));
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'UNAUTHORIZED');
  tokens.revoke(managedToken);
  assert.equal((await post(`/api/hooks/claudecode/${managedToken}`, pre('Read', { file_path: 'a' }))).status, 401);
});
const liveToken = tokens.mint({ harness: 'claudecode', ...hookRun, mode: 'managed', bridge: hookBridge }, MANAGED_HOOK_TTL_MS);
await test('PreToolUse: deny outside, ask for push, pass-through for auto (never allow)', async () => {
  const url = `/api/hooks/claudecode/${liveToken}`;
  const denied = await post(url, pre('Write', { file_path: '../x', content: 'y' }));
  assert.equal(denied.body.hookSpecificOutput.permissionDecision, 'deny');
  const asked = await post(url, pre('Bash', { command: 'git push origin zephyr/run_x' }));
  assert.equal(asked.body.hookSpecificOutput.permissionDecision, 'ask');
  const auto = await post(url, pre('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }));
  assert.deepEqual(auto.body, {});
  const unmapped = await post(url, pre('Teleport', {}));
  assert.equal(unmapped.body.hookSpecificOutput.permissionDecision, 'deny');
  const noTool = await post(url, { hook_event_name: 'PreToolUse' });
  assert.equal(noTool.body.hookSpecificOutput.permissionDecision, 'deny');
});
await test('PostToolUse → tool.lifecycle succeeded/failed', async () => {
  const url = `/api/hooks/claudecode/${liveToken}`;
  const before = eventsOf(hookRun.runId, 'tool.lifecycle').length;
  await post(url, { ...pre('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), hook_event_name: 'PostToolUse', tool_response: { success: true } });
  await post(url, { ...pre('Bash', { command: 'pnpm test' }), hook_event_name: 'PostToolUse', tool_response: { success: false, error: '2 failed' } });
  const lifecycle = eventsOf(hookRun.runId, 'tool.lifecycle').slice(before) as Extract<RunEvent, { type: 'tool.lifecycle' }>[];
  assert.deepEqual(lifecycle.map((e) => e.lifecycle.phase), ['succeeded', 'failed']);
  assert.equal(lifecycle[0]!.lifecycle.action.toolId, 'fs.write');
  assert.equal(lifecycle[0]!.lifecycle.sessionStateId, hookRun.sessionStateId);
  assert.equal(lifecycle[1]!.lifecycle.error?.message, '2 failed');
});
await test('managed Stop does not duplicate the ACP turn end', async () => {
  const before = eventsOf(hookRun.runId, 'harness.turn.ended').length;
  const res = await post(`/api/hooks/claudecode/${liveToken}`, { hook_event_name: 'Stop', session_id: 'sess-1' });
  assert.equal(res.status, 200);
  assert.equal(eventsOf(hookRun.runId, 'harness.turn.ended').length, before);
});

/* ---------------------------- 6. observed mode ---------------------------- */

console.log('observed mode');
let observed: { runId: string; snippet: ReturnType<typeof observedSnippet> };
await test('POST /observed/claudecode creates an external run and a snippet', async () => {
  assert.equal((await post('/api/observed/claudecode', {})).status, 400);
  const res = await post('/api/observed/claudecode', { cwd: worktree, title: 'My session' });
  assert.equal(res.status, 201);
  observed = res.body as typeof observed;
  const run = await store.getRun(observed.runId);
  assert.equal(run?.kind, 'external');
  assert.equal(run?.title, 'My session');
  const s = observed.snippet;
  assert.match(s.hookUrl, /\/api\/hooks\/claudecode\/[A-Za-z0-9_-]+$/);
  assert.match(s.otelEndpoint, /\/api\/otel\/[A-Za-z0-9_-]+$/);
  assert.equal(s.settings.hooks.PreToolUse[0]!.hooks[0]!.url, s.hookUrl);
  assert.equal(s.settings.env?.OTEL_EXPORTER_OTLP_ENDPOINT, s.otelEndpoint);
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
});
await test('observed PreToolUse still denies; Stop → harness.turn.ended', async () => {
  const denied = await post(new URL(observed.snippet.hookUrl).pathname, pre('Write', { file_path: '/etc/passwd', content: 'x' }));
  assert.equal(denied.body.hookSpecificOutput.permissionDecision, 'deny');
  await post(new URL(observed.snippet.hookUrl).pathname, { hook_event_name: 'Stop', session_id: 'sess-observed' });
  const ended = eventsOf(observed.runId, 'harness.turn.ended') as Extract<RunEvent, { type: 'harness.turn.ended' }>[];
  assert.equal(ended.length, 1);
  assert.equal(ended[0]!.harness, 'claudecode');
  assert.equal(ended[0]!.sessionId, 'sess-observed');
});
await test('OTel logs fixture → tool steps and token totals on the external run', async () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'claudecode-otel-logs.json'), 'utf8'));
  const otel = new URL(observed.snippet.otelEndpoint).pathname;
  const res = await post(otel + '/v1/logs', fixture);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 5);
  const run = await store.getRun(observed.runId);
  const totals = (run?.result as any).totals;
  assert.equal(totals.toolCalls, 3);
  assert.equal(totals.toolFailures, 1);
  assert.equal(totals.tokensIn, 3800);
  assert.equal(totals.tokensOut, 850);
  assert.equal(totals.cacheReadTokens, 2700);
  assert.equal(totals.cacheCreationTokens, 300);
  assert.equal(totals.costUsd, 0.024);
  assert.equal(totals.apiRequests, 2);
  assert.deepEqual(totals.models, ['claude-sonnet-5-5']);
  assert.equal(run?.summary, '3 tool calls, 3800 in / 850 out tokens');
  const steps = (await store.listSteps(observed.runId)).filter((s) => s.kind === 'tool');
  assert.deepEqual(steps.map((s) => [s.label, s.status]), [
    ['Read', 'succeeded'],
    ['Edit', 'succeeded'],
    ['Bash', 'failed'],
  ]);
  assert.equal(steps[2]!.error?.message, 'Exit code 1: 2 tests failed');
  assert.equal((steps[0]!.input as any).sessionId, 'sess-observed-fixture');
});
await test('OTel metrics fixture → metric cross-check totals', async () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'claudecode-otel-metrics.json'), 'utf8'));
  const res = await post(new URL(observed.snippet.otelEndpoint).pathname + '/v1/metrics', fixture);
  assert.equal(res.body.accepted, 4);
  const totals = ((await store.getRun(observed.runId))?.result as any).totals;
  assert.deepEqual(totals.metricTokens, { input: 3800, output: 850 });
  assert.equal(totals.metricCostUsd, 0.024);
  assert.equal(totals.toolCalls, 3, 'metrics do not disturb log totals');
});

/* ------------------------- 7. end to end, mock peer ------------------------ */

console.log('end to end (mock ACP peer as Claude Code)');
await test('adapter helpers', () => {
  assert.equal(anthropicBaseUrl('http://127.0.0.1:8787/v1/'), 'http://127.0.0.1:8787');
  assert.equal(turnStopReason({ kind: 'cancelled' } as never), 'cancelled');
  assert.equal(turnStopReason({ kind: 'completed', stopReason: 'max_turn_requests' } as never), 'max_tokens');
  const h = claudeCodeHarness({ binary: '/x/dist/index.js' });
  assert.equal(h.binary, process.execPath);
  assert.deepEqual(h.args, ['/x/dist/index.js']);
  assert.deepEqual(h.gatewayEnv('http://gw', 't'), { ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_AUTH_TOKEN: 't' });
  assert.equal(h.env({ cwd: worktree, gateway: { url: '', token: '' }, stateDir: '/s' }).CLAUDE_CONFIG_DIR, '/s');
});
await test('registry entry: mock by default, live without a binary refuses', async () => {
  const mock = createClaudeCode({ id: 'claudecode', mode: 'mock' } as never);
  assert.equal(mock.mode, 'mock');
  assert.equal(await mock.onPermissionRequest!(req('Read', { file_path: 'a' }), { runId: 'r', policyRule: 'x' }), 'deny');
  const live = createClaudeCode({ id: 'claudecode', mode: 'live' } as never);
  const started = await live.startTask({ goal: 'x' }, { runId: 'r', policyRule: 'x' });
  assert.equal(started.ok, false);
  assert.equal(await live.onPermissionRequest!(req('Read', { file_path: 'a' }), { runId: 'r', policyRule: 'x' }), 'deny');
});

const mockGit = createMockGitWorkspaces();
const baseWorkspaces = createWorkspacesService(() => mockGit as never);
let checkpoints = 0;
const workspaces = {
  ...baseWorkspaces,
  async checkpointTurn(runId: string) {
    checkpoints++;
    return baseWorkspaces.checkpointTurn(runId);
  },
};
const gate = new RunToolApprovalGate(store, bus, sessions);
const approvalsSeen: string[] = [];
let autoApprove = true;
bus.subscribeAll((stored) => {
  if (stored.event.type !== 'approval.requested' || !autoApprove) return;
  const approval = stored.event.approval;
  approvalsSeen.push(approval.id);
  // A reviewer looks at it a moment later.
  setTimeout(() => {
    settleApproval(approval.id, {
      verdict: 'approved',
      action: { kind: 'tool:git.publish', description: approval.question },
    });
  }, 50);
});

const runtime = createClaudeCodeRuntime({
  harness: mockPeerHarness({ harness: 'claudecode', env: claudeCodeHarness().env }),
  workspaces: async () => workspaces,
  apiBaseUrl,
  gatewayUrl: 'http://127.0.0.1:1/never',
  tokens,
  approvals: async () => gate,
  emit: (runId, event) => bus.emit(runId, event),
  platform: hostPlatform(),
  requireGatewayCredentials: false,
  stderr: 'ignore',
  log: () => {},
});

const e2e = await seedRun('run_e2e');
const ctx = { runId: e2e.runId, stepId: e2e.stepId, sessionStateId: e2e.sessionStateId, policyRule: 'check' };
let taskId = '';
let wt = '';

async function turn(prompt: string, first = false): Promise<string> {
  if (first) {
    const started = await runtime.startTask({ goal: prompt }, ctx);
    assert.ok(started.ok, JSON.stringify(started));
    taskId = started.data.taskId;
  } else {
    const cont = await runtime.continueTask(taskId, { instruction: prompt }, ctx);
    assert.ok(cont.ok, JSON.stringify(cont));
  }
  await runtime.task(taskId)!.turn;
  const polled = await runtime.pollTask(taskId, ctx);
  assert.ok(polled.ok);
  assert.equal(polled.data.status, 'done', JSON.stringify(polled.data));
  return String((polled.data.result as { text?: string }).text ?? '');
}

await test('startTask: worktree, private CLAUDE_CONFIG_DIR with hook settings, token', async () => {
  const text = await turn('request:Write\n' + JSON.stringify({ file_path: 'src/hello.ts', content: 'export const hi = 1;\n' }), true);
  const task = runtime.task(taskId)!;
  wt = task.worktree;
  assert.equal(task.branch, 'zephyr/' + e2e.runId);
  assert.ok(!task.stateDir.startsWith(wt), 'settings live outside the worktree');
  const settings = JSON.parse(await readFile(join(task.stateDir, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].url, hookUrl(apiBaseUrl, task.token));
  assert.ok(tokens.resolve(task.token), 'token is live');
  assert.match(text, /allowed:Write/);
});
await test('a worktree edit is auto-allowed and written', async () => {
  assert.equal(await readFile(join(wt, 'src', 'hello.ts'), 'utf8'), 'export const hi = 1;\n');
  const lifecycle = (eventsOf(e2e.runId, 'tool.lifecycle') as Extract<RunEvent, { type: 'tool.lifecycle' }>[]).map(
    (e) => e.lifecycle.action.toolId + ':' + e.lifecycle.phase,
  );
  assert.ok(lifecycle.includes('fs.write:policy_decided'), lifecycle.join());
  assert.ok(lifecycle.includes('fs.write:succeeded'), 'PostToolUse reported: ' + lifecycle.join());
  assert.equal(approvalsSeen.length, 0, 'no approval for an auto row');
});
await test('an outside write is denied by the PreToolUse hook', async () => {
  const target = join(outside, 'hooked.txt');
  const text = await turn('request:Write\n' + JSON.stringify({ file_path: target, content: 'x' }));
  assert.match(text, /hook-denied:Write/);
  assert.equal(existsSync(target), false);
});
await test('an outside write is denied by the ACP path when the hook is skipped', async () => {
  const target = join(outside, 'acp.txt');
  const text = await turn('request:Write:nohook\n' + JSON.stringify({ file_path: target, content: 'x' }));
  assert.match(text, /denied:Write/);
  assert.equal(existsSync(target), false);
  const blocked = (eventsOf(e2e.runId, 'tool.lifecycle') as Extract<RunEvent, { type: 'tool.lifecycle' }>[]).filter(
    (e) => e.lifecycle.phase === 'blocked',
  );
  assert.ok(blocked.length >= 1, 'blocked lifecycle recorded');
});
await test('git push waits for approval, then proceeds on approve', async () => {
  const pushed = 'zephyr/' + e2e.runId;
  const startedAt = Date.now();
  const before = approvalsSeen.length;
  const text = await turn('request:Bash\n' + JSON.stringify({ command: 'git push origin ' + pushed }));
  assert.equal(approvalsSeen.length, before + 1, 'exactly one approval requested');
  assert.ok(Date.now() - startedAt >= 50, 'the turn waited for the reviewer');
  assert.match(text, /allowed:Bash/);
  // The approvals service records the verdict in the store; this check settles the
  // waiter directly, so only the gate's own effects are asserted here.
  const approval = await store.getApproval(approvalsSeen.at(-1)!);
  const payload = approval!.proposedAction as Record<string, any>;
  const diff = await baseWorkspaces.diff(e2e.runId);
  assert.deepEqual(payload.review, { operation: 'push', branch: pushed, diffHash: diff.hash });
  assert.equal(payload.toolId, 'git.publish');
  const run = await store.getRun(e2e.runId);
  assert.equal(run?.status, 'running', 'run resumed after approval');
});
await test('a rejected push is denied', async () => {
  autoApprove = false;
  const off = bus.subscribeAll((stored) => {
    if (stored.event.type !== 'approval.requested') return;
    const id = stored.event.approval.id;
    setTimeout(() => settleApproval(id, { verdict: 'rejected', action: { kind: 'tool:git.publish', description: 'no' } }), 20);
  });
  // A new diff hash: the previous approval does not cover it.
  await writeFile(join(wt, 'src', 'later.ts'), 'export const later = 2;\n');
  const text = await turn('request:Bash\n' + JSON.stringify({ command: 'git push origin zephyr/' + e2e.runId }));
  off();
  autoApprove = true;
  assert.match(text, /denied:Bash/);
});
await test('every turn started with a workspace checkpoint; turns ended are reported', async () => {
  assert.equal(checkpoints, 5, 'one checkpoint per turn');
  const ended = eventsOf(e2e.runId, 'harness.turn.ended') as Extract<RunEvent, { type: 'harness.turn.ended' }>[];
  assert.equal(ended.length, 5);
  assert.ok(ended.every((e) => e.harness === 'claudecode' && e.stopReason === 'end_turn'));
});
await test('cancelTask revokes the token and removes the private config dir', async () => {
  const task = runtime.task(taskId)!;
  const { token, stateDir } = task;
  await runtime.cancelTask(taskId, ctx);
  assert.equal(tokens.resolve(token), null);
  assert.equal(existsSync(stateDir), false);
  const res = await post(new URL(hookUrl(apiBaseUrl, token)).pathname, pre('Read', { file_path: 'a' }));
  assert.equal(res.status, 401);
});
await test('a checkpoint failure fails the turn before the harness runs', async () => {
  const failing = createClaudeCodeRuntime({
    harness: mockPeerHarness({ harness: 'claudecode', env: claudeCodeHarness().env }),
    workspaces: async () => ({
      ...baseWorkspaces,
      checkpointTurn: async () => {
        throw new Error('disk full');
      },
    }),
    apiBaseUrl,
    gatewayUrl: 'http://127.0.0.1:1/never',
    tokens,
    requireGatewayCredentials: false,
    stderr: 'ignore',
    log: () => {},
  });
  const run = await seedRun('run_ckpt');
  const started = await failing.startTask({ goal: 'write:x.txt=nope' }, { ...run, policyRule: 'check' });
  assert.ok(started.ok);
  await failing.task(started.data.taskId)!.turn;
  const polled = await failing.pollTask(started.data.taskId, { runId: run.runId, policyRule: 'check' });
  assert.ok(polled.ok);
  assert.equal(polled.data.status, 'failed');
  assert.ok(polled.data.log?.some((l: string) => /checkpoint failed: disk full/.test(l)));
  const task = failing.task(started.data.taskId)!;
  assert.equal(existsSync(join(task.worktree, 'x.txt')), false, 'the harness never ran');
  await failing.cancelTask(started.data.taskId, { runId: run.runId, policyRule: 'check' });
});
await test('Step 5 L2: the context pack precedes the goal; a failing pack costs only the pack', async () => {
  const calls: { task: string; worktree: string; runId: string }[] = [];
  const packed = createClaudeCodeRuntime({
    harness: mockPeerHarness({ harness: 'claudecode', env: claudeCodeHarness().env }),
    workspaces: async () => workspaces,
    apiBaseUrl,
    gatewayUrl: 'http://127.0.0.1:1/never',
    tokens,
    requireGatewayCredentials: false,
    stderr: 'ignore',
    log: () => {},
    contextPack: async (input, c) => {
      calls.push({ ...input, runId: c.runId });
      if (input.task.includes('boom')) throw new Error('index exploded');
      // The mock peer runs the first prompt line: the pack must come first.
      return { files: [], prompt: 'write:packed.txt=from-pack', source: 'jev', tokens: 6, cached: false, reasonCodes: [] };
    },
  });
  const run = await seedRun('run_pack');
  const started = await packed.startTask({ goal: 'write:goal.txt=from-goal' }, { ...run, policyRule: 'check' });
  assert.ok(started.ok, JSON.stringify(started));
  const task = packed.task(started.data.taskId)!;
  await task.turn;
  assert.equal(await readFile(join(task.worktree, 'packed.txt'), 'utf8'), 'from-pack');
  assert.deepEqual(calls, [{ task: 'write:goal.txt=from-goal', worktree: task.worktree, runId: run.runId }]);
  const polled = await packed.pollTask(started.data.taskId, { runId: run.runId, policyRule: 'check' });
  assert.ok(polled.ok && polled.data.log?.some((l: string) => /context pack: 0 file\(s\), ~6 tokens, source=jev/.test(l)));
  await packed.cancelTask(started.data.taskId, { runId: run.runId, policyRule: 'check' });

  const run2 = await seedRun('run_pack_fail');
  const second = await packed.startTask({ goal: 'write:plain.txt=boom' }, { ...run2, policyRule: 'check' });
  assert.ok(second.ok, 'a pack failure never fails the task');
  const task2 = packed.task(second.data.taskId)!;
  await task2.turn;
  assert.equal(await readFile(join(task2.worktree, 'plain.txt'), 'utf8'), 'boom');
  await packed.cancelTask(second.data.taskId, { runId: run2.runId, policyRule: 'check' });

  const run3 = await seedRun('run_pack_off');
  const off = await packed.startTask(
    { goal: 'write:off.txt=lever-off', levers: { contextPack: false } },
    { ...run3, policyRule: 'check' },
  );
  assert.ok(off.ok);
  await packed.task(off.data.taskId)!.turn;
  assert.equal(calls.length, 2, 'levers.contextPack=false skips the builder');
  assert.equal(await readFile(join(packed.task(off.data.taskId)!.worktree, 'off.txt'), 'utf8'), 'lever-off');
  await packed.cancelTask(off.data.taskId, { runId: run3.runId, policyRule: 'check' });
});
await test('Step 5 L3: one tool set per session, sent as ACP _meta and written as settings deny rules', async () => {
  const runtime = createClaudeCodeRuntime({
    harness: mockPeerHarness({ harness: 'claudecode', env: claudeCodeHarness().env }),
    workspaces: async () => workspaces,
    apiBaseUrl,
    gatewayUrl: 'http://127.0.0.1:1/never',
    tokens,
    requireGatewayCredentials: false,
    stderr: 'ignore',
    log: () => {},
  });
  const open = async (goal: string, levers?: { schemaMin: boolean }) => {
    const run = await seedRun('run_l3_' + Math.random().toString(36).slice(2, 8));
    const started = await runtime.startTask({ goal, ...(levers ? { levers } : {}) }, { ...run, policyRule: 'check' });
    assert.ok(started.ok, JSON.stringify(started));
    const task = runtime.task(started.data.taskId)!;
    await task.turn;
    const meta = JSON.parse(await readFile(join(task.worktree, 'session-meta.json'), 'utf8'));
    const settings = JSON.parse(await readFile(join(task.stateDir!, 'settings.json'), 'utf8'));
    const polled = await runtime.pollTask(started.data.taskId, { runId: run.runId, policyRule: 'check' });
    await runtime.cancelTask(started.data.taskId, { runId: run.runId, policyRule: 'check' });
    return { meta, settings, log: polled.ok ? (polled.data.log ?? []) : [] };
  };

  const edit = await open('session-meta\nRefactor the billing module');
  const off = ['ExitPlanMode', 'NotebookEdit', 'Task', 'WebFetch', 'WebSearch'];
  assert.deepEqual(edit.meta, {
    claudeCode: { options: { disallowedTools: off, extraArgs: { 'strict-mcp-config': null } } },
  });
  assert.deepEqual(edit.settings.permissions.deny, off, 'the settings deny the same list');
  assert.ok(edit.log.some((l: string) => /^tool set: edit task, 5 native tool\(s\) off .*strict MCP, fingerprint [0-9a-f]{12}$/.test(l)));

  const read = await open('session-meta\nExplain where the session cache is checked');
  const readOff = read.meta.claudeCode.options.disallowedTools as string[];
  for (const t of ['Edit', 'MultiEdit', 'Write']) assert.ok(readOff.includes(t), t);
  assert.deepEqual(read.settings.permissions.deny, readOff);

  const lever = await open('session-meta\nRefactor the billing module', { schemaMin: false });
  assert.equal(lever.meta, null, 'levers.schemaMin=false sends no _meta');
  assert.equal(lever.settings.permissions.deny, undefined);
  assert.ok(!lever.log.some((l: string) => l.startsWith('tool set:')));
});
await test('startTask requires a gateway credential by default', async () => {
  const strict = createClaudeCodeRuntime({
    harness: mockPeerHarness({ harness: 'claudecode' }),
    workspaces: async () => workspaces,
    apiBaseUrl,
    gatewayUrl: 'http://127.0.0.1:1',
    tokens,
  });
  const started = await strict.startTask({ goal: 'complete' }, { runId: 'run_nocred', policyRule: 'check' });
  assert.equal(started.ok, false);
  if (!started.ok) assert.equal(started.error.code, 'AUTH');
});

server.close();
await sleep(50);
await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
console.log(`\ncheck:claudecode — ${passed} passed`);
process.exit(0);
