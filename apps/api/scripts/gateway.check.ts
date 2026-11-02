/**
 * `pnpm check:gateway` -- the Anthropic Messages passthrough (step 4), offline.
 *
 * Replay, errors, cache prefix, redaction placeholders, rewrite hook, ledger,
 * budget, tool budget, count_tokens, auth, the real upstream's header handling,
 * and the HTTP surface (raw body through createApp, streaming through Express).
 * Every upstream is the replayer in core/modelGateway/replay; nothing leaves the box.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { parseRunEvent, type RunEvent } from '@htn/shared';
import { createApp } from '../src/app.js';
import {
  createAnthropicMessagesRouter,
  isAnthropicMessagesPath,
} from '../src/api/anthropicMessages.routes.js';
import { CacheLedger } from '../src/core/modelGateway/cacheLedger.js';
import {
  AnthropicMessagesGateway,
  fetchUpstream,
  toolUsesThisTurn,
  type AnthropicUpstream,
  type GatewayReply,
  type MessagesGatewayOptions,
  type MessagesPath,
  type RewriteHook,
} from '../src/core/modelGateway/messages.js';
import {
  gatewayRunTokens,
  GatewayRunTokenStore,
  type GatewayRunBinding,
} from '../src/core/modelGateway/runTokens.js';
import { TOOL_BUDGET_EXHAUSTED_INSTRUCTION } from '../src/core/modelGateway/turnBudget.js';
import {
  COUNT_TOKENS_REQUEST,
  COUNT_TOKENS_RESPONSE,
  ERROR_BODIES,
  FIXTURE_MODEL,
  JSON_HEADERS,
  NO_CACHE_STREAM,
  NON_STREAM_RESPONSE,
  OVERLOADED_MID_STREAM,
  STREAM_HEADERS,
  TURN1_REQUEST,
  TURN1_STREAM,
  TURN2_REQUEST,
  TURN2_STREAM,
} from '../src/core/modelGateway/replay/fixtures.js';
import {
  bytes,
  createReplayer,
  parseSse,
  readAll,
  type ReplayStep,
} from '../src/core/modelGateway/replay/replayer.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const results: { name: string; ok: boolean; error?: unknown }[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ok   ' + name);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log('  FAIL ' + name);
    console.log(
      '       ' +
        String((error as Error).stack ?? error)
          .split('\n')
          .join('\n       '),
    );
  }
}

const decoder = new TextDecoder();
const text = (b: Uint8Array) => decoder.decode(b);
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

interface Setup {
  gateway: AnthropicMessagesGateway;
  replay: ReturnType<typeof createReplayer>;
  tokens: GatewayRunTokenStore;
  events: RunEvent[];
  token: string;
  runId: string;
  send(body: string | Uint8Array, opts?: SendOpts): Promise<GatewayReply>;
}

interface SendOpts {
  path?: MessagesPath;
  search?: string;
  token?: string | null;
  headers?: Record<string, string>;
}

let runCounter = 0;

function setup(
  steps: ReplayStep[],
  opts: Partial<MessagesGatewayOptions> & { binding?: Partial<GatewayRunBinding> } = {},
): Setup {
  const replay = createReplayer(steps);
  const tokens = opts.tokens ?? new GatewayRunTokenStore();
  const events: RunEvent[] = [];
  const { binding: bindingOpts, ...gatewayOpts } = opts;
  const gateway = new AnthropicMessagesGateway({
    upstream: replay.upstream,
    tokens,
    // Every event the gateway emits must satisfy the shared contract.
    emit: (_runId, event) => {
      events.push(parseRunEvent(event));
    },
    ...gatewayOpts,
  });
  runCounter += 1;
  const runId = bindingOpts?.runId ?? 'run_gwcheck' + runCounter.toString();
  const token = tokens.mint({ runId, harness: 'claudecode', budget: {}, ...bindingOpts });
  const send = (body: string | Uint8Array, s: SendOpts = {}) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...s.headers,
    };
    const t = s.token === undefined ? token : s.token;
    if (t !== null) headers.authorization = 'Bearer ' + t;
    const path = s.path ?? '/v1/messages';
    const req = { path, search: s.search ?? '', body: bytes(body), headers };
    return path === '/v1/messages' ? gateway.messages(req) : gateway.countTokens(req);
  };
  return { gateway, replay, tokens, events, token, runId, send };
}

const stream = (
  body: string,
  extra: Partial<Exclude<ReplayStep, Error | ((...a: never[]) => unknown)>> = {},
) => ({
  status: 200,
  headers: STREAM_HEADERS,
  body,
  ...extra,
});

function errorBody(reply: GatewayReply): {
  type: string;
  error: { type: string; message: string };
} {
  assert.ok(reply.body instanceof Uint8Array, 'error replies are buffered');
  return JSON.parse(text(reply.body)) as { type: string; error: { type: string; message: string } };
}

function calls(events: RunEvent[]) {
  return events.filter(
    (e): e is Extract<RunEvent, { type: 'gateway.call' }> => e.type === 'gateway.call',
  );
}

/** Read a reply's body one chunk at a time, keeping the chunking. */
async function chunksOf(body: GatewayReply['body']): Promise<Uint8Array[]> {
  if (body instanceof Uint8Array) return [body];
  const reader = body.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

/* -------------------------------------------------------------------------- */
/* Replay: streaming passthrough                                              */
/* -------------------------------------------------------------------------- */

console.log('replay');

await test('turn-1 stream (thinking, signature, tool_use) is forwarded byte-for-byte', async () => {
  for (const chunks of [[7, 64, 1, 300], [1], [3], [100_000], [13, 2]]) {
    const s = setup([stream(TURN1_STREAM, { chunks })]);
    const reply = await s.send(TURN1_REQUEST);
    assert.equal(reply.status, 200);
    assert.ok(reply.body instanceof ReadableStream, 'a stream stays a stream');
    const parts = await chunksOf(reply.body);
    const all = Buffer.concat(parts.map((p) => Buffer.from(p)));
    assert.ok(
      sameBytes(all, bytes(TURN1_STREAM)),
      'output equals recorded upstream for chunks ' + chunks.join(','),
    );
    // Re-chunked only at event boundaries: no client read ends mid-event.
    for (const part of parts)
      assert.ok(text(part).endsWith('\n\n'), 'chunk ends on an event boundary');
  }
});

await test('event order and every event type survive', async () => {
  const s = setup([stream(TURN1_STREAM)]);
  const out = text(await readAll((await s.send(TURN1_REQUEST)).body));
  const events = parseSse(out);
  // content_block_start/_delta are labelled by their block/delta type.
  const kinds = events.map((e) => {
    const d = e.data as { delta?: { type?: string }; content_block?: { type: string } };
    if (e.event === 'content_block_delta') return d.delta!.type!;
    if (e.event === 'content_block_start') return d.content_block!.type;
    return e.event;
  });
  assert.deepEqual(kinds, [
    'message_start',
    'thinking',
    'ping',
    'thinking_delta',
    'thinking_delta',
    'signature_delta',
    'content_block_stop',
    'text',
    'text_delta',
    'content_block_stop',
    'tool_use',
    'input_json_delta',
    'input_json_delta',
    'input_json_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
});

await test('response headers: upstream ones forwarded, framing ones dropped', async () => {
  const s = setup([
    stream(TURN1_STREAM, {
      headers: { ...STREAM_HEADERS, 'content-length': '999', 'set-cookie': 'x=1' },
    }),
  ]);
  const reply = await s.send(TURN1_REQUEST);
  await readAll(reply.body);
  assert.equal(reply.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(reply.headers.get('request-id'), 'req_01FixtureRequestId');
  assert.equal(reply.headers.get('content-length'), null);
  assert.equal(reply.headers.get('set-cookie'), null);
});

await test('stream accounting: gateway.call with usage, tool uses and price', async () => {
  const s = setup([stream(TURN1_STREAM)]);
  await readAll((await s.send(TURN1_REQUEST)).body);
  const [call] = calls(s.events);
  assert.ok(call, 'one gateway.call');
  assert.equal(call.stream, true);
  assert.equal(call.status, 200);
  assert.equal(call.model, FIXTURE_MODEL);
  assert.deepEqual(call.usage, {
    inputTokens: 12,
    outputTokens: 96, // message_delta's cumulative count replaces message_start's 4
    cacheCreationInputTokens: 4200,
    cacheReadInputTokens: 0,
  });
  assert.equal(call.toolUses, 1);
  assert.ok(call.costCents !== undefined && call.costCents > 0, 'priced model has a cost');
  assert.equal(call.error, undefined);
});

await test('non-streaming body is forwarded byte-for-byte and accounted', async () => {
  const s = setup([{ status: 200, headers: JSON_HEADERS, body: NON_STREAM_RESPONSE }]);
  const reply = await s.send(TURN1_REQUEST.replace('"stream": true', '"stream": false'));
  assert.equal(reply.status, 200);
  assert.ok(sameBytes(await readAll(reply.body), bytes(NON_STREAM_RESPONSE)));
  const [call] = calls(s.events);
  assert.equal(call!.stream, false);
  assert.equal(call!.model, 'claude-haiku-4-5-20251001');
  assert.equal(call!.usage.inputTokens, 310);
  assert.equal(call!.usage.outputTokens, 11);
});

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

console.log('errors');

await test('upstream 400/429/500/529: same status, Anthropic body verbatim', async () => {
  for (const [status, body] of Object.entries(ERROR_BODIES)) {
    const s = setup([
      {
        status: Number(status),
        headers: { ...JSON_HEADERS, 'retry-after': '3', 'x-should-retry': 'true' },
        body,
      },
    ]);
    const reply = await s.send(TURN1_REQUEST);
    assert.equal(reply.status, Number(status));
    assert.ok(sameBytes(await readAll(reply.body), bytes(body)), status + ' body verbatim');
    assert.equal(reply.headers.get('retry-after'), '3', 'retry hints reach the SDK');
    assert.equal(reply.headers.get('x-should-retry'), 'true');
    const [call] = calls(s.events);
    assert.equal(call!.status, Number(status));
    assert.equal(call!.error!.type, (JSON.parse(body) as { error: { type: string } }).error.type);
  }
});

await test('non-Anthropic error body (HTML 502, empty 503) is wrapped in Anthropic shape', async () => {
  const html = setup([
    { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad Gateway</html>' },
  ]);
  const r1 = await html.send(TURN1_REQUEST);
  assert.equal(r1.status, 502);
  assert.equal(r1.headers.get('content-type'), 'application/json');
  const b1 = errorBody(r1);
  assert.equal(b1.type, 'error');
  assert.equal(b1.error.type, 'api_error');
  assert.match(b1.error.message, /Bad Gateway/);

  const empty = setup([{ status: 503, headers: {}, body: '' }]);
  const b2 = errorBody(await empty.send(TURN1_REQUEST));
  assert.equal(b2.error.type, 'api_error');
  assert.ok(b2.error.message.length > 0);

  const overloaded = setup([
    { status: 529, headers: { 'content-type': 'text/plain' }, body: 'overloaded' },
  ]);
  assert.equal(errorBody(await overloaded.send(TURN1_REQUEST)).error.type, 'overloaded_error');
});

await test('upstream unreachable: 502 api_error, accounted as an error', async () => {
  const s = setup([new Error('connect ECONNREFUSED 127.0.0.1:443')]);
  const reply = await s.send(TURN1_REQUEST);
  assert.equal(reply.status, 502);
  const body = errorBody(reply);
  assert.equal(body.error.type, 'api_error');
  assert.match(body.error.message, /ECONNREFUSED/);
  assert.equal(calls(s.events)[0]!.error!.type, 'api_error');
});

await test('mid-stream disconnect: complete events, then one well-formed error event', async () => {
  const full = bytes(TURN1_STREAM);
  // Cut inside the tool_use input JSON, mid-event.
  const cut = TURN1_STREAM.indexOf('src/caf') + 3;
  const s = setup([
    stream(TURN1_STREAM, { failAfterBytes: Buffer.byteLength(TURN1_STREAM.slice(0, cut)) }),
  ]);
  const out = text(await readAll((await s.send(TURN1_REQUEST)).body));
  const lastBoundary = TURN1_STREAM.lastIndexOf('\n\n', cut) + 2;
  assert.ok(
    out.startsWith(TURN1_STREAM.slice(0, lastBoundary)),
    'every complete event forwarded unchanged',
  );
  assert.ok(!out.includes('src/caf"'), 'the partial event is not forwarded');
  const events = parseSse(out); // throws if anything is truncated
  const last = events.at(-1)!;
  assert.equal(last.event, 'error');
  assert.deepEqual(
    (last.data as { type: string; error: { type: string } }).error.type,
    'api_error',
  );
  assert.ok(full.length > 0);
  const [call] = calls(s.events);
  assert.equal(call!.error!.type, 'api_error');
  assert.match(call!.error!.message, /mid-stream/);
});

await test('clean EOF before message_stop (at a boundary and mid-event) ends with an error event', async () => {
  for (const at of [
    TURN1_STREAM.indexOf('event: message_stop'),
    TURN1_STREAM.indexOf('stop_reason') + 4,
  ]) {
    const s = setup([
      stream(TURN1_STREAM, { truncateAtBytes: Buffer.byteLength(TURN1_STREAM.slice(0, at)) }),
    ]);
    const out = text(await readAll((await s.send(TURN1_REQUEST)).body));
    const events = parseSse(out);
    assert.equal(events.at(-1)!.event, 'error');
    assert.ok(!events.some((e) => e.event === 'message_stop'));
    assert.match(calls(s.events)[0]!.error!.message, /before message_stop/);
  }
});

await test('in-stream upstream error event is forwarded as-is, nothing appended', async () => {
  const s = setup([stream(OVERLOADED_MID_STREAM)]);
  const out = await readAll((await s.send(TURN2_REQUEST)).body);
  assert.ok(sameBytes(out, bytes(OVERLOADED_MID_STREAM)));
  assert.equal(calls(s.events)[0]!.error!.type, 'overloaded_error');
});

await test('a final event without its trailing blank line is still forwarded', async () => {
  const body = TURN2_STREAM.slice(0, -2); // message_stop without "\n\n"
  const s = setup([stream(body)]);
  const out = await readAll((await s.send(TURN2_REQUEST)).body);
  assert.ok(sameBytes(out, bytes(body)));
  assert.equal(calls(s.events)[0]!.error, undefined);
});

await test('malformed client bodies: 400 invalid_request_error, upstream never called', async () => {
  const s = setup([]);
  for (const body of [new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), '{"model": ', '[1,2]', '']) {
    const reply = await s.send(body);
    assert.equal(reply.status, 400);
    assert.equal(errorBody(reply).error.type, 'invalid_request_error');
  }
  assert.equal(s.replay.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Cache safety                                                               */
/* -------------------------------------------------------------------------- */

console.log('cache prefix');

await test('two turns: upstream receives the client bytes unmodified, prefix intact', async () => {
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)]);
  await readAll((await s.send(TURN1_REQUEST, { search: '?beta=true' })).body);
  await readAll((await s.send(TURN2_REQUEST, { search: '?beta=true' })).body);
  const [r1, r2] = s.replay.requests;
  assert.ok(sameBytes(r1!.body, bytes(TURN1_REQUEST)), 'turn 1 bytes identical');
  assert.ok(sameBytes(r2!.body, bytes(TURN2_REQUEST)), 'turn 2 bytes identical');
  // The quirks a re-serializer would have normalized are still there.
  for (const quirk of [
    '\\/',
    '\\u00e9',
    '"temperature": 1.0',
    '"cache_control": {"type": "ephemeral"}',
  ])
    assert.ok(r2!.text.includes(quirk), 'kept ' + quirk);
  // Turn 2 extends turn 1: everything before turn 1's closing `]}` is shared.
  assert.ok(r2!.text.startsWith(r1!.text.slice(0, -2)), 'turn 2 prefix is turn 1');
  assert.equal(r1!.search, '?beta=true');
  assert.equal(r1!.path, '/v1/messages');
});

await test('redaction on but nothing to redact: still the client bytes', async () => {
  const s = setup([stream(TURN1_STREAM)], { binding: { redact: true } });
  await readAll((await s.send(TURN1_REQUEST)).body);
  assert.ok(sameBytes(s.replay.requests[0]!.body, bytes(TURN1_REQUEST)));
});

await test('ledger shows cache reads after turn 2', async () => {
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)]);
  await readAll((await s.send(TURN1_REQUEST)).body);
  await readAll((await s.send(TURN2_REQUEST)).body);
  const [c1, c2] = calls(s.events);
  assert.equal(c1!.usage.cacheReadInputTokens, 0);
  assert.equal(c1!.runCacheHitRate, 0);
  assert.equal(c2!.usage.cacheReadInputTokens, 4200);
  assert.ok(c2!.runCacheHitRate > 0);
});

/* -------------------------------------------------------------------------- */
/* Redaction placeholders                                                     */
/* -------------------------------------------------------------------------- */

console.log('redaction');

const PII_TURN1 =
  '{"model": "m", "messages": [{"role": "user", "content": "Mail ada@example.com about bob@example.org"}]}';
const PII_TURN2 =
  '{"model": "m", "messages": [{"role": "user", "content": "Mail ada@example.com about bob@example.org"}, ' +
  '{"role": "assistant", "content": "Done."}, {"role": "user", "content": "Also cc carol@example.net and ada@example.com"}]}';

await test('same secret across turns gets the same placeholder; prefix stays stable', async () => {
  const s = setup([stream(TURN2_STREAM), stream(TURN2_STREAM)], { binding: { redact: true } });
  await readAll((await s.send(PII_TURN1)).body);
  await readAll((await s.send(PII_TURN2)).body);
  const [r1, r2] = s.replay.requests;
  assert.equal(
    r1!.text,
    PII_TURN1.replace('ada@example.com', '[[PII_1]]').replace('bob@example.org', '[[PII_2]]'),
  );
  assert.ok(!r2!.text.includes('@example'), 'no address reaches the upstream');
  assert.ok(
    r2!.text.includes('"Also cc [[PII_3]] and [[PII_1]]"'),
    'new value numbered next, old value reused',
  );
  assert.ok(r2!.text.startsWith(r1!.text.slice(0, -2)), 'redacted prefix identical across turns');
  // Keys and every other byte are left alone.
  assert.ok(r2!.text.startsWith('{"model": "m", "messages": [{"role": "user", "content": '));
});

await test('a different run numbers independently', async () => {
  const a = setup([stream(TURN2_STREAM)], { binding: { redact: true } });
  const b = setup([stream(TURN2_STREAM)], { binding: { redact: true } });
  await readAll((await a.send(PII_TURN2)).body);
  await readAll(
    (await b.send('{"messages": [{"role": "user", "content": "carol@example.net"}]}')).body,
  );
  assert.ok(a.replay.requests[0]!.text.includes('Also cc [[PII_3]]'));
  assert.equal(
    b.replay.requests[0]!.text,
    '{"messages": [{"role": "user", "content": "[[PII_1]]"}]}',
  );
});

await test('two runs sharing one gateway keep separate numbering; redact off forwards PII as-is', async () => {
  const replay = createReplayer([stream(TURN2_STREAM), stream(TURN2_STREAM), stream(TURN2_STREAM)]);
  const tokens = new GatewayRunTokenStore();
  const gateway = new AnthropicMessagesGateway({ upstream: replay.upstream, tokens });
  const tA = tokens.mint({ runId: 'run_a', harness: 'claudecode', budget: {}, redact: true });
  const tB = tokens.mint({ runId: 'run_b', harness: 'claudecode', budget: {}, redact: true });
  const tC = tokens.mint({ runId: 'run_c', harness: 'claudecode', budget: {} });
  const go = async (t: string, body: string) =>
    readAll(
      (
        await gateway.messages({
          path: '/v1/messages',
          body: bytes(body),
          headers: { authorization: 'Bearer ' + t },
        })
      ).body,
    );
  await go(tA, '{"m": ["x@example.com", "y@example.com"]}');
  await go(tB, '{"m": ["y@example.com"]}');
  await go(tC, '{"m": ["y@example.com"]}');
  assert.equal(replay.requests[0]!.text, '{"m": ["[[PII_1]]", "[[PII_2]]"]}');
  assert.equal(replay.requests[1]!.text, '{"m": ["[[PII_1]]"]}');
  assert.equal(replay.requests[2]!.text, '{"m": ["y@example.com"]}');
});

await test('keys are never redacted, only string values', async () => {
  const s = setup([stream(TURN2_STREAM)], { binding: { redact: true } });
  await readAll((await s.send('{"ada@example.com": "ada@example.com"}')).body);
  assert.equal(s.replay.requests[0]!.text, '{"ada@example.com": "[[PII_1]]"}');
});

/* -------------------------------------------------------------------------- */
/* Rewrite hook                                                               */
/* -------------------------------------------------------------------------- */

console.log('rewrite hook');

await test('off outside compaction points: ordinary turn forwarded unmodified', async () => {
  let asked = 0;
  const hook: RewriteHook = {
    isCompactionPoint: () => {
      asked += 1;
      return false;
    },
    rewrite: () => {
      throw new Error('rewrite must not run on an ordinary turn');
    },
  };
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)], { rewrite: hook });
  await readAll((await s.send(TURN1_REQUEST)).body);
  await readAll((await s.send(TURN2_REQUEST)).body);
  assert.equal(asked, 2);
  assert.ok(sameBytes(s.replay.requests[0]!.body, bytes(TURN1_REQUEST)));
  assert.ok(sameBytes(s.replay.requests[1]!.body, bytes(TURN2_REQUEST)));
});

