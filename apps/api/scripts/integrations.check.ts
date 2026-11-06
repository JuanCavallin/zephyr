import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { credentialsRouter } from '../src/api/credentials.routes.js';
import { HttpError } from '../src/api/middleware/validate.js';
import { randomBytes } from 'node:crypto';
import { importCredentials, parseEnvCredentials } from '../src/services/credentialImport.js';
import { CredentialStore, vaultCredentialPersistence } from '../src/services/credentials.js';
import { SecretVault } from '../src/services/vault.js';
import { createMemoryStore } from '../src/store/memory.js';
import { verifyCredential } from '../src/services/credentialVerify.js';
import { buildIntegrations } from '../src/services/integrations.service.js';
import { integrationsRouter } from '../src/api/integrations.routes.js';
import type { IntegrationsResponse, McpConnection } from '@htn/shared';

// ---- .env parsing: CRLF, export prefixes, quotes, comments, aliases, metadata.
{
  const parsed = parseEnvCredentials(
    'export ANTHROPIC_API_KEY="sk-a"\r\n' +
      '# a comment\n' +
      'JEV_API_KEY=j1\n' +
      "AI_GATEWAY_API_KEY='g1'\n" +
      'BROWSERBASE_API_KEY=bb\n' +
      'BROWSERBASE_PROJECT_ID=proj\n' +
      'GEMINI_API_KEY=\n' +
      'OTHER=x\n',
  );
  const by = Object.fromEntries(parsed.matches.map((m) => [m.providerId, m]));
  assert.equal(by.anthropic?.secret, 'sk-a', 'quotes and CRLF stripped');
  assert.equal(by.anthropic?.envVar, 'ANTHROPIC_API_KEY');
  assert.equal(by.jev?.secret, 'g1', 'AI_GATEWAY_API_KEY wins over the JEV_API_KEY alias');
  assert.equal(by.jev?.envVar, 'AI_GATEWAY_API_KEY');
  assert.deepEqual(by.browserbase?.metadata, { projectId: 'proj' });
  assert.equal(by.gemini, undefined, 'blank values are skipped');
  assert.equal(parsed.ignored, 1, 'only unrecognised assignments count as ignored');
  assert.deepEqual(parseEnvCredentials(''), { matches: [], ignored: 0 });

  // Quoted values followed by a comment: quotes and comment both go.
  const commented = parseEnvCredentials(
    'ANTHROPIC_API_KEY="sk-ant-abc123" # main key\n' +
      "GEMINI_API_KEY='gem-xyz'   # other\n" +
      'TAVILY_API_KEY=tv-plain # note\n' +
      'BROWSERBASE_API_KEY=bb\nBROWSERBASE_PROJECT_ID="proj-1" # mine\n',
  );
  const c = Object.fromEntries(commented.matches.map((m) => [m.providerId, m]));
  assert.equal(c.anthropic?.secret, 'sk-ant-abc123');
  assert.equal(c.gemini?.secret, 'gem-xyz');
  assert.equal(c.tavily?.secret, 'tv-plain');
  assert.deepEqual(c.browserbase?.metadata, { projectId: 'proj-1' });
  // A project ID PUT would reject is dropped, not stored.
  const badProject = parseEnvCredentials('BROWSERBASE_API_KEY=bb\nBROWSERBASE_PROJECT_ID=a b/c\n');
  assert.equal(badProject.matches[0]?.metadata, undefined);
}

