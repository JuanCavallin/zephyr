import assert from 'node:assert/strict';
import express from 'express';
import { CredentialStore } from '../src/services/credentials.js';
import { credentialsRouter } from '../src/api/credentials.routes.js';
import { HttpError } from '../src/api/middleware/validate.js';
import { createGeminiBackend } from '../src/providers/gemini/backend.js';
import { createAnthropicBackend } from '../src/providers/anthropic/backend.js';
import { localOllamaEndpoint } from '../src/providers/ollama/backend.js';
import type { ChatModelBackendInput } from '../src/core/modelGateway/service.js';
import { config } from '../src/config.js';
import { denyUnmappedHermesPermission } from '../src/providers/hermes/live.js';
import { createLiveAnthropic } from '../src/providers/anthropic/live.js';
import { ModelGatewayService } from '../src/core/modelGateway/service.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { createMemoryStore } from '../src/store/memory.js';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { create as createJev } from '../src/providers/jev/index.js';
import { create as createText } from '../src/providers/anthropic/index.js';
import { pauseRun, resumeRun, clearPause } from '../src/core/pauseGate.js';

assert.deepEqual(denyUnmappedHermesPermission([{ optionId: 'allow', kind: 'allow_once' }]), {
  outcome: 'cancelled',
});
assert.deepEqual(
  denyUnmappedHermesPermission([
    { optionId: 'reject', kind: 'reject_once' },
    { optionId: 'allow', kind: 'allow_always' },
  ]),
  { outcome: 'selected', optionId: 'reject' },
);
assert.deepEqual(denyUnmappedHermesPermission([]), { outcome: 'cancelled' });

