import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { BrowserAdapter, BrowserViewer, ProviderResult, ProposedAction } from '@htn/shared';
import type { chromium } from 'playwright-core';

// No .env is loaded by this harness, no hosted provider is contacted, and mock
// timing/failure is deterministic. --local additionally launches installed Chrome
// against the loopback synthetic page; it is a manual machine-dependent check.
process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';
const { createBrowserRouter } = await import('../src/api/browser.routes.js');
const { approvalsRouter } = await import('../src/api/approvals.routes.js');
const { errorHandler } = await import('../src/api/middleware/error.js');
const { establishLocalControl } = await import('../src/services/localControl.js');
const { credentials, CredentialStore } = await import('../src/services/credentials.js');
const { store, bus } = await import('../src/services/runtime.js');
const { resumeRun } = await import('../src/services/runs.service.js');
const pauseGate = await import('../src/core/pauseGate.js');
const { waitForApproval } = await import('../src/core/approvalGate.js');
const { createMockBrowser } = await import('../src/providers/mockBrowser.js');
const { createLiveLocalBrowser } = await import('../src/providers/localbrowser/live.js');
const { createLiveBrowserless } = await import('../src/providers/browserless/live.js');
const { withBrowserOwnership } = await import('../src/providers/withBrowserOwnership.js');
const { browserLocation } = await import('../src/providers/browserSafety.js');

function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const adapters = new Map<string, BrowserAdapter>();
let pauses = 0;
const app = express();
app.use(express.json());
app.post('/api/control', (req, res) => {
  establishLocalControl(req, res);
  res.json({ ok: true });
});
app.get('/synthetic', (_req, res) =>
  res.type('html').send(`<!doctype html><title>AgentOS HTTP rehearsal</title>
  <style>input,button{display:block;margin:20px;width:220px;height:30px}</style>
  <h1>Harmless local rehearsal</h1><input aria-label="Name"><input aria-label="Password" type="password" value="password-fixture">
  <input aria-label="One-time code" autocomplete="one-time-code" value="otp-fixture"><input aria-label="Hidden" hidden value="hidden-fixture">
  <button onclick="document.querySelector('h1').textContent='Preview only'">Preview only</button>`),
);
app.use(
  '/api',
  createBrowserRouter({
    byId(id) {
      const adapter = adapters.get(id);
      assert.ok(adapter);
      return adapter;
    },
    async pauseRun(id) {
      pauses++;
      pauseGate.pauseRun(id);
      return store.patchRun(id, { control: 'pausing' });
    },
  }),
);
app.use('/api', approvalsRouter);
app.use(errorHandler);
const server = createServer(app);
const origin = await listen(server);
const setup = await fetch(origin + '/api/control', { method: 'POST', headers: { origin } });
assert.equal(setup.status, 200);
const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
assert.match(setup.headers.get('set-cookie')!, /HttpOnly/);
assert.match(setup.headers.get('set-cookie')!, /SameSite=Strict/i);
async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, cookie, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(path: string, body?: unknown, expectedStatus = 200): Promise<any> {
  const response = await request(path, body);
  const result = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(result));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}