await test('at a compaction point the rewrite is what goes upstream', async () => {
  const hook: RewriteHook = {
    isCompactionPoint: (ctx) => ctx.body.includes('toolu_01FixtureRead'),
    rewrite: () => '{"compacted": true}',
  };
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)], { rewrite: hook });
  await readAll((await s.send(TURN1_REQUEST)).body);
  await readAll((await s.send(TURN2_REQUEST)).body);
  assert.ok(
    sameBytes(s.replay.requests[0]!.body, bytes(TURN1_REQUEST)),
    'turn 1 is not a compaction point',
  );
  assert.equal(s.replay.requests[1]!.text, '{"compacted": true}');
});

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

console.log('ledger');

await test('per call and per run, with cache fields: four counts kept apart, hit rate', async () => {
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)]);
  await readAll((await s.send(TURN1_REQUEST)).body);
  await readAll((await s.send(TURN2_REQUEST)).body);
  const per = s.gateway.ledger.callsFor(s.runId);
  assert.equal(per.length, 2);
  assert.deepEqual(per[1]!.usage, {
    inputTokens: 9,
    outputTokens: 15,
    cacheCreationInputTokens: 180,
    cacheReadInputTokens: 4200,
  });
  const run = s.gateway.ledger.run(s.runId);
  assert.deepEqual(run.usage, {
    inputTokens: 21,
    outputTokens: 111,
    cacheCreationInputTokens: 4380,
    cacheReadInputTokens: 4200,
  });
  assert.equal(run.calls, 2);
  assert.equal(run.unpricedCalls, 0);
  assert.ok(Math.abs(run.cacheHitRate - 4200 / (21 + 4380 + 4200)) < 1e-12);
  assert.ok(Math.abs(run.costCents - per[0]!.costCents! - per[1]!.costCents!) < 1e-12);
  // Cache reads are priced at the model's cache rate, not the input rate.
  const readOnly = new CacheLedger().record({
    callId: 'gwc_x',
    runId: 'r',
    model: FIXTURE_MODEL,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    },
  });
  assert.equal(readOnly.costCents, 20);
  assert.equal(s.gateway.ledger.runTokens(s.runId), 21 + 111 + 4380 + 4200);
});

