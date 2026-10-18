import assert from 'node:assert/strict';
import type {
  ProviderCallContext,
  ProviderResult,
  ToolboxAdapter,
  ToolboxToolDefinition,
  ToolAction,
} from '@htn/shared';
import type { ProviderConfig } from '../src/config.js';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { createLiveComposio } from '../src/providers/composio/live.js';
import {
  catalogSearchQueries,
  catalogIntentQuery,
  classifyComposioTool,
  ComposioToolCatalog,
} from '../src/providers/composio/register.js';

const send = definition('GMAIL_SEND_EMAIL', 'gmail');
const profile = definition('GMAIL_GET_PROFILE', 'gmail');
const remove = definition('GITHUB_DELETE_REPOSITORY', 'github');
const unknown = definition('GMAIL_MAGICALIZE_EMAIL', 'gmail');

assert.deepEqual(classifyComposioTool(send), {
  toolId: 'mail.send',
  wireName: 'mail_send',
  family: 'mail',
  baselineEffect: 'write',
  reversibility: 'irreversible',
  allowedDataLabels: ['public', 'private'],
});
assert.equal(classifyComposioTool(profile)?.baselineEffect, 'read');
assert.equal(classifyComposioTool(profile)?.toolId, 'gmail.get_profile');
assert.equal(classifyComposioTool(remove)?.baselineEffect, 'destructive');
assert.equal(
  classifyComposioTool(definition('GMAIL_IMPORT_MESSAGE', 'gmail'))?.reversibility,
  'recoverable',
);
assert.equal(
  classifyComposioTool(definition('GMAIL_LIST_SEND_AS', 'gmail'))?.baselineEffect,
  'read',
);
assert.equal(
  classifyComposioTool(definition('GMAIL_SETTINGS_SEND_AS_GET', 'gmail'))?.baselineEffect,
  'read',
);
assert.deepEqual(
  {
    effect: classifyComposioTool(definition('GMAIL_PATCH_SEND_AS', 'gmail'))?.baselineEffect,
    reversibility: classifyComposioTool(definition('GMAIL_PATCH_SEND_AS', 'gmail'))?.reversibility,
  },
  { effect: 'write', reversibility: 'irreversible' },
);
assert.equal(classifyComposioTool(unknown), null, 'unknown operations must fail closed');
assert.equal(
  catalogIntentQuery('Send an email to [[PII_1]] with content: lets lock in'),
  'Send an email',
);

const searched: string[] = [];
const called: string[] = [];
const calledArgs: Record<string, unknown>[] = [];
const adapter: ToolboxAdapter = {
  id: 'composio',
  mode: 'live',
  capabilities: ['toolbox'],
  health: async () => ok('health', {}),
  invoke: async () => ok('invoke', null as never),
  listTools: async () => ok('listTools', [send]),
  searchTools: async (input) => {
    searched.push(input.query);
    return ok('searchTools', [send, profile, unknown]);
  },
  connectUrl: async () => ok('connectUrl', { url: 'https://example.invalid/connect' }),
  callTool: async (input) => {
    called.push(input.name + '@' + input.version);
    calledArgs.push(input.args);
    return ok('callTool', { successful: true });
  },
};
const cfg: ProviderConfig = {
  mode: 'live',
  keyVar: 'COMPOSIO_API_KEY',
  userId: 'check-user',
  discoveryLimit: 24,
};
const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
const catalog = new ComposioToolCatalog(adapter, cfg, registry, executors);
const report = await catalog.discoverForTask({
  query: 'read my profile and send an email',
  runId: 'run_check',
});

// Content words first: the catalog search wants a short phrase.
assert.deepEqual(searched, ['read profile send email']);
assert.deepEqual(report.registered.sort(), ['gmail.get_profile', 'mail.send']);
assert.deepEqual(report.skipped, ['GMAIL_MAGICALIZE_EMAIL']);
assert.deepEqual(report.requiresConnection, []);

// Composio's catalog search wants a short phrase. Observed live: "Using my
// connected Gmail account, find out how many labels I have..." matched no
// tools and "gmail labels" twelve; a calendar request with its title and time
// matched 22 tools without create_event, "create calendar event" found it.
const question =
  'Using my connected Gmail account, find out how many labels I have and tell me the number.';
assert.deepEqual(catalogSearchQueries(question), ['gmail labels', question, 'labels', 'gmail']);
assert.equal(
  catalogSearchQueries(
    "Create a Google Calendar event called 'AgentOS loop test' tomorrow at 10am for 30 minutes.",
  )[0],
  'create google calendar event',
);
assert.equal(catalogSearchQueries("Don't send it, just draft an email")[0], 'send draft email');
{
  const tried: string[] = [];
  const labels = definition('GMAIL_LIST_LABELS', 'gmail');
  const picky = new ComposioToolCatalog(
    {
      ...adapter,
      searchTools: async (input) => {
        tried.push(input.query);
        return ok('searchTools', input.query === 'labels' ? [labels] : []);
      },
    },
    cfg,
    new InMemoryToolRegistry(),
    new InMemoryToolExecutorRegistry(),
  );
  const found = await picky.discoverForTask({ query: question, runId: 'run_check' });
  assert.deepEqual(found.registered, ['gmail.list_labels']);
  assert.deepEqual(
    tried,
    ['gmail labels', question, 'labels'],
    'tries shorter queries in order and stops at the first that matches',
  );
}