// ---- importCredentials: all or nothing, and rollback restores exactly what was there.
{
  const mem = createMemoryStore();
  const key = randomBytes(32);
  const vaultPersistence = vaultCredentialPersistence(new SecretVault(mem, key));
  const failOn = new Set<string>();
  const flaky = {
    ...vaultPersistence,
    async save(...args: Parameters<typeof vaultPersistence.save>) {
      if (failOn.has(args[1])) throw new Error('disk full');
      return vaultPersistence.save(...args);
    },
  };

  // Operator billing: a user key saved earlier must survive a failed import untouched.
  const operator = new CredentialStore({
    source: 'operator',
    persistence: flaky,
    operator: { anthropic: { secret: 'operator-anthropic' } },
  });
  await operator.save('local-user', 'anthropic', 'user-anthropic-1');
  failOn.add('gemini');
  await assert.rejects(
    importCredentials(operator, 'local-user', [
      { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY', secret: 'user-anthropic-2' },
      { providerId: 'gemini', envVar: 'GEMINI_API_KEY', secret: 'g' },
    ]),
    /disk full/,
  );
  assert.equal(operator.userEntry('local-user', 'anthropic')?.secret, 'user-anthropic-1');
  const reloaded = new CredentialStore({ source: 'user', persistence: vaultPersistence });
  await reloaded.hydrate();
  assert.equal(reloaded.userEntry('local-user', 'anthropic')?.secret, 'user-anthropic-1');
  assert.equal(reloaded.userEntry('local-user', 'gemini'), undefined);

  // A replaced key comes back with its metadata.
  const user = new CredentialStore({ source: 'user', browserSource: 'user', persistence: flaky });
  await user.save('local-user', 'browserbase', 'bb-old', { projectId: 'proj-old' });
  await assert.rejects(
    importCredentials(user, 'local-user', [
      { providerId: 'browserbase', envVar: 'BROWSERBASE_API_KEY', secret: 'bb-new' },
      { providerId: 'gemini', envVar: 'GEMINI_API_KEY', secret: 'g' },
    ]),
    /disk full/,
  );
  assert.deepEqual(user.userEntry('local-user', 'browserbase'), {
    secret: 'bb-old',
    metadata: { projectId: 'proj-old' },
  });

  // Success stores every selected key.
  failOn.clear();
  await importCredentials(user, 'local-user', [
    { providerId: 'gemini', envVar: 'GEMINI_API_KEY', secret: 'g-ok' },
  ]);
  assert.equal(user.userEntry('local-user', 'gemini')?.secret, 'g-ok');
  console.log('Integrations: import rollback checks passed.');
}

// ---- verify: real outcomes, never the secret in the detail.
{
  const ok = async () => new Response('{}', { status: 200 });
  const rejected = async () => new Response('{"error":"bad key sk-secret"}', { status: 401 });
  const down = async () => new Response('', { status: 503 });
  const unreachable = async () => {
    throw new TypeError('fetch failed');
  };
  let seen: Headers | undefined;
  const capture: typeof fetch = async (_url, init) => {
    seen = new Headers(init?.headers);
    return new Response('{}', { status: 200 });
  };
  assert.deepEqual(await verifyCredential('anthropic', 'sk-secret', { fetch: ok }), {
    ok: true,
    detail: 'Key accepted.',
  });
  const bad = await verifyCredential('anthropic', 'sk-secret', { fetch: rejected });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /rejected/);
  assert.ok(!bad.detail.includes('sk-secret'));
  assert.match((await verifyCredential('gemini', 'k', { fetch: down })).detail, /503/);
  const offline = await verifyCredential('browserbase', 'k', { fetch: unreachable });
  assert.equal(offline.ok, false);
  assert.match(offline.detail, /Could not reach api\.browserbase\.com/);
  await verifyCredential('gemini', 'g-key', { fetch: capture });
  assert.equal(seen?.get('x-goog-api-key'), 'g-key');
  await verifyCredential('anthropic', 'a-key', { fetch: capture });
  assert.equal(seen?.get('x-api-key'), 'a-key');
  assert.equal((await verifyCredential('tavily', 'k', { fetch: ok })).ok, null);
}