await test('without cache fields: counted as zero, hit rate 0', async () => {
  const s = setup([stream(NO_CACHE_STREAM)]);
  await readAll((await s.send(TURN1_REQUEST)).body);
  const run = s.gateway.ledger.run(s.runId);
  assert.deepEqual(run.usage, {
    inputTokens: 25,
    outputTokens: 3,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  assert.equal(run.cacheHitRate, 0);
  assert.equal(calls(s.events)[0]!.runCacheHitRate, 0);
});

await test('unknown model: no guessed cost, counted as unpriced', async () => {
  const s = setup([stream(TURN2_STREAM.replaceAll(FIXTURE_MODEL, 'claude-unreleased-9'))]);
  await readAll((await s.send(TURN2_REQUEST)).body);
  const run = s.gateway.ledger.run(s.runId);
  assert.equal(run.unpricedCalls, 1);
  assert.equal(run.costCents, 0);
  assert.equal(calls(s.events)[0]!.costCents, undefined);
});

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

console.log('budget');

await test('token cap: blocked event and a refusal the SDK will not retry', async () => {
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)], {
    binding: { budget: { maxTokens: 1000 } },
  });
  const first = await s.send(TURN1_REQUEST);
  assert.equal(first.status, 200, 'under budget: forwarded');
  await readAll(first.body);
  const second = await s.send(TURN2_REQUEST);
  assert.equal(second.status, 400);
  assert.equal(second.headers.get('x-should-retry'), 'false');
  assert.equal(second.headers.get('x-zephyr-blocked'), 'token_budget');
  const body = errorBody(second);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(
    body.error.message,
    /^Zephyr budget exhausted: run used 4308 of its 1000 token budget/,
  );
  assert.equal(s.replay.requests.length, 1, 'the blocked call never reached the upstream');
  const blocked = s.events.filter((e) => e.type === 'gateway.blocked');
  assert.equal(blocked.length, 1);
  assert.equal(
    (blocked[0] as Extract<RunEvent, { type: 'gateway.blocked' }>).reason,
    'token_budget',
  );
  // And it stays blocked: no silent continue on the next call either.
  assert.equal((await s.send(TURN2_REQUEST)).status, 400);
  assert.equal(s.replay.requests.length, 1);
});