const user = new CredentialStore({
  source: 'user',
  browserSource: 'operator',
  operator: {
    gemini: { secret: 'operator-secret' },
    browserbase: { secret: 'operator-browser', projectId: 'project' },
  },
});
user.bindRun('alice-run', 'alice');
user.bindRun('bob-run', 'bob');
const alice = { runId: 'alice-run', providerId: 'gemini', purpose: 'model' as const };
assert.equal(await user.resolve(alice), null, 'user funding never falls back to operator');
assert.equal(
  (await user.require({ runId: 'alice-run', providerId: 'browserbase', purpose: 'browser' }))
    .secret,
  'operator-browser',
);
user.put('alice', 'gemini', 'alice-secret');
user.put('bob', 'gemini', 'bob-secret');
const first = await user.require(alice);
assert.equal(first.secret, 'alice-secret');
assert.equal((await user.require({ ...alice, runId: 'bob-run' })).secret, 'bob-secret');
await assert.rejects(user.require({ ...alice, principalId: 'bob' }), /does not own/);
assert.throws(() => user.bindRun('alice-run', 'bob'), /another principal/);
assert.ok(!JSON.stringify(user.statuses('alice')).includes('secret'));
let invalidated: string | undefined;
user.onInvalidate((ref) => {
  invalidated = ref;
});
user.put('alice', 'gemini', 'alice-replacement');
assert.equal(invalidated, first.reference);
assert.equal(user.available(alice), false, 'rotation makes pinned run ineligible');
await assert.rejects(user.require(alice), /changed during/);
assert.throws(() => user.assertCurrent(first.reference, alice), /expired/);
user.remove('alice', 'gemini');
assert.equal(await user.resolve(alice), null);
assert.throws(() => user.put('alice', 'gemini', 'bad\nkey'), /line breaks/);
assert.throws(() => localOllamaEndpoint('https://remote.example'), /loopback/);
assert.throws(() => localOllamaEndpoint('http://user:pass@localhost:11434'), /loopback/);
assert.equal(localOllamaEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');

// Exercise both live model paths without network or provider credentials.
const keys = new CredentialStore({
  source: 'user',
  operator: {
    gemini: { secret: 'never-use-operator' },
    anthropic: { secret: 'never-use-operator' },
  },
});
keys.put('local-user', 'gemini', 'user-gemini');
keys.put('local-user', 'anthropic', 'user-anthropic');
const originalFetch = globalThis.fetch;
let providerCalls = 0;
const ledger: unknown[] = [];
try {
  globalThis.fetch = async (url, init) => {
    providerCalls += 1;
    const headers = new Headers(init?.headers);
    if (String(url).includes('googleapis')) {
      assert.equal(headers.get('x-goog-api-key'), 'user-gemini');
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Gemini result' }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
      });
    }
    assert.equal(headers.get('x-api-key'), 'user-anthropic');
    return Response.json({
      content: [{ type: 'text', text: 'Anthropic result' }],
      usage: { input_tokens: 2, output_tokens: 3 },
    });
  };
  const fallback = {
    async complete() {
      throw new Error('Unexpected fallback');
    },
  };
  const record = async (row: unknown) => {
    ledger.push(row);
  };
  const ctx = { runId: 'model-run', policyRule: 'credential-test' };
  const input: ChatModelBackendInput = {
    route: {
      id: 'test',
      providerId: 'gemini',
      modelId: 'test-model',
      costTier: 'cheap',
      deployment: 'cloud',
      contextScope: 'public',
      supportsTools: true,
      allowedDataLabels: ['public'],
      enabled: true,
    },
    messages: [{ role: 'user', content: 'Public test' }],
    tools: [],
  };
  const gemini = createGeminiBackend(
    { mode: 'live', keyVar: 'GEMINI_API_KEY' },
    record,
    fallback,
    keys,
  );
  const anthropic = createAnthropicBackend(
    { mode: 'live', keyVar: 'ANTHROPIC_API_KEY' },
    record,
    fallback,
    keys,
  );
  assert.equal((await gemini.complete(input, ctx)).text, 'Gemini result');
  assert.equal(
    (
      await anthropic.complete(
        { ...input, route: { ...input.route, providerId: 'anthropic' } },
        ctx,
      )
    ).text,
    'Anthropic result',
  );
  assert.equal(providerCalls, 2);
  assert.ok(!JSON.stringify(ledger).includes('user-gemini'));
  assert.ok(!JSON.stringify(ledger).includes('user-anthropic'));
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('Request headers contained user-gemini and user-anthropic');
  };
  await assert.rejects(
    gemini.complete(input, ctx),
    (error: unknown) => error instanceof Error && error.message === 'Gemini request failed.',
  );
  await assert.rejects(
    anthropic.complete({ ...input, route: { ...input.route, providerId: 'anthropic' } }, ctx),
    (error: unknown) => error instanceof Error && error.message === 'Anthropic request failed.',
  );
  globalThis.fetch = async () => {
    providerCalls += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: 'user-gemini' }] } }] });
  };
  await assert.rejects(gemini.complete(input, ctx), /contained credential data/);
  const beforeRemoval = providerCalls;
  keys.remove('local-user', 'gemini');
  await assert.rejects(gemini.complete(input, ctx), /credentials are required/);
  assert.equal(providerCalls, beforeRemoval, 'removal blocks before provider call');
} finally {
  globalThis.fetch = originalFetch;
}

