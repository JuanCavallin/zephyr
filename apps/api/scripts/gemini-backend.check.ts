/**
 * Gemini wire-translation check.
 *
 * No live key is required, and that is the point: the risky part of this
 * backend is not the HTTP call, it is the OpenAI <-> Gemini conversion, which
 * fails silently (wrong role, dropped system prompt, rejected schema) rather
 * than loudly. Each assertion below is one of those silent failures.
 */

import assert from 'node:assert/strict';
import type { ChatModelBackendInput, OpenAiMessage } from '../src/core/modelGateway/service.js';
import {
  geminiModelRoutes,
  parseToolCalls,
  rememberThoughtSignatures,
  sanitizeSchema,
  toGeminiRequest,
  toGeminiTools,
} from '../src/providers/gemini/backend.js';

// --- system messages become systemInstruction, not a user turn ---------------
{
  const messages: OpenAiMessage[] = [
    { role: 'system', content: 'You are careful.' },
    { role: 'user', content: 'Book a flight.' },
  ];
  const out = toGeminiRequest(messages);

  assert.equal(out.systemInstruction?.parts[0]?.text, 'You are careful.');
  assert.equal(out.contents.length, 1, 'the system turn must not become a content turn');
  assert.equal(out.contents[0]?.role, 'user');
  assert.deepEqual(out.contents[0]?.parts, [{ text: 'Book a flight.' }]);
}

// --- assistant maps to 'model'; tool_calls become functionCall parts ---------
{
  const messages: OpenAiMessage[] = [
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
  const out = toGeminiRequest(messages);

  const model = out.contents[1];
  assert.equal(model?.role, 'model', 'assistant must map to the model role');
  // A call Gemini did not sign (another model made it) carries Google's
  // documented stand-in; without any signature Gemini 3 answers HTTP 400.
  assert.deepEqual(model?.parts, [
    {
      functionCall: { name: 'mail_send', args: { to: 'a@b.c' } },
      thoughtSignature: 'skip_thought_signature_validator',
    },
  ]);

  // The tool result must be addressed by NAME, recovered from the call id.
  const toolTurn = out.contents[2];
  assert.equal(toolTurn?.role, 'user');
  assert.deepEqual(toolTurn?.parts, [
    { functionResponse: { name: 'mail_send', response: { result: 'delivered' } } },
  ]);
}

// --- malformed tool arguments degrade to {}, they do not throw ---------------
{
  const out = toGeminiRequest([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: 'not json' } }],
    },
  ]);
  assert.deepEqual(out.contents[0]?.parts, [
    { functionCall: { name: 'x', args: {} }, thoughtSignature: 'skip_thought_signature_validator' },
  ]);
}

// --- Gemini's own thought signature is put back when its call is replayed ---
{
  const input = {
    tools: [{ type: 'function', function: { name: 'mail_send' } }],
  } as ChatModelBackendInput;
  const returned = [
    { functionCall: { name: 'mail_send', args: { to: 'a@b.c' } }, thoughtSignature: 'sig-123' },
  ];
  const calls = parseToolCalls(returned, input);
  rememberThoughtSignatures(returned, calls);
  const replayed = toGeminiRequest([
    { role: 'user', content: 'Send it.' },
    { role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0]!.id, content: 'delivered' },
  ]);
  assert.deepEqual(replayed.contents[1]?.parts, [
    { functionCall: { name: 'mail_send', args: { to: 'a@b.c' } }, thoughtSignature: 'sig-123' },
  ]);
  assert.notEqual(
    parseToolCalls(returned, input)[0]?.id,
    calls[0]?.id,
    'call ids are unique across requests, so signatures cannot collide',
  );
}

// --- an assistant turn with nothing in it is dropped, not sent empty --------
{
  const out = toGeminiRequest([{ role: 'assistant', content: '' }]);
  assert.equal(out.contents.length, 0, 'an empty model turn is rejected by the API');
}