await test('cost cap blocks with cost_budget', async () => {
  const s = setup([stream(TURN1_STREAM)], { binding: { budget: { maxCostCents: 0.5 } } });
  await readAll((await s.send(TURN1_REQUEST)).body);
  const reply = await s.send(TURN2_REQUEST);
  assert.equal(reply.status, 400);
  assert.equal(reply.headers.get('x-zephyr-blocked'), 'cost_budget');
  assert.match(errorBody(reply).error.message, /cent budget/);
});

await test('no caps: never blocked', async () => {
  const s = setup([stream(TURN1_STREAM), stream(TURN2_STREAM)]);
  await readAll((await s.send(TURN1_REQUEST)).body);
  assert.equal((await s.send(TURN2_REQUEST)).status, 200);
});

/* -------------------------------------------------------------------------- */
/* Per-turn tool budget                                                       */
/* -------------------------------------------------------------------------- */

console.log('tool budget');

/** A turn: one user question, then `uses` tool calls each answered by a tool_result. */
function toolTurn(uses: number, extra = ''): string {
  const msgs = ['{"role": "user", "content": [{"type": "text", "text": "Fix the build."}]}'];
  for (let i = 0; i < uses; i += 1) {
    msgs.push(
      `{"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_${i.toString()}", "name": "Bash", "input": {"command": "ls"}}]}`,
      `{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_${i.toString()}", "content": "ok"}]}`,
    );
  }
  return `{"model": "${FIXTURE_MODEL}", "tools": [{"name": "Bash", "input_schema": {"type": "object"}}]${extra}, "messages": [${msgs.join(', ')}]}`;
}