// Bound SDK text generation (graph synthesis) obeys the same source isolation.
{
  const sdkKeys = new CredentialStore({
    source: 'user',
    operator: { anthropic: { secret: 'operator-sdk-key' } },
  });
  let sdkCalls = 0;
  let rateLimit = false;
  const sdk = createLiveAnthropic(
    { mode: 'live', keyVar: 'ANTHROPIC_API_KEY', apiKey: 'operator-sdk-key' },
    sdkKeys,
    {
      fetch: async (_url, init) => {
        sdkCalls += 1;
        assert.equal(new Headers(init?.headers).get('x-api-key'), 'user-sdk-key');
        if (rateLimit) {
          sdkKeys.remove('local-user', 'anthropic');
          return Response.json(
            { error: { type: 'rate_limit_error', message: 'retry' } },
            { status: 429 },
          );
        }
        return Response.json({
          id: 'sdk-message',
          type: 'message',
          role: 'assistant',
          model: 'test-sdk-model',
          content: [{ type: 'text', text: 'User-funded synthesis' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 3 },
        });
      },
    },
  );
  const sdkContext = { runId: 'sdk-run', policyRule: 'graph-synthesis-test' };
  const missing = await sdk.complete({ prompt: 'Public task' }, sdkContext);
  assert.equal(missing.ok, false);
  assert.equal(sdkCalls, 0, 'bound SDK cannot spend operator credentials in user mode');
  sdkKeys.put('local-user', 'anthropic', 'user-sdk-key');
  const generated = await sdk.complete({ prompt: 'Public task' }, sdkContext);
  assert.ok(generated.ok);
  assert.equal(generated.data.text, 'User-funded synthesis');
  assert.equal(sdkCalls, 1);
  rateLimit = true;
  const limited = await sdk.complete(
    { prompt: 'Public task' },
    { ...sdkContext, runId: 'sdk-rate-limit' },
  );
  assert.equal(limited.ok, false);
  assert.equal(sdkCalls, 2, 'SDK must not retry secretly with a removed user key');
}

// A retry is another metered request: check key freshness before each attempt.
{
  const retryKeys = new CredentialStore({ source: 'user' });
  const fallback = {
    async complete() {
      throw new Error('Unexpected fallback');
    },
  };
  for (const provider of ['gemini', 'anthropic'] as const) {
    retryKeys.put('local-user', provider, 'retry-user-key');
    let attempted = 0;
    globalThis.fetch = async () => {
      attempted += 1;
      retryKeys.remove('local-user', provider);
      return Response.json({}, { status: 429 });
    };
    const backend =
      provider === 'gemini'
        ? createGeminiBackend({ mode: 'live', keyVar: 'key' }, async () => {}, fallback, retryKeys)
        : createAnthropicBackend(
            { mode: 'live', keyVar: 'key' },
            async () => {},
            fallback,
            retryKeys,
          );
    await assert.rejects(
      backend.complete(
        {
          route: {
            id: provider,
            providerId: provider,
            modelId: 'test',
            costTier: 'cheap',
            deployment: 'cloud',
            contextScope: 'public',
            supportsTools: true,
            allowedDataLabels: ['public'],
            enabled: true,
          },
          messages: [{ role: 'user', content: 'Public task' }],
          tools: [],
        },
        { runId: 'retry-' + provider, policyRule: 'retry-key-test' },
      ),
    );
    assert.equal(attempted, 1, 'revoked key cannot be reused for a provider retry');
  }
  globalThis.fetch = originalFetch;
}

// Gateway pause waits before dispatch, preserves the trusted tool ceiling, and
// reroutes only among this run's credential-eligible models after resuming.
{
  const store = createMemoryStore();
  const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
  const sessions = new SessionStateService(store);
  const routes = [
    {
      id: 'user-gemini',
      providerId: 'gemini',
      modelId: 'gemini-test',
      costTier: 'cheap' as const,
      deployment: 'cloud' as const,
      contextScope: 'public' as const,
      supportsTools: true,
      allowedDataLabels: ['public' as const],
      enabled: true,
    },
  ];
  const gatewayKeys = new CredentialStore({
    source: 'user',
    operator: { gemini: { secret: 'never-use-operator' } },
  });
  const tools = new InMemoryToolRegistry();
  for (const name of ['approved', 'unapproved'])
    tools.register({
      descriptor: {
        id: 'test.' + name,
        version: '1',
        providerId: 'test',
        family: 'test',
        description: name,
        inputSchemaRef: 'test://' + name,
        transport: 'local',
        baselineEffect: 'read',
        reversibility: 'reversible',
        requiredScopes: [],
        allowedDataLabels: ['public'],
        availability: 'available',
        executorRef: 'test://' + name,
      },
      wireName: 'test_' + name,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  let modelCalls = 0;
  const gateway = new ModelGatewayService(
    new DecisionService(createJev({ mode: 'mock', keyVar: 'JEV_API_KEY' })),
    sessions,
    createText({ mode: 'mock', keyVar: 'ANTHROPIC_API_KEY' }),
    tools,
    bus,
    {
      modelRoutes: () => routes,
      routeAvailable: (route, ctx) =>
        gatewayKeys.available({ runId: ctx.runId, providerId: route.providerId, purpose: 'model' }),
      backend: {
        async complete(input, ctx) {
          await gatewayKeys.require({ runId: ctx.runId, providerId: 'gemini', purpose: 'model' });
          modelCalls += 1;
          assert.deepEqual(
            input.tools.map((tool) => tool.function?.name),
            ['test_approved'],
          );
          return { text: 'Public result', tokensIn: 1, tokensOut: 1 };
        },
      },
    },
  );
  const state = await sessions.create({
    runId: 'paused-credential-run',
    stepId: 'model-step',
    harness: 'hermes',
    objective: 'Public task',
    sanitizedObjective: 'Public task',
    dataLabels: ['public'],
    budget: { stepsRemaining: 4 },
    candidateToolIds: ['test.approved', 'test.unapproved'],
    taskToolIds: ['test.approved'],
    toolCeiling: ['test.approved'],
  });
  await sessions.beginTurn(state.id);
  const binding = { sessionStateId: state.id, turn: 1 };
  const request = {
    messages: [{ role: 'user', content: 'Public task' }],
    tools: [
      { type: 'function', function: { name: 'test_approved' } },
      { type: 'function', function: { name: 'test_unapproved' } },
    ],
  };
  // The run is told plainly and ends; it does not throw (Hermes retried a 502
  // three times and called it "temporarily unavailable").
  const refused = await gateway.complete(request, binding);
  assert.match(refused.text, /no model with eligible credentials/);
  assert.deepEqual(refused.toolCalls, []);
  assert.equal(
    modelCalls,
    0,
    'missing user key cannot become operator-funded or simulated inference',
  );
  gatewayKeys.put('local-user', 'gemini', 'gateway-user-key');
  pauseRun(state.runId);
  const pending = gateway.complete(request, binding);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(modelCalls, 0, 'pause holds model dispatch');
  resumeRun(state.runId);
  const resumed = await pending;
  assert.equal(resumed.sessionStateId, state.id);
  assert.equal(modelCalls, 1);
  gatewayKeys.put('local-user', 'gemini', 'gateway-replacement-key');
  // Refused either before routing (the run is told and ends) or by the pinned
  // credential check (a rejection); never answered by a model.
  const rotated = await gateway.complete(request, binding).then(
    (completion) => completion.text,
    (error: Error) => error.message,
  );
  assert.match(rotated, /eligible credentials/);
  assert.equal(modelCalls, 1, 'key rotation invalidates the pinned run without funding fallback');
  clearPause(state.runId);
}

// Local browser authentication: loopback Origin, HttpOnly session, CSRF denial,
// no credential echoes, and authenticated reads/updates/removal.
const app = express();
app.use(express.json());
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
try {
  assert.equal((await fetch(base)).status, 401);
  assert.equal(
    (
      await fetch(base + '/session', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + '/session', { method: 'POST' })).status, 403);
  const established = await fetch(base + '/session', {
    method: 'POST',
    headers: { Origin: config.webOrigin },
  });
  assert.equal(established.status, 200);
  const setCookie = established.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(setCookie?.includes('HttpOnly'));
  assert.ok(setCookie?.includes('SameSite=Strict'));
  const cookie = setCookie.split(';')[0]!;
  const headers = { Cookie: cookie, Origin: config.webOrigin, 'Content-Type': 'application/json' };
  const saved = await fetch(base + '/gemini', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ secret: 'test-never-echo-key' }),
  });
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes('test-never-echo-key'));
  const status = await fetch(base, { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.ok(!(await status.text()).includes('test-never-echo-key'));
  assert.equal(
    (
      await fetch(base + '/gemini', {
        method: 'DELETE',
        headers: { ...headers, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + '/gemini', { method: 'DELETE', headers })).status, 200);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log(
  'Credential isolation, live backend BYOK, rotation/removal, privacy and local authenticated API checks passed.',
);