const registered = await registry.get('mail.send');
assert.ok(registered);
assert.equal(registered.descriptor.availability, 'available');
assert.deepEqual(registered.inputSchema, {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'Primary recipient email address.' },
    subject: {
      type: 'string',
      description: 'Optional email subject. Omit it when the user did not provide one.',
    },
    body: { type: 'string', description: 'Email body exactly as requested by the user.' },
    is_html: {
      type: 'boolean',
      description: 'True only when the body contains HTML.',
      default: false,
    },
    cc: {
      type: 'array',
      description: 'Optional carbon-copy recipient email addresses.',
      items: { type: 'string' },
      default: [],
    },
    bcc: {
      type: 'array',
      description: 'Optional blind-carbon-copy recipient email addresses.',
      items: { type: 'string' },
      default: [],
    },
  },
  required: ['to', 'body'],
  additionalProperties: false,
});
const executor = executors.resolve(registered.descriptor.executorRef);
assert.ok(executor);
const action: ToolAction = {
  id: 'act_check',
  runId: 'run_check',
  stepId: 'step_check',
  toolId: registered.descriptor.id,
  descriptorVersion: registered.descriptor.version,
  operation: registered.descriptor.id,
  arguments: { to: 'demo@example.com', body: 'Test body' },
  destination: 'demo@example.com',
  dataLabels: ['private'],
  createdAt: new Date().toISOString(),
};
assert.equal(
  executor.destinationFor({ descriptor: registered.descriptor, arguments: action.arguments }),
  'demo@example.com',
);
await executor.execute(action, context('run_check'));
assert.deepEqual(called, ['GMAIL_SEND_EMAIL@20260915_00']);
assert.deepEqual(calledArgs, [{ recipient_email: 'demo@example.com', body: 'Test body' }]);

const originalFetch = globalThis.fetch;
const requestedUrls: string[] = [];
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('/connected_accounts?')) {
      return Response.json({
        items: [
          {
            id: 'ca_test',
            user_id: 'check-user',
            status: 'ACTIVE',
            toolkit: { slug: 'gmail' },
          },
        ],
      });
    }
    if (url.includes('/api/v3.1/tools?')) {
      return Response.json({
        items: [
          {
            slug: 'GMAIL_GET_PROFILE',
            version: '20260915_00',
            description: 'Get profile',
            toolkit: { slug: 'gmail' },
            input_parameters: { type: 'object', properties: {} },
            scopes: ['scope:test'],
          },
        ],
      });
    }
    if (url.includes('/api/v3.1/tools/execute/')) {
      return Response.json({ successful: true });
    }
    throw new Error('Unexpected URL: ' + url);
  };
  const live = createLiveComposio({
    ...cfg,
    apiKey: 'not-a-real-key',
    baseUrl: 'https://composio.example',
  });
  const discovered = await live.searchTools(
    { query: 'private-looking query', toolkits: ['gmail'], limit: 1 },
    context('run_live_adapter_check'),
  );
  assert.equal(discovered.ok, true);
  assert.equal((discovered.meta.destination ?? '').includes('private-looking'), false);
  assert.equal(
    requestedUrls.some((url) => url.includes('query=private-looking+query')),
    true,
  );
  const executed = await live.callTool(
    { name: 'GMAIL_GET_PROFILE', version: '20260915_00', args: {} },
    context('run_live_adapter_check'),
  );
  assert.equal(executed.ok, true);
  const untrusted = await live.callTool(
    { name: 'GMAIL_UNKNOWN', version: '1', args: {} },
    context('run_live_adapter_check'),
  );
  assert.equal(untrusted.ok, false, 'unresolved provider tool must not execute');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('composio catalog checks passed');

function definition(name: string, toolkit: string): ToolboxToolDefinition {
  return {
    name,
    toolkit,
    version: '20260915_00',
    description: name,
    inputSchema: {
      type: 'object',
      properties: { recipient_email: { type: 'string' } },
      additionalProperties: false,
    },
    requiredScopes: ['scope:test'],
    connectedAccountId: 'ca_test',
  };
}

function context(runId: string): ProviderCallContext {
  return { runId, policyRule: 'catalog-check' };
}

function ok<T>(op: string, data: T): ProviderResult<T> {
  return {
    ok: true,
    data,
    meta: {
      provider: 'composio',
      op,
      mode: 'live',
      latencyMs: 0,
      destination: 'mock://composio-check',
    },
  };
}