await test('toolUsesThisTurn counts only the current turn', () => {
  const parse = (s: string) => (JSON.parse(s) as { messages: unknown }).messages;
  assert.equal(toolUsesThisTurn(parse(toolTurn(5))), 5);
  // A fresh user text message starts a new turn.
  const next = JSON.parse(toolTurn(5)) as { messages: unknown[] };
  next.messages.push({ role: 'user', content: 'next question' });
  assert.equal(toolUsesThisTurn(next.messages), 0);
  // Two tool_use blocks in one assistant message both count.
  assert.equal(
    toolUsesThisTurn([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use' }, { type: 'text' }, { type: 'tool_use' }],
      },
    ]),
    2,
  );
  assert.equal(toolUsesThisTurn(undefined), 0);
});

await test('under the default 8: forwarded unmodified', async () => {
  const s = setup([stream(TURN2_STREAM)]);
  await readAll((await s.send(toolTurn(7))).body);
  assert.equal(s.replay.requests[0]!.text, toolTurn(7));
});

await test('at 8: tools forbidden and the instruction appended, prefix untouched', async () => {
  const s = setup([stream(TURN2_STREAM)]);
  const original = toolTurn(8);
  await readAll((await s.send(original)).body);
  const sent = s.replay.requests[0]!.text;
  const parsed = JSON.parse(sent) as {
    tool_choice: unknown;
    messages: { content: { type: string; text?: string }[] }[];
  };
  assert.deepEqual(parsed.tool_choice, { type: 'none' });
  const lastBlock = parsed.messages.at(-1)!.content.at(-1)!;
  assert.deepEqual(lastBlock, { type: 'text', text: TOOL_BUDGET_EXHAUSTED_INSTRUCTION });
  // Everything up to the last message's content end is the client's own bytes.
  const insertion = original.lastIndexOf(']}]}');
  assert.ok(sent.startsWith(original.slice(0, insertion)), 'cached prefix preserved');
});

