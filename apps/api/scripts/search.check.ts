import assert from 'node:assert/strict';
import type { BrowserAdapter, ElementTable, ToolAction } from '@htn/shared';
import { createSearchExecutor, registerSearchTool } from '../src/core/tools/search.js';
import { CredentialStore } from '../src/services/credentials.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { createMockBrowser } from '../src/providers/mockBrowser.js';

const ctx = { runId: 'search-run', policyRule: 'exact-action-test' };
const action: ToolAction = {
  id: 'search-action',
  runId: ctx.runId,
  stepId: 'search-step',
  toolId: 'web.search',
  descriptorVersion: '1',
  operation: 'web.search',
  arguments: { query: 'public research', maxResults: 3 },
  dataLabels: ['public'],
  destination: 'https://api.tavily.com/search',
  createdAt: new Date().toISOString(),
};
const keys = new CredentialStore({
  source: 'user',
  operator: { tavily: { secret: 'never-use-operator-key' } },
});
const browser = createMockBrowser('browserbase', { mode: 'mock', keyVar: 'BROWSERBASE_API_KEY' });
let calls = 0;
const ledger: unknown[] = [];
const live = createSearchExecutor({
  backend: 'tavily',
  mode: 'live',
  browser: () => browser,
  credentialResolver: keys,
  fetch: async (_url, init) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user-tavily-key');
    assert.equal(init?.redirect, 'error');
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(payload.include_raw_content, false);
    assert.equal(payload.include_answer, false);
    return Response.json({
      results: [
        {
          title: 'Source',
          url: 'https://example.com/article',
          content: 'Bounded public source. user-tavily-key',
          published_date: '2026-10-05',
        },
        { title: 'Private URL', url: 'http://127.0.0.1/private', content: 'Should be discarded' },
        {
          title: 'Raw document',
          url: 'https://example.net/',
          content: 'x'.repeat(9000),
          raw_content: 'Do not return entire document',
        },
      ],
    });
  },
  recordEgress: async (entry) => {
    ledger.push(entry);
  },
});
await assert.rejects(live.execute(action, ctx), /credentials are required/);
assert.equal(calls, 0, 'missing user key does not spend operator key');
keys.put('local-user', 'tavily', 'user-tavily-key');
for (const label of ['private', 'local_only', 'secret'] as const) {
  await assert.rejects(
    live.execute({ ...action, dataLabels: [label] }, ctx),
    /public queries only/,
  );
}
assert.equal(calls, 0, 'privacy blocks before provider I/O');
await assert.rejects(
  live.execute({ ...action, destination: 'https://other.example' }, ctx),
  /destination/,
);
const result = await live.execute(action, ctx);
assert.equal(calls, 1);
assert.equal(result.executionMode, 'live');
assert.ok(!JSON.stringify(result).includes('user-tavily-key'));
assert.ok(!JSON.stringify(result).includes('raw_content'));
const model = result.modelOutput as { results: { snippet: string }[] };
assert.equal(model.results.length, 2);
assert.ok(model.results[1]!.snippet.length <= 480);
assert.ok(!JSON.stringify(ledger).includes('user-tavily-key'));
assert.ok(
  !JSON.stringify(ledger).includes('public research'),
  'egress stores classes/destination, not query',
);
const leaking = createSearchExecutor({
  backend: 'tavily',
  mode: 'live',
  browser: () => browser,
  credentialResolver: keys,
  fetch: async () => {
    throw new Error('Request headers user-tavily-key');
  },
});
await assert.rejects(
  leaking.execute(action, ctx),
  (error: unknown) => error instanceof Error && error.message === 'Tavily search request failed.',
);
const oversized = createSearchExecutor({
  backend: 'tavily',
  mode: 'live',
  browser: () => browser,
  credentialResolver: keys,
  fetch: async () => new Response('{}', { headers: { 'content-length': '128001' } }),
});
await assert.rejects(oversized.execute(action, ctx), /exceeded its size budget/);
keys.remove('local-user', 'tavily');
await assert.rejects(live.execute(action, ctx), /credentials are required/);
assert.equal(calls, 1);

const mock = createSearchExecutor({
  backend: 'tavily',
  mode: 'mock',
  browser: () => browser,
  fetch: async () => {
    throw new Error('Mock must not call network');
  },
});
const mockResult = await mock.execute(
  {
    ...action,
    destination: mock.destinationFor({ descriptor: {} as never, arguments: action.arguments }),
  },
  ctx,
);
assert.equal(mockResult.executionMode, 'mock');
assert.equal(mockResult.verified, false);
assert.equal((mockResult.output as { simulated: boolean }).simulated, true);
assert.match(mockResult.summary, /no external search/);
const disabled = createSearchExecutor({
  backend: 'tavily',
  mode: 'disabled',
  browser: () => browser,
});
await assert.rejects(disabled.execute(action, ctx), /disabled/);

// The browser path is a deterministic disposable read, no model-generated actions.
let openedURL = '';
let closed = 0;
let blocked = false;
const table: ElementTable = {
  sessionId: 'browser-search',
  snapshotId: 'snapshot',
  url: 'https://duckduckgo.com/',
  title: 'Public search',
  capturedAt: new Date().toISOString(),
  rows: [
    {
      index: 1,
      role: 'link',
      label: 'Source title',
      clickable: true,
      editable: false,
      selectable: false,
    },
  ],
  totalInteractive: 1,
  truncated: false,
};
const metadata = {
  provider: 'browserbase' as const,
  op: 'search-test',
  mode: 'live' as const,
  latencyMs: 0,
  destination: 'https://api.browserbase.com',
};
const stub: BrowserAdapter = {
  ...browser,
  mode: 'live',
  async openSession(input) {
    openedURL = input.startUrl ?? '';
    return { ok: true, data: { sessionId: table.sessionId }, meta: metadata };
  },
  async snapshot() {
    return { ok: true, data: table, meta: metadata };
  },
  async extract<T>() {
    return {
      ok: true,
      data: {
        title: table.title,
        text: blocked ? 'Verify you are human' : 'Public search results snippets',
        url: openedURL,
      } as T,
      meta: metadata,
    };
  },
  async closeSession() {
    closed += 1;
    return { ok: true, data: null, meta: metadata };
  },
};
const browserSearch = createSearchExecutor({
  backend: 'browser',
  mode: 'live',
  browser: () => stub,
});
const browserAction = { ...action, destination: 'https://duckduckgo.com/' };
const browserResult = await browserSearch.execute(browserAction, ctx);
assert.ok(openedURL.includes('q=public%20research'));
assert.equal(closed, 1);
assert.equal(
  (browserResult.modelOutput as { results: { kind: string }[] }).results[0]!.kind,
  'search_page',
  'cannot fabricate source URLs from an accessibility table',
);
blocked = true;
await assert.rejects(browserSearch.execute(browserAction, ctx), /blocked/);
assert.equal(closed, 2, 'blocked search still closes owned browser session');
const wrongMode = createSearchExecutor({
  backend: 'browser',
  mode: 'live',
  browser: () => browser,
});
await assert.rejects(wrongMode.execute(browserAction, ctx), /live browser backend/);
const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
registerSearchTool(registry, executors, {
  backend: 'tavily',
  mode: 'live',
  browser: () => stub,
  credentialResolver: keys,
});
assert.equal((await registry.get('web.search'))?.descriptor.baselineEffect, 'read');
assert.deepEqual((await registry.get('web.search'))?.descriptor.allowedDataLabels, ['public']);
console.log(
  'Web search live Tavily protocol, scoped keys, privacy, bounded untrusted results, mock and browser read lifecycle passed.',
);
