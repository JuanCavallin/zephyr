/**
 * Claude Code <-> Anthropic traffic for the gateway's replay suite.
 *
 * Where these come from: the spec asks for traffic RECORDED from a live Claude Code
 * session. This repo's dev environment has no Anthropic key (ANTHROPIC_MODE=mock),
 * so these are HAND-BUILT in Anthropic's documented wire format, modelled on a
 * two-turn Claude Code session: turn 1 thinks, says a line, and calls a tool; turn 2
 * reads the tool result from cache and answers. When a key is available, record a
 * real session through the gateway and replace them; the tests depend only on the
 * exported names. No credential appears anywhere here
 * (scrubbed by construction).
 *
 * Request bodies are written as RAW TEXT on purpose, with the formatting quirks a
 * re-serializer would "fix": spaces after colons, `\/` and `é` escapes, `1.0`.
 * The cache-prefix test asserts the upstream receives these bytes unchanged.
 */

export const FIXTURE_MODEL = 'claude-opus-5-5';

/** One SSE event exactly as Anthropic frames it. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

const SYSTEM =
  '[{"type": "text", "text": "You are Claude Code, Anthropic\'s official CLI for Claude.", "cache_control": {"type": "ephemeral"}}]';

const TOOLS =
  '[{"name": "Read", "description": "Reads a file from the local filesystem.", "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}}, ' +
  '{"name": "Bash", "description": "Runs a shell command.", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}, "cache_control": {"type": "ephemeral"}}]';

const TURN1_USER =
  '{"role": "user", "content": [{"type": "text", "text": "What does src\\/caf\\u00e9.ts export?", "cache_control": {"type": "ephemeral"}}]}';

const TURN1_ASSISTANT =
  '{"role": "assistant", "content": [{"type": "thinking", "thinking": "I should read the file first.", "signature": "EqQBCkYIBxgCKkBfixturesignature"}, ' +
  '{"type": "text", "text": "Let me read it."}, ' +
  '{"type": "tool_use", "id": "toolu_01FixtureRead", "name": "Read", "input": {"file_path": "src/caf\\u00e9.ts"}}]}';

const TURN2_TOOL_RESULT =
  '{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_01FixtureRead", "content": "export const answer = 42;\\n", "cache_control": {"type": "ephemeral"}}]}';

function request(messages: string[]): string {
  return (
    '{"model": "' +
    FIXTURE_MODEL +
    '", "max_tokens": 32000, "temperature": 1.0, "stream": true,\n' +
    ' "system": ' +
    SYSTEM +
    ',\n' +
    ' "tools": ' +
    TOOLS +
    ',\n' +
    ' "metadata": {"user_id": "user_fixture_session"},\n' +
    ' "thinking": {"type": "enabled", "budget_tokens": 8000},\n' +
    ' "messages": [' +
    messages.join(', ') +
    ']}'
  );
}

/** Turn 1: the user's question. */
export const TURN1_REQUEST = request([TURN1_USER]);

/** Turn 2: turn 1's transcript plus the tool result. Its prefix is turn 1's body. */
export const TURN2_REQUEST = request([TURN1_USER, TURN1_ASSISTANT, TURN2_TOOL_RESULT]);

/** The count_tokens body Claude Code sends: the same shape without `stream`/`max_tokens`. */
export const COUNT_TOKENS_REQUEST =
  '{"model": "' +
  FIXTURE_MODEL +
  '", "system": ' +
  SYSTEM +
  ', "tools": ' +
  TOOLS +
  ', "messages": [' +
  TURN1_USER +
  ']}';

export const COUNT_TOKENS_RESPONSE = '{"input_tokens":4412}';

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** Turn 1: thinking (with signature), text, tool_use; writes the cache. */
export const TURN1_STREAM =
  sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01FixtureTurnOne',
      type: 'message',
      role: 'assistant',
      model: FIXTURE_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 4200,
        cache_read_input_tokens: 0,
        output_tokens: 4,
        service_tier: 'standard',
      },
    },
  }) +
  sse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  }) +
  'event: ping\ndata: {"type": "ping"}\n\n' +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'I should read ' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'the file first.' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'EqQBCkYIBxgCKkBfixturesignature' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Let me read it.' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 1 }) +
  sse('content_block_start', {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_01FixtureRead', name: 'Read', input: {} },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"file_path": "src/caf' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: 'é.ts"}' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 2 }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 96 },
  }) +
  sse('message_stop', { type: 'message_stop' });

/** Turn 2: the prefix is read from cache; a short text answer. */
export const TURN2_STREAM =
  sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01FixtureTurnTwo',
      type: 'message',
      role: 'assistant',
      model: FIXTURE_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 9,
        cache_creation_input_tokens: 180,
        cache_read_input_tokens: 4200,
        output_tokens: 2,
        service_tier: 'standard',
      },
    },
  }) +
  sse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'It exports `answer`, ' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'a constant equal to 42.' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 15 },
  }) +
  sse('message_stop', { type: 'message_stop' });

/** A model or request that reports no cache fields at all (older models, no cache_control). */
export const NO_CACHE_STREAM =
  sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01FixtureNoCache',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1 },
    },
  }) +
  sse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 3 },
  }) +
  sse('message_stop', { type: 'message_stop' });

/** Non-streaming body (Claude Code's side calls: titles, topic detection). */
export const NON_STREAM_RESPONSE = JSON.stringify({
  id: 'msg_01FixtureTitle',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'text', text: '{"title": "Read café.ts"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 310,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 11,
  },
});

/** Anthropic's error bodies, verbatim shape. */
export const ERROR_BODIES = {
  400: '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
  429: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
  500: '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
  529: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
} as const;

/** An in-stream error event, as Anthropic sends when it fails after the 200. */
export const OVERLOADED_MID_STREAM =
  TURN2_STREAM.slice(0, TURN2_STREAM.indexOf('event: content_block_delta')) +
  sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });

/** Headers Anthropic sends on a streaming 200 (request id scrubbed to a fixture value). */
export const STREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'request-id': 'req_01FixtureRequestId',
  'anthropic-organization-id': '00000000-0000-0000-0000-000000000000',
};

export const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'request-id': 'req_01FixtureRequestId',
};