await test('an existing tool_choice is replaced, not duplicated', async () => {
  const s = setup([stream(TURN2_STREAM)]);
  await readAll((await s.send(toolTurn(8, ', "tool_choice": {"type": "auto"}'))).body);
  const sent = s.replay.requests[0]!.text;
  assert.equal(sent.split('"tool_choice"').length - 1, 1);
  assert.deepEqual((JSON.parse(sent) as { tool_choice: unknown }).tool_choice, { type: 'none' });
});

await test('side call (fresh user message) and tool-less calls are not capped; limit is configurable', async () => {
  const side = setup([stream(TURN2_STREAM)]);
  const body = toolTurn(9).replace(/\]\}$/, ', {"role": "user", "content": "Write a title."}]}');
  await readAll((await side.send(body)).body);
  assert.equal(side.replay.requests[0]!.text, body);

  const noTools = setup([stream(TURN2_STREAM)]);
  const bare = toolTurn(9).replace(
    '"tools": [{"name": "Bash", "input_schema": {"type": "object"}}]',
    '"tools": []',
  );
  await readAll((await noTools.send(bare)).body);
  assert.equal(noTools.replay.requests[0]!.text, bare);

  const tight = setup([stream(TURN2_STREAM)], { maxToolCallsPerTurn: 2 });
  await readAll((await tight.send(toolTurn(2))).body);
  assert.ok(tight.replay.requests[0]!.text.includes('"tool_choice":{"type":"none"}'));
});

/* -------------------------------------------------------------------------- */
/* count_tokens                                                               */
/* -------------------------------------------------------------------------- */

console.log('count_tokens');

await test('passthrough: same path, same bytes both ways, no ledger entry', async () => {
  const s = setup([{ status: 200, headers: JSON_HEADERS, body: COUNT_TOKENS_RESPONSE }]);
  const reply = await s.send(COUNT_TOKENS_REQUEST, {
    path: '/v1/messages/count_tokens',
    search: '?beta=true',
  });
  assert.equal(reply.status, 200);
  assert.ok(sameBytes(await readAll(reply.body), bytes(COUNT_TOKENS_RESPONSE)));
  const [req] = s.replay.requests;
  assert.equal(req!.path, '/v1/messages/count_tokens');
  assert.equal(req!.search, '?beta=true');
  assert.ok(sameBytes(req!.body, bytes(COUNT_TOKENS_REQUEST)));
  assert.equal(s.gateway.ledger.callsFor(s.runId).length, 0);
  assert.equal(s.events.length, 0);
});