// ---- routes: preview never echoes secrets; commit stores only what was selected.
const app = express();
app.use(express.json({ limit: '128kb' }));
app.use('/api', credentialsRouter);
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res
      .status(error instanceof HttpError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : 'error' });
  },
);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = 'http://127.0.0.1:' + address.port + '/api/credentials';
const realFetch = globalThis.fetch;
try {
  const session = await fetch(base + '/session', {
    method: 'POST',
    headers: { Origin: config.webOrigin },
  });
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { Cookie: cookie, Origin: config.webOrigin, 'Content-Type': 'application/json' };
  const text = 'ANTHROPIC_API_KEY=sk-import-9876\nTAVILY_API_KEY=tv-import-5555\nNOPE=1\n';

  const preview = await fetch(base + '/import/env', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  });
  assert.equal(preview.status, 200);
  const previewText = await preview.text();
  assert.ok(!previewText.includes('sk-import') && !previewText.includes('tv-import'));
  const previewBody = JSON.parse(previewText) as {
    matches: Array<{ providerId: string; last4: string; replaces: boolean }>;
    ignored: number;
  };
  assert.deepEqual(
    previewBody.matches.map((m) => [m.providerId, m.last4, m.replaces]),
    [
      ['anthropic', '9876', false],
      ['tavily', '5555', false],
    ],
  );
  assert.equal(previewBody.ignored, 1);

  const commit = await fetch(base + '/import/env/commit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, providerIds: ['anthropic'] }),
  });
  assert.equal(commit.status, 200);
  const committed = (await commit.json()) as { providers: Array<{ providerId: string }> };
  assert.deepEqual(
    committed.providers.map((p) => p.providerId),
    ['anthropic'],
  );
  const listing = (await (await fetch(base, { headers })).json()) as {
    providers: Array<{ providerId: string; configured: boolean; last4?: string }>;
  };
  const anthropic = listing.providers.find((p) => p.providerId === 'anthropic')!;
  assert.equal(anthropic.configured, true);
  assert.equal(anthropic.last4, '9876');
  assert.equal(listing.providers.find((p) => p.providerId === 'tavily')!.configured, false);

  const unknown = await fetch(base + '/import/env/commit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, providerIds: ['gemini'] }),
  });
  assert.equal(unknown.status, 400, 'committing a provider absent from the file is rejected');

  // Verify uses the stored key and reports the provider's answer.
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(config.providers.anthropic.baseUrl!)) {
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'sk-import-9876');
      return new Response('{}', { status: 401 });
    }
    return realFetch(url, init);
  };
  const verified = await fetch(base + '/anthropic/verify', { method: 'POST', headers });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { ok: false, detail: 'Key rejected (401).' });
  const missing = await fetch(base + '/gemini/verify', { method: 'POST', headers });
  assert.equal(missing.status, 400);
} finally {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('Integrations: .env import, verify and import routes checks passed.');

// ---- buildIntegrations: one truthful status per item, summary counts.
{
  const at = '2026-11-05T00:00:00.000Z';
  const mcp = (status: McpConnection['status'], tools: number, lastError?: string) =>
    ({
      id: 'm-' + status,
      name: 'MCP ' + status,
      url: 'https://mcp.example/' + status,
      transport: 'streamable_http',
      enabled: status !== 'disabled',
      headerEnv: {},
      status,
      toolIds: Array.from({ length: tools }, (_, i) => 't' + i),
      executableToolIds: [],
      ...(lastError ? { lastError } : {}),
      createdAt: at,
      updatedAt: at,
    }) satisfies McpConnection;
  const result = buildIntegrations({
    credentials: [
      {
        providerId: 'anthropic',
        purpose: 'model',
        source: 'user',
        configured: true,
        version: 2,
        last4: 'abcd',
        updatedAt: at,
      },
      { providerId: 'gemini', purpose: 'model', source: 'user', configured: false },
      {
        providerId: 'tavily',
        purpose: 'search',
        source: 'user',
        configured: false,
        error: 'Vault key changed; re-enter this key.',
      },
      {
        providerId: 'browserbase',
        purpose: 'browser',
        source: 'operator',
        configured: true,
        last4: '9999',
      },
    ],
    mcp: [mcp('connected', 3), mcp('error', 0, 'HTTP 500'), mcp('disabled', 1)],
    providers: [
      { id: 'hermes', mode: 'live', capabilities: [], healthy: true, detail: 'Configured' },
      {
        id: 'claudecode',
        mode: 'live',
        capabilities: [],
        healthy: false,
        detail: 'binary missing',
      },
      { id: 'composio', mode: 'mock', capabilities: [], healthy: true },
      { id: 'gemini', mode: 'live', capabilities: [], healthy: true },
    ],
  });
  const item = (kind: string, id: string) =>
    result.items.find((i) => i.kind === kind && i.id === id)!;
  assert.deepEqual(
    { s: item('key', 'anthropic').status, d: item('key', 'anthropic').detail },
    { s: 'connected', d: '…abcd · your key' },
  );
  assert.equal(item('key', 'anthropic').updatedAt, at);
  assert.equal(item('key', 'browserbase').detail, '…9999 · operator key');
  assert.equal(item('key', 'gemini').status, 'available');
  assert.equal(item('key', 'tavily').status, 'error');
  assert.match(item('key', 'tavily').reason ?? '', /Vault key changed/);
  assert.equal(item('mcp', 'm-connected').detail, '3 tools');
  assert.equal(item('mcp', 'm-error').status, 'error');
  assert.equal(item('mcp', 'm-error').reason, 'HTTP 500');
  assert.equal(item('mcp', 'm-disabled').status, 'disabled');
  assert.equal(item('harness', 'hermes').status, 'connected');
  assert.equal(item('harness', 'claudecode').status, 'needs_attention');
  assert.equal(item('harness', 'claudecode').reason, 'binary missing');
  assert.match(item('harness', 'claudecode').fix ?? '', /CLAUDECODE_MODE/);
  assert.equal(item('connector', 'composio').status, 'available');
  assert.equal(item('connector', 'composio').detail, 'mock');
  assert.equal(
    result.items.some((i) => i.id === 'gemini' && i.kind !== 'key'),
    false,
  );
  assert.deepEqual(result.summary, { connected: 4, needsAttention: 3, available: 2 });
  console.log('Integrations: aggregate status mapping checks passed.');
}

// ---- GET /api/integrations requires the local capability and returns the read model.
{
  const app2 = express();
  app2.use(express.json());
  app2.use('/api', credentialsRouter);
  app2.use('/api', integrationsRouter);
  app2.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof HttpError ? error.status : 500).json({ error: 'error' });
    },
  );
  const server2 = app2.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server2.once('listening', resolve));
  const port = (server2.address() as { port: number }).port;
  try {
    const url = 'http://127.0.0.1:' + port + '/api';
    assert.equal((await fetch(url + '/integrations')).status, 401);
    const session = await fetch(url + '/credentials/session', {
      method: 'POST',
      headers: { Origin: config.webOrigin },
    });
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(url + '/integrations', {
      headers: { Cookie: cookie, Origin: config.webOrigin },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as IntegrationsResponse;
    assert.equal(typeof body.summary.connected, 'number');
    assert.ok(body.items.some((i) => i.kind === 'key' && i.id === 'anthropic'));
    assert.ok(body.items.some((i) => i.kind === 'harness' && i.id === 'hermes'));
  } finally {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  }
  console.log('Integrations: route checks passed.');
}
