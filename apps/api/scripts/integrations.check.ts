import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { credentialsRouter } from '../src/api/credentials.routes.js';
import { HttpError } from '../src/api/middleware/validate.js';
import { parseEnvCredentials } from '../src/services/credentialImport.js';
import { verifyCredential } from '../src/services/credentialVerify.js';

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