await test('count_tokens errors keep status and shape; auth still applies', async () => {
  const s = setup([
    { status: 400, headers: JSON_HEADERS, body: ERROR_BODIES[400] },
    { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad</html>' },
  ]);
  const r1 = await s.send(COUNT_TOKENS_REQUEST, { path: '/v1/messages/count_tokens' });
  assert.equal(r1.status, 400);
  assert.ok(sameBytes(await readAll(r1.body), bytes(ERROR_BODIES[400])));
  const r2 = await s.send(COUNT_TOKENS_REQUEST, { path: '/v1/messages/count_tokens' });
  assert.equal(r2.status, 502);
  assert.equal(errorBody(r2).error.type, 'api_error');
  const r3 = await s.send(COUNT_TOKENS_REQUEST, {
    path: '/v1/messages/count_tokens',
    token: 'zgw_nope',
  });
  assert.equal(r3.status, 401);
  assert.equal(s.replay.requests.length, 2);
});

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

console.log('auth');

await test('missing or unknown token: 401 authentication_error, upstream never called', async () => {
  const s = setup([]);
  for (const token of [null, 'zgw_not-a-real-token', 'sk-ant-api03-something']) {
    const reply = await s.send(TURN1_REQUEST, { token });
    assert.equal(reply.status, 401);
    assert.equal(errorBody(reply).error.type, 'authentication_error');
  }
  assert.equal(s.replay.requests.length, 0);
});

await test('x-api-key carries the token too (ANTHROPIC_API_KEY style)', async () => {
  const s = setup([stream(TURN2_STREAM)]);
  const reply = await s.send(TURN2_REQUEST, { token: null, headers: { 'x-api-key': s.token } });
  assert.equal(reply.status, 200);
  await readAll(reply.body);
});

await test('finished run: 403 permission_error, not retried; other runs unaffected', async () => {
  const tokens = new GatewayRunTokenStore();
  const s = setup([stream(TURN2_STREAM)], { tokens });
  const other = tokens.mint({ runId: 'run_other', harness: 'claudecode', budget: {} });
  s.gateway.finishRun(s.runId);
  const reply = await s.send(TURN1_REQUEST);
  assert.equal(reply.status, 403);
  assert.equal(reply.headers.get('x-should-retry'), 'false');
  assert.equal(errorBody(reply).error.type, 'permission_error');
  assert.equal((await s.send(TURN2_REQUEST, { token: other })).status, 200);
});

await test('a single finished task token is 403 while the run mints a new one', async () => {
  const tokens = new GatewayRunTokenStore();
  const s = setup([stream(TURN2_STREAM)], { tokens });
  tokens.finish(s.token);
  assert.equal((await s.send(TURN1_REQUEST)).status, 403);
  const fresh = tokens.mint({ runId: s.runId, harness: 'claudecode', budget: {} });
  assert.equal((await s.send(TURN2_REQUEST, { token: fresh })).status, 200);
});

await test('the run token never reaches the upstream; protocol headers do', async () => {
  const s = setup([stream(TURN2_STREAM)]);
  await readAll(
    (
      await s.send(TURN2_REQUEST, {
        headers: {
          'anthropic-beta': 'interleaved-thinking-2025-05-14',
          'x-api-key': 'zgw_leak',
          'x-zephyr-run': 'run_x',
          cookie: 'a=b',
          'user-agent': 'claude-cli/2.0.0 (external, cli)',
        },
      })
    ).body,
  );
  const h = s.replay.requests[0]!.headers;
  assert.equal(h.get('authorization'), null);
  assert.equal(h.get('x-api-key'), null);
  assert.equal(h.get('x-zephyr-run'), null);
  assert.equal(h.get('cookie'), null);
  assert.equal(h.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
  assert.equal(h.get('anthropic-version'), '2023-06-01');
  assert.equal(h.get('user-agent'), 'claude-cli/2.0.0 (external, cli)');
  assert.equal(s.replay.requests[0]!.runId, s.runId, "billed to the token's run");
});

/* -------------------------------------------------------------------------- */
/* The real upstream                                                          */
/* -------------------------------------------------------------------------- */

console.log('fetchUpstream');

await test('server key injected, base URL /v1 handled, defaults set, search kept', async () => {
  const seen: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: init?.body as Uint8Array,
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const body = bytes('{"a": 1}');
  for (const baseUrl of [
    'https://api.anthropic.com/v1',
    'https://api.anthropic.com/v1/',
    'https://api.anthropic.com',
  ]) {
    const up = fetchUpstream({ baseUrl, apiKey: 'sk-ant-server', fetch: fakeFetch });
    await up({
      runId: 'r',
      path: '/v1/messages',
      search: '?beta=true',
      body,
      headers: new Headers(),
    });
  }
  assert.deepEqual(
    seen.map((s) => s.url),
    Array(3).fill('https://api.anthropic.com/v1/messages?beta=true'),
  );
  assert.equal(seen[0]!.headers.get('x-api-key'), 'sk-ant-server');
  assert.equal(seen[0]!.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(seen[0]!.headers.get('content-type'), 'application/json');
  assert.equal(seen[0]!.body, body, 'the exact buffer is sent');

  const perRun = fetchUpstream({
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: async (runId) => (runId === 'r_user' ? 'sk-ant-user' : undefined),
    fetch: fakeFetch,
  });
  await perRun({
    runId: 'r_user',
    path: '/v1/messages/count_tokens',
    search: '',
    body,
    headers: new Headers({ 'anthropic-version': '2099-01-01' }),
  });
  assert.equal(seen[3]!.headers.get('x-api-key'), 'sk-ant-user');
  assert.equal(seen[3]!.headers.get('anthropic-version'), '2099-01-01', 'client version kept');
  assert.equal(seen[3]!.url, 'https://api.anthropic.com/v1/messages/count_tokens');
  await assert.rejects(
    perRun({ runId: 'r_none', path: '/v1/messages', search: '', body, headers: new Headers() }),
    /not configured/,
  );
});

await test('no key for the run: the gateway answers 502, never an operator fallback', async () => {
  const tokens = new GatewayRunTokenStore();
  const gateway = new AnthropicMessagesGateway({
    upstream: fetchUpstream({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: async () => undefined,
      fetch: (() => {
        throw new Error('fetch must not be called without a key');
      }) as typeof fetch,
    }),
    tokens,
  });
  const token = tokens.mint({ runId: 'r', harness: 'claudecode', budget: {} });
  const reply = await gateway.messages({
    path: '/v1/messages',
    body: bytes('{}'),
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(reply.status, 502);
  assert.match(errorBody(reply).error.message, /not configured/);
});

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

console.log('http');

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: 'http://127.0.0.1:' + port.toString(),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

await test('createApp: /v1/messages body reaches the gateway raw (global JSON parser skipped)', async () => {
  const { base, close } = await listen(createApp());
  try {
    // A zero budget blocks before any upstream call: the refusal proves the body was
    // decoded by the gateway (a consumed body would be "not valid JSON" instead).
    const runId = 'run_gwcheck_http';
    const token = gatewayRunTokens.mint({ runId, harness: 'claudecode', budget: { maxTokens: 0 } });
    const res = await fetch(base + '/v1/messages?beta=true', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: TURN1_REQUEST,
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('x-zephyr-blocked'), 'token_budget');
    assert.match(
      ((await res.json()) as { error: { message: string } }).error.message,
      /budget exhausted/,
    );

    const unauth = await fetch(base + '/v1/messages', { method: 'POST', body: TURN1_REQUEST });
    assert.equal(unauth.status, 401);
    assert.equal(
      ((await unauth.json()) as { error: { type: string } }).error.type,
      'authentication_error',
    );

    gatewayRunTokens.finishRun(runId);
    const finished = await fetch(base + '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': token },
      body: COUNT_TOKENS_REQUEST,
    });
    assert.equal(finished.status, 403);

    const ledger = await fetch(base + '/api/gateway/runs/' + runId + '/ledger');
    assert.equal(ledger.status, 200);
    const json = (await ledger.json()) as {
      run: { runId: string; calls: number };
      calls: unknown[];
    };
    assert.equal(json.run.runId, runId);
    assert.equal(json.run.calls, 0);
    assert.deepEqual(json.calls, []);

    // The OpenAI-compatible surface still gets parsed JSON.
    const chat = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model": "x", "messages": []}',
    });
    assert.notEqual(chat.status, 404, 'chat route still mounted');
  } finally {
    await close();
  }
});

function miniApp(gateway: AnthropicMessagesGateway): express.Express {
  const app = express();
  const json = express.json();
  app.use((req, res, next) => (isAnthropicMessagesPath(req.path) ? next() : json(req, res, next)));
  app.use(
    '/v1',
    createAnthropicMessagesRouter(() => gateway),
  );
  return app;
}

await test('Express: streamed bytes equal the recording; ?beta=true and raw body forwarded', async () => {
  const s = setup([stream(TURN1_STREAM, { chunks: [5, 17] })]);
  const { base, close } = await listen(miniApp(s.gateway));
  try {
    const res = await fetch(base + '/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + s.token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: TURN1_REQUEST,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.equal(res.headers.get('content-encoding'), null);
    const got = new Uint8Array(await res.arrayBuffer());
    assert.ok(sameBytes(got, bytes(TURN1_STREAM)), 'HTTP body equals recorded upstream');
    const [req] = s.replay.requests;
    assert.equal(req!.search, '?beta=true');
    assert.ok(sameBytes(req!.body, bytes(TURN1_REQUEST)), 'raw request body forwarded');
  } finally {
    await close();
  }
});

await test('Express: errors and count_tokens over HTTP; disabled gateway is 404', async () => {
  const s = setup([
    { status: 529, headers: JSON_HEADERS, body: ERROR_BODIES[529] },
    { status: 200, headers: JSON_HEADERS, body: COUNT_TOKENS_RESPONSE },
  ]);
  const { base, close } = await listen(miniApp(s.gateway));
  try {
    const h = { authorization: 'Bearer ' + s.token };
    const err = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: h,
      body: TURN1_REQUEST,
    });
    assert.equal(err.status, 529);
    assert.equal(await err.text(), ERROR_BODIES[529]);
    const count = await fetch(base + '/v1/messages/count_tokens?beta=true', {
      method: 'POST',
      headers: h,
      body: COUNT_TOKENS_REQUEST,
    });
    assert.equal(count.status, 200);
    assert.equal(await count.text(), COUNT_TOKENS_RESPONSE);
  } finally {
    await close();
  }
  const off = express();
  off.use(
    '/v1',
    createAnthropicMessagesRouter(() => undefined),
  );
  const srv = await listen(off);
  try {
    const res = await fetch(srv.base + '/v1/messages', { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { type: string } }).error.type, 'not_found_error');
  } finally {
    await srv.close();
  }
});