// --- schema keywords Gemini rejects are stripped, recursively ----------------
{
  const cleaned = sanitizeSchema({
    $schema: 'https://json-schema.org/draft-07/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      to: { type: 'string' },
      cc: { type: 'array', items: { type: 'string' }, default: [] },
      nested: {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
      },
    },
    required: ['to'],
  }) as Record<string, any>;

  assert.ok(!('$schema' in cleaned));
  assert.ok(!('additionalProperties' in cleaned));
  assert.ok(!('default' in cleaned.properties.cc), 'nested default must be stripped too');
  assert.ok(
    !('additionalProperties' in cleaned.properties.nested),
    'stripping must recurse into nested objects',
  );
  // Structure that Gemini DOES accept must survive untouched.
  assert.deepEqual(cleaned.required, ['to']);
  assert.equal(cleaned.properties.cc.items.type, 'string');
  assert.equal(cleaned.properties.nested.properties.a.type, 'string');
}

// --- tools wrap into a single functionDeclarations block --------------------
{
  const tools = toGeminiTools([
    {
      type: 'function',
      function: { name: 'mail_send', description: 'send', parameters: { type: 'object' } },
    },
    { type: 'function', function: { name: 'browser_open' } },
  ]) as { functionDeclarations: { name: string }[] }[];

  assert.equal(tools.length, 1, 'all declarations go in one tools entry');
  assert.deepEqual(
    tools[0]?.functionDeclarations.map((d) => d.name),
    ['mail_send', 'browser_open'],
  );
  assert.deepEqual(toGeminiTools([]), [], 'no tools must send no tools key');
}

// --- SECURITY: a tool AgentOS did not expose is rejected, not executed -------
{
  const input = {
    tools: [{ type: 'function', function: { name: 'mail_send' } }],
  } as ChatModelBackendInput;

  const allowed = parseToolCalls(
    [{ functionCall: { name: 'mail_send', args: { to: 'a@b.c' } } }],
    input,
  );
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]?.function.name, 'mail_send');
  assert.equal(allowed[0]?.function.arguments, '{"to":"a@b.c"}', 'args must be JSON-stringified');
  assert.equal(allowed[0]?.type, 'function');

  assert.throws(
    () => parseToolCalls([{ functionCall: { name: 'shell_exec', args: {} } }], input),
    /did not expose/,
    'a tool outside this turn exposure must be refused',
  );

  // Text-only parts are not tool calls.
  assert.deepEqual(parseToolCalls([{ text: 'hello' }], input), []);
}

// --- routes only exist when the provider is actually live -------------------
{
  assert.deepEqual(
    geminiModelRoutes({
      mode: 'mock',
      keyVar: 'GEMINI_API_KEY',
      models: { cheap: 'a', frontier: 'b' },
    }),
    [],
    'a mock provider must advertise no cloud routes',
  );

  const routes = geminiModelRoutes({
    mode: 'live',
    keyVar: 'GEMINI_API_KEY',
    models: { cheap: 'gemini-cheap-x', frontier: 'gemini-frontier-y' },
  });
  assert.equal(routes.length, 2);
  assert.ok(
    routes.every((r) => r.providerId === 'gemini' && r.deployment === 'cloud'),
    'a Google route is cloud egress and must never claim otherwise',
  );
  assert.ok(
    routes.every((r) => r.allowedDataLabels.length === 1 && r.allowedDataLabels[0] === 'public'),
    'cloud routes may only carry explicitly public data',
  );

  // Both tiers on one model must not produce a duplicate route.
  const collapsed = geminiModelRoutes({
    mode: 'live',
    keyVar: 'GEMINI_API_KEY',
    models: { cheap: 'same', frontier: 'same' },
  });
  assert.equal(collapsed.length, 1);
}

console.log(
  'PASS: Gemini translation preserves system/tool roles, strips unsupported schema keywords, ' +
    'refuses unexposed tools, and advertises cloud routes as public-only.',
);