async function run(id: string) {
  credentials.bindRun(id);
  const at = new Date().toISOString();
  await store.createRun({
    id,
    kind: 'browser_test',
    title: 'Synthetic browser HTTP test',
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
  });
  return { runId: id, policyRule: 'synthetic-browser-http-check' };
}
async function handoff(runId: string, sessionId: string, suffix: string, expectUrl?: string) {
  const id = runId + '_approval_' + suffix;
  const proposedAction = {
    kind: 'human_handoff',
    sessionId,
    resumeWhen: expectUrl ? 'url_matches' : 'user_confirms',
    ...(expectUrl ? { expectUrl } : {}),
  };
  const action: ProposedAction = {
    kind: 'human_handoff',
    description: 'Confirm synthetic page',
    reversibility: 'irreversible',
    payload: proposedAction,
  };
  await store.createApproval({
    id,
    runId,
    stepId: 'synthetic-step',
    question: 'Synthetic handoff Done',
    proposedAction,
    reversibility: 'irreversible',
    riskClass: 'ask_human',
    policyRule: 'explicit-human-handoff',
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  return { id, waiting: waitForApproval(id, action) };
}

// Actual live adapter, deterministic injected CDP server protocol. No real cloud
// connection, iframe client, provider account, or anti-bot success is claimed.
function browserlessFixture() {
  let location = origin + '/synthetic?login_code=private#fragment';
  let typed = '';
  let closed = false;
  let grantId = 0;
  let failRevoke = false;
  const activeGrants = new Set<string>();
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  const locator = {
    nth: () => locator,
    first: () => locator,
    innerText: async () => typed || 'Synthetic page',
    fill: async (text: string) => {
      typed = text;
    },
  };
  const cdp = {
    async send(method: string, params: Record<string, unknown>) {
      commands.push({ method, params });
      if (method === 'Browserless.liveURL') {
        const id = 'grant-' + ++grantId;
        activeGrants.add(id);
        return {
          error: null,
          liveURLId: id,
          liveURL: 'https://production-sfo.browserless.io/live/' + id,
          timeout: 60000,
        };
      }
      if (method === 'Browserless.closeLiveURL') {
        if (failRevoke) return { error: 'fixture failed revocation', liveURLId: params.liveURLId };
        activeGrants.delete(String(params.liveURLId));
        return { error: null, liveURLId: params.liveURLId };
      }
      throw new Error('Unexpected protocol command');
    },
  };
  const context = { pages: () => [page], newCDPSession: async () => cdp, on: () => undefined };
  const page = {
    context: () => context,
    setDefaultTimeout: () => undefined,
    setViewportSize: async () => undefined,
    goto: async (url: string) => {
      location = url;
    },
    url: () => location,
    title: async () => 'Synthetic browser',
    locator: () => locator,
    evaluate: async (expression: string) =>
      expression.includes('out.push')
        ? [
            {
              domIndex: 0,
              tag: 'input',
              role: 'textbox',
              type: 'text',
              name: 'Name',
              value: typed,
              visible: true,
            },
          ]
        : { exists: true, visible: true, enabled: true, occluded: false },
    waitForTimeout: async () => undefined,
    screenshot: async () => new Uint8Array([255, 216, 255, 217]),
    mouse: { click: async () => undefined, wheel: async () => undefined },
    keyboard: {
      press: async () => undefined,
      insertText: async (text: string) => {
        typed += text;
      },
    },
  };
  const handlers = new Map<string, () => void>();
  const browser = {
    contexts: () => [context],
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    close: async () => {
      closed = true;
      activeGrants.clear();
      handlers.get('disconnected')?.();
    },
  };
  const vault = new CredentialStore({ source: 'user' });
  vault.put('local-user', 'browserless', 'synthetic-token');
  const connector = (async () => browser) as unknown as typeof chromium.connectOverCDP;
  return {
    adapter: withBrowserOwnership(
      createLiveBrowserless(
        { mode: 'live', keyVar: 'TEST', baseUrl: 'https://production-sfo.browserless.io' },
        connector,
        vault,
      ),
    ),
    commands,
    activeGrants,
    get typed() {
      return typed;
    },
    get closed() {
      return closed;
    },
    set failRevoke(fail: boolean) {
      failRevoke = fail;
    },
    manualNavigate(url: string) {
      location = url;
    },
    vault,
  };
}

try {
  for (const providerId of ['browserbase', 'browserless', 'localbrowser'] as const) {
    const ctx = await run('mock_http_' + providerId);
    const adapter = withBrowserOwnership(
      createMockBrowser(providerId, { mode: 'mock', keyVar: 'TEST' }),
    );
    adapters.set(providerId, adapter);
    const sessionId = value(
      await adapter.openSession(
        { startUrl: 'https://example.com/path?login_code=secret#fragment' },
        ctx,
      ),
    ).sessionId;
    const path = '/runs/' + ctx.runId + '/browser/' + sessionId;
    const watch: BrowserViewer = await json(path + '/live-view');
    assert.equal(watch.providerId, providerId);
    assert.equal(watch.mode, 'mock');
    assert.equal(watch.simulated, true);
    assert.equal(watch.kind, 'none');
    assert.equal(watch.canControl, false);
    assert.equal(watch.liveViewUrl, undefined);
    assert.equal(watch.pageUrl, 'https://example.com/path');
    await json(path + '/take-control', { revision: 0, idempotencyKey: 'mock-takeover' }, 409);
    assert.equal(pauses, 0);
    assert.equal((await request(path + '/live-view', undefined, { cookie: '' })).status, 401);
    assert.equal(
      (await request(path + '/live-view', undefined, { origin: 'https://foreign.test' })).status,
      403,
    );
    const other = await run('foreign_' + providerId);
    await json('/runs/' + other.runId + '/browser/' + sessionId + '/live-view', undefined, 404);
    await adapter.setOwnership!({ sessionId, owner: 'human' }, ctx);
    const pending = await handoff(ctx.runId, sessionId, 'mock');
    await json('/approvals/' + pending.id + '/decide', { decision: 'approved' });
    assert.equal((await pending.waiting).verdict, 'approved');
    const frozen: BrowserViewer = await json(path + '/live-view');
    assert.equal(frozen.phase, 'verifying');
    assert.equal(frozen.kind, 'none');
    assert.equal(frozen.canControl, false);
    assert.equal(frozen.simulated, true);
    await json(path + '/viewer', { mode: 'control' }, 409);
    await adapter.setOwnership!({ sessionId, owner: 'agent' }, ctx);
    await adapter.releaseRun!(ctx.runId, { ...ctx, policyRule: 'test-release' });
    await json(path + '/live-view', undefined, 404);
  }

  const fixture = browserlessFixture();
  const adapter = fixture.adapter;
  adapters.set('browserless', adapter);
  const ctx = await run('live_protocol_http');
  const sessionId = value(
    await adapter.openSession({ startUrl: origin + '/synthetic?login_code=private#fragment' }, ctx),
  ).sessionId;
  const path = '/runs/' + ctx.runId + '/browser/' + sessionId;
  const watch: BrowserViewer = await json(path + '/live-view');
  assert.equal(watch.interactive, false);
  assert.equal(watch.kind, 'iframe');
  assert.equal(fixture.commands.at(-1)?.params.interactable, false);
  assert.equal(watch.pageUrl, origin + '/synthetic');
  await json(path + '/input', { revision: 0, input: { type: 'text', text: 'blocked' } }, 409);
  await json(path + '/take-control', { revision: 0, idempotencyKey: 'protocol-takeover' });
  assert.equal(pauses, 1);
  assert.equal(pauseGate.isPaused(ctx.runId), true);
  const human: BrowserViewer = await json(path + '/live-view');
  assert.equal(human.phase, 'human_control');
  assert.equal(human.interactive, true);
  assert.equal(fixture.commands.at(-1)?.params.interactable, true);
  const replay: BrowserViewer = await json(path + '/take-control', {
    revision: 0,
    idempotencyKey: 'protocol-takeover',
  });
  assert.equal(replay.revision, human.revision);
  assert.equal(pauses, 1);
  await json(
    path + '/take-control',
    { revision: 0, idempotencyKey: 'protocol-takeover-conflict' },
    409,
  );
  await json(
    path + '/release-control',
    { revision: human.revision, idempotencyKey: 'protocol-takeover' },
    409,
  );
  await json(path + '/input', { revision: 0, input: { type: 'text', text: 'stale' } }, 409);
  await json(path + '/input', {
    revision: human.revision,
    input: { type: 'text', text: 'manual' },
  });
  assert.equal(fixture.typed, 'manual');
  await assert.rejects(resumeRun(ctx.runId), /Return browser control/);
  const pending = await handoff(ctx.runId, sessionId, 'verification', origin + '/expected-page');
  await json(
    path + '/release-control',
    { revision: human.revision, idempotencyKey: 'pending-release' },
    409,
  );
  const eventStates: string[] = [];
  const unsubscribe = bus.subscribe(ctx.runId, (event) => {
    if (event.event.type === 'approval.resolved')
      eventStates.push(String(fixture.activeGrants.size));
  });
  fixture.failRevoke = true;
  await json('/approvals/' + pending.id + '/decide', { decision: 'approved' }, 409);
  assert.equal((await store.getApproval(pending.id))?.status, 'pending');
  assert.equal(eventStates.length, 0);
  let frozen: BrowserViewer = await json(path + '/live-view');
  assert.equal(frozen.phase, 'verifying');
  assert.equal(frozen.kind, 'none');
  assert.equal(frozen.canControl, true);
  assert.equal(frozen.liveViewUrl, undefined);
  await json(
    path + '/input',
    { revision: frozen.revision, input: { type: 'text', text: 'frozen' } },
    409,
  );
  await json(path + '/viewer', { mode: 'control' }, 409);
  fixture.failRevoke = false;
  // Revocation succeeds, optional URL verification fails, approval stays pending.
  await json('/approvals/' + pending.id + '/decide', { decision: 'approved' }, 409);
  assert.equal(fixture.activeGrants.size, 0);
  assert.equal((await store.getApproval(pending.id))?.status, 'pending');
  frozen = await json(path + '/live-view');
  const recovered: BrowserViewer = await json(path + '/take-control', {
    revision: frozen.revision,
    idempotencyKey: 'manual-recovery',
  });
  assert.equal(recovered.phase, 'human_control');
  await json(
    '/approvals/' + pending.id + '/decide',
    { decision: 'revised', revisedPayload: {} },
    422,
  );
  // Fixture simulates manual navigation, keeping the originally approved target
  // frozen. This does not contact a cloud service or public website.
  fixture.manualNavigate(origin + '/expected-page');
  const completed = await json('/approvals/' + pending.id + '/decide', { decision: 'approved' });
  assert.equal(completed.approval.status, 'approved');
  assert.equal(fixture.activeGrants.size, 0);
  assert.deepEqual(eventStates, ['0']);
  unsubscribe();
  assert.equal((await pending.waiting).verdict, 'approved');
  frozen = await json(path + '/live-view');
  assert.equal(frozen.phase, 'verifying');
  assert.equal(frozen.liveViewUrl, undefined);
  await json(
    path + '/take-control',
    { revision: frozen.revision, idempotencyKey: 'approval-reserved' },
    409,
  );
  await adapter.setOwnership!({ sessionId, owner: 'agent' }, ctx);
  await resumeRun(ctx.runId);
  assert.equal(pauseGate.isPaused(ctx.runId), false);
  assert.equal(value(await adapter.snapshot!({ sessionId }, ctx)).rows[0]?.value, 'manual');
  // Credential invalidation closes the browser immediately and old session fails.
  fixture.vault.remove('local-user', 'browserless');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.closed, true);
  assert.equal(fixture.activeGrants.size, 0);
  await json(path + '/live-view', undefined, 404);
  await adapter.releaseRun!(ctx.runId, { ...ctx, policyRule: 'test-release' });

  if (process.argv.includes('--local')) {
    const ctx = await run('real_local_http_' + Date.now());
    const adapter = withBrowserOwnership(
      createLiveLocalBrowser({
        mode: 'live',
        keyVar: 'CHANNEL',
        channel: process.env.LOCALBROWSER_CHANNEL || 'chrome',
        headless: false,
      }),
    );
    adapters.set('localbrowser', adapter);
    try {
      const sessionId = value(
        await adapter.openSession(
          { startUrl: origin + '/synthetic?login_code=secret#fragment' },
          ctx,
        ),
      ).sessionId;
      const path = '/runs/' + ctx.runId + '/browser/' + sessionId;
      const watch: BrowserViewer = await json(path + '/live-view');
      assert.equal(watch.kind, 'stream');
      assert.equal(watch.interactive, false);
      assert.equal(watch.pageUrl, origin + '/synthetic');
      const frame = await request(path + '/frame');
      assert.equal(frame.status, 200);
      assert.equal(frame.headers.get('content-type'), 'image/jpeg');
      assert.equal(frame.headers.get('cache-control'), 'no-store');
      assert.ok((await frame.arrayBuffer()).byteLength > 1000);
      const table = value(await adapter.snapshot!({ sessionId }, ctx));
      assert.equal(
        table.rows.some((row) => row.label === 'Hidden'),
        false,
      );
      assert.equal(JSON.stringify(table).includes('password-fixture'), false);
      assert.equal(JSON.stringify(table).includes('otp-fixture'), false);
      assert.equal(JSON.stringify(table).includes('login_code'), false);
      const field = table.rows.find((row) => row.label === 'Name')!;
      value(
        await adapter.perform!(
          {
            sessionId,
            snapshotId: table.snapshotId,
            operation: 'TYPE_TEXT',
            index: field.index,
            text: 'agent',
          },
          ctx,
        ),
      );
      const human: BrowserViewer = await json(path + '/take-control', {
        revision: 0,
        idempotencyKey: 'local-takeover',
      });
      assert.equal(human.interactive, true);
      assert.equal(pauseGate.isPaused(ctx.runId), true);
      await json(path + '/input', { revision: human.revision, input: { type: 'key', key: 'End' } });
      await json(path + '/input', {
        revision: human.revision,
        input: { type: 'text', text: ' manual' },
      });
      const pending = await handoff(ctx.runId, sessionId, 'local', origin + '/synthetic');
      await json('/approvals/' + pending.id + '/decide', { decision: 'approved' });
      const frozen: BrowserViewer = await json(path + '/live-view');
      assert.equal(frozen.phase, 'verifying');
      assert.equal(frozen.kind, 'none');
      await json(
        path + '/input',
        { revision: human.revision, input: { type: 'text', text: 'blocked' } },
        409,
      );
      assert.equal((await pending.waiting).verdict, 'approved');
      await adapter.setOwnership!({ sessionId, owner: 'agent' }, ctx);
      await resumeRun(ctx.runId);
      assert.equal(
        value(await adapter.snapshot!({ sessionId }, ctx)).rows.find((row) => row.label === 'Name')
          ?.value,
        'agent manual',
      );
      const again: BrowserViewer = await json(path + '/live-view');
      const second: BrowserViewer = await json(path + '/take-control', {
        revision: again.revision,
        idempotencyKey: 'local-second-takeover',
      });
      const returned: BrowserViewer = await json(path + '/release-control', {
        revision: second.revision,
        idempotencyKey: 'local-explicit-release',
      });
      assert.equal(returned.owner, 'agent');
      assert.equal(pauseGate.isPaused(ctx.runId), false);
      await json(
        path + '/input',
        { revision: second.revision, input: { type: 'text', text: 'stale-after-release' } },
        409,
      );
    } finally {
      await adapter.releaseRun!(ctx.runId, { ...ctx, policyRule: 'test-release' });
      pauseGate.resumeRun(ctx.runId);
    }
    console.log(
      'Real headed installed Chrome: authenticated HTTP JPEG/input bridge, private-field redaction, pause, Done freeze/approval, same-session readback, release and stale-input rejection passed on a loopback synthetic page.',
    );
  }
  assert.equal(
    browserLocation('https://user:password@example.com/path?code=secret#token'),
    'https://example.com/path',
  );
  console.log(
    'Browser HTTP mock lifecycle (all backends) and injected live Browserless CDP protocol passed. Hosted browser connectivity and public anti-bot sites were not tested.',
  );
} finally {
  await close(server);
}
