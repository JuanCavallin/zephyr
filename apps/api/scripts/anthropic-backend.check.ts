/**
 * Anthropic wire-translation and tool-backend check.
 *
 * This is deliberately offline: the live path is exercised with a fetch stub,
 * so CI proves the request headers, system/tool round trip, route metadata and
 * exposed-tool refusal without requiring an Anthropic key.
 */

import assert from 'node:assert/strict';
import type { TextModelAdapter } from '@htn/shared';
import { isBoundTextRoute, modelRoutesFor } from '../src/core/modelGateway/catalog.js';
import type { ChatModelBackendInput, OpenAiMessage } from '../src/core/modelGateway/service.js';
import {
  anthropicModelRoutes,
  createAnthropicBackend,
  parseToolCalls,
  toAnthropicRequest,
  toAnthropicTools,
} from '../src/providers/anthropic/backend.js';

const input = {
  route: {
    id: 'anthropic-standard',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5',
    costTier: 'standard',
    deployment: 'cloud',
    contextScope: 'public',
    supportsTools: true,
    allowedDataLabels: ['public'],
    enabled: true,
  },
  tools: [
    {
      type: 'function',
      function: {
        name: 'mail_send',
        description: 'Send a message',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
      },
    },
  ],
  messages: [],
  maxTokens: 256,
} as ChatModelBackendInput;

// System stays top-level; assistant/tool turns round-trip through Anthropic's
// tool_use/tool_result blocks rather than being flattened into plain text.
{
  const messages: OpenAiMessage[] = [
    { role: 'system', content: 'Be careful.' },
    { role: 'user', content: 'Send it.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'mail_send', arguments: '{"to":"a@b.c"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_abc', content: 'delivered' },
  ];
  const out = toAnthropicRequest(messages);
  assert.equal(out.system, 'Be careful.');
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[1]?.content, [
    { type: 'tool_use', id: 'call_abc', name: 'mail_send', input: { to: 'a@b.c' } },
  ]);
  assert.deepEqual(out.messages[2]?.content, [
    { type: 'tool_result', tool_use_id: 'call_abc', content: 'delivered' },
  ]);
}

{
  const tools = toAnthropicTools(input.tools) as { name: string; input_schema: unknown }[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'mail_send');
  assert.deepEqual(tools[0]?.input_schema, input.tools[0]?.function?.parameters);
  assert.deepEqual(toAnthropicTools([]), []);
}

{
  const allowed = parseToolCalls(
    [{ type: 'tool_use', id: 'call_1', name: 'mail_send', input: { to: 'a@b.c' } }],
    input,
  );
  assert.equal(allowed[0]?.function.name, 'mail_send');
  assert.equal(allowed[0]?.function.arguments, '{"to":"a@b.c"}');
  assert.throws(
    () =>
      parseToolCalls([{ type: 'tool_use', id: 'call_2', name: 'shell_exec', input: {} }], input),
    /did not expose/,
  );
}

{
  assert.deepEqual(anthropicModelRoutes({ mode: 'mock', keyVar: 'ANTHROPIC_API_KEY' }), []);
  const routes = anthropicModelRoutes({
    mode: 'live',
    keyVar: 'ANTHROPIC_API_KEY',
    models: { cheap: 'haiku', standard: 'sonnet', frontier: 'opus' },
  });
  assert.equal(routes.length, 3);
  assert.ok(routes.every((route) => route.providerId === 'anthropic'));
  assert.ok(routes.every((route) => route.supportsTools));
  assert.ok(routes.every((route) => route.allowedDataLabels[0] === 'public'));
}

{
  const originalFetch = globalThis.fetch;
  let request: { url: string; headers: Headers; body: Record<string, any> } | undefined;
  globalThis.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    return new Response(
      JSON.stringify({
        model: 'claude-sonnet-5-served',
        content: [
          { type: 'text', text: 'I will send it.' },
          { type: 'tool_use', id: 'call_1', name: 'mail_send', input: { to: 'a@b.c' } },
        ],
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const backend = createAnthropicBackend(
      {
        mode: 'live',
        apiKey: 'test-key',
        baseUrl: 'https://anthropic.test/v1',
        keyVar: 'ANTHROPIC_API_KEY',
        models: { cheap: 'haiku', standard: 'sonnet', frontier: 'opus' },
      },
      async () => undefined,
      { complete: async () => ({ text: '', tokensIn: 0, tokensOut: 0 }) },
    );
    const result = await backend.complete(
      { ...input, messages: [{ role: 'user', content: 'Send it.' }] },
      { runId: 'run_test', stepId: 'step_test', policyRule: 'test' },
    );
    assert.equal(request?.url, 'https://anthropic.test/v1/messages');
    assert.equal(request?.headers.get('x-api-key'), 'test-key');
    assert.equal(request?.headers.get('anthropic-version'), '2023-06-01');
    assert.equal(request?.body.system, undefined);
    assert.equal(request?.body.tools[0].name, 'mail_send');
    assert.equal(result.actualModel, 'claude-sonnet-5-served');
    assert.equal(result.toolCalls?.[0]?.function.name, 'mail_send');
    assert.equal(result.tokensIn, 12);
    assert.equal(result.tokensOut, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// When Anthropic is also the bound text model, the bound routes carry
// providerId 'anthropic' with a placeholder modelId. They must reach the bound
// adapter, never the Messages API (which 404s on 'model: bound-cheap').
{
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('{}', { status: 404 });
  };
  try {
    const [boundRoute] = modelRoutesFor({
      id: 'anthropic',
      mode: 'live',
    } as unknown as TextModelAdapter);
    assert.ok(boundRoute && isBoundTextRoute(boundRoute));
    let fellBack = false;
    const backend = createAnthropicBackend(
      {
        mode: 'live',
        apiKey: 'test-key',
        keyVar: 'ANTHROPIC_API_KEY',
        models: { cheap: 'haiku', frontier: 'opus' },
      },
      async () => undefined,
      {
        complete: async () => {
          fellBack = true;
          return { text: 'bound', tokensIn: 0, tokensOut: 0 };
        },
      },
    );
    const result = await backend.complete(
      { ...input, route: boundRoute, tools: [], messages: [{ role: 'user', content: 'hi' }] },
      { runId: 'run_test', stepId: 'step_test', policyRule: 'test' },
    );
    assert.ok(fellBack, 'bound route must use the bound text adapter');
    assert.ok(!fetched, 'bound route must not call the Messages API');
    assert.equal(result.text, 'bound');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(
  'PASS: Anthropic preserves system/tool roles, emits Messages API schemas, refuses unexposed tools, and records a tool-capable route.',
);