await test('Express: client disconnect cancels the upstream and is accounted', async () => {
  let upstreamSignal: AbortSignal | undefined;
  let upstreamCancelled = false;
  const head = TURN1_STREAM.slice(0, TURN1_STREAM.indexOf('event: content_block_start'));
  const hanging: AnthropicUpstream = async (req) => {
    upstreamSignal = req.signal;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes(head));
          return;
        }
        return new Promise<void>(() => undefined); // never finishes on its own
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: STREAM_HEADERS });
  };
  const s = setup([], { upstream: hanging });
  const { base, close } = await listen(miniApp(s.gateway));
  try {
    const abort = new AbortController();
    const res = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + s.token },
      body: TURN1_REQUEST,
      signal: abort.signal,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.ok(text(first.value!).startsWith('event: message_start'));
    abort.abort();
    const deadline = Date.now() + 3000;
    while (calls(s.events).length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    const [call] = calls(s.events);
    assert.ok(call, 'the cancelled call is still accounted');
    assert.equal(call.error!.type, 'client_cancelled');
    assert.equal(call.usage.inputTokens, 12, 'usage seen before the cancel is kept');
    assert.ok(upstreamCancelled || upstreamSignal?.aborted, 'upstream released');
  } finally {
    await close();
  }
});

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${(results.length - failed.length).toString()}/${results.length.toString()} gateway checks passed`,
);
if (failed.length > 0) {
  for (const f of failed) console.log('  failed: ' + f.name);
  process.exit(1);
}
process.exit(0);
