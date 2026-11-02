/**
 * Anthropic Messages passthrough: `POST /v1/messages` and `/v1/messages/count_tokens`.
 *
 * Claude Code is pointed here with `ANTHROPIC_BASE_URL` and must not be able to tell
 * it is not talking to Anthropic. So the default is to forward the client's request
 * BYTES and the upstream's response BYTES unchanged; every exception is listed here:
 *
 *   - auth: the run token is swapped for the server's Anthropic key.
 *   - redaction (only when the run asks for it): PII string values become stable
 *     `[[PII_n]]` placeholders, spliced in place (placeholders.ts).
 *   - tool budget (only once a turn has spent it): one text block appended to the last
 *     user message and `tool_choice: none`, both at the END of the body, so the
 *     cached prefix is untouched.
 *   - rewrite hook (only at a compaction point, never by default): L5 lives here.
 *   - a stream the upstream drops mid-way gets one closing `error` event.
 *
 * Prompt caching keys on the exact prefix bytes, so "equivalent JSON" is not good
 * enough anywhere in this file: edits are splices (rawJson.ts), never re-serialization.
 */

import type { GatewayBlockReason, RunEvent } from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import { CacheLedger, mergeUsage, parseAnthropicUsage, ZERO_USAGE } from './cacheLedger.js';
import { PlaceholderSessions } from './placeholders.js';
import { appendItem, appendMember, applySplices, entry, scanJson, type Splice } from './rawJson.js';
import { gatewayRunTokens, presentedCredential, type GatewayRunBinding, type GatewayRunTokenStore } from './runTokens.js';
import { SseTap } from './sse.js';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN, TOOL_BUDGET_EXHAUSTED_INSTRUCTION } from './turnBudget.js';

/* -------------------------------------------------------------------------- */
/* Wire types                                                                 */
/* -------------------------------------------------------------------------- */

export type MessagesPath = '/v1/messages' | '/v1/messages/count_tokens';

export interface AnthropicUpstreamRequest {
  /** The run this call is billed to; lets the upstream pick the run's credential. */
  runId: string;
  path: MessagesPath;
  /** Query string including `?`, or ''. Claude Code calls `/v1/messages?beta=true`. */
  search: string;
  body: Uint8Array;
  headers: Headers;
  signal?: AbortSignal;
}

/** Anything that answers like api.anthropic.com. Tests pass a fake. */
export type AnthropicUpstream = (req: AnthropicUpstreamRequest) => Promise<Response>;

export interface IncomingMessagesRequest {
  path: MessagesPath;
  search?: string;
  body: Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  signal?: AbortSignal;
}

export interface GatewayReply {
  status: number;
  headers: Headers;
  body: Uint8Array | ReadableStream<Uint8Array>;
}

/** The subset of a Messages request the gateway reads. Everything else is opaque. */
interface MessagesRequestShape {
  model?: unknown;
  stream?: unknown;
  tools?: unknown;
  messages?: unknown;
}

export interface RewriteContext {
  binding: GatewayRunBinding;
  /** The request text after redaction and budget edits. */
  body: string;
  request: MessagesRequestShape;
}

/**
 * L5 (compaction) plugs in here. `rewrite` is consulted ONLY when
 * `isCompactionPoint` says so; every ordinary turn is forwarded as received.
 */
export interface RewriteHook {
  isCompactionPoint(ctx: RewriteContext): boolean;
  rewrite(ctx: RewriteContext): string;
}

export interface MessagesGatewayOptions {
  upstream: AnthropicUpstream;
  /** Routing hook: pick the upstream per call. Default: `upstream`. */
  upstreamFor?: (ctx: { binding: GatewayRunBinding; model?: string }) => AnthropicUpstream;
  tokens?: GatewayRunTokenStore;
  ledger?: CacheLedger;
  placeholders?: PlaceholderSessions;
  emit?: (runId: string, event: RunEvent) => unknown;
  maxToolCallsPerTurn?: number;
  rewrite?: RewriteHook;
}

/* -------------------------------------------------------------------------- */
/* Errors in Anthropic's shape                                                */
/* -------------------------------------------------------------------------- */

/** Anthropic's error `type` for each status it documents. */
export function errorTypeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 402:
      return 'billing_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 504:
      return 'timeout_error';
    case 529:
      return 'overloaded_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

export function anthropicError(type: string, message: string) {
  return { type: 'error' as const, error: { type, message } };
}

const encoder = new TextEncoder();

function jsonReply(status: number, body: unknown, extra: Record<string, string> = {}): GatewayReply {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  return { status, headers, body: encoder.encode(JSON.stringify(body)) };
}

function errorReply(status: number, message: string, extra: Record<string, string> = {}): GatewayReply {
  return jsonReply(status, anthropicError(errorTypeForStatus(status), message), extra);
}

function isAnthropicErrorBody(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { type?: unknown; error?: { type?: unknown } };
    return parsed?.type === 'error' && typeof parsed.error?.type === 'string';
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Headers                                                                    */
/* -------------------------------------------------------------------------- */

/** Never forwarded upstream: hop-by-hop, our credential, and what fetch sets itself. */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'te',
  'upgrade',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'authorization',
  'x-api-key',
  'cookie',
  // fetch decompresses transparently; forwarding the client's preference would
  // make the upstream compress a stream we then re-serve uncompressed.
  'accept-encoding',
]);

/** Never forwarded back: hop-by-hop, and framing that no longer describes the body. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'set-cookie',
]);

function upstreamHeaders(incoming: IncomingMessagesRequest['headers']): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || DROP_REQUEST_HEADERS.has(key) || key.startsWith('x-zephyr-')) continue;
    out.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

function clientHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

function header(headers: IncomingMessagesRequest['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/* -------------------------------------------------------------------------- */
/* Turn analysis (tool budget)                                                */
/* -------------------------------------------------------------------------- */

type Block = { type?: unknown };
type Message = { role?: unknown; content?: unknown };

function isFreshUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  if (!Array.isArray(message.content)) return false;
  return (message.content as Block[]).some((block) => block?.type !== 'tool_result');
}

/**
 * Tool calls already made in the CURRENT turn, read from the transcript itself.
 *
 * A turn starts at the last user message that is not purely tool results; every
 * `tool_use` block in an assistant message after it was spent in this turn. Reading
 * it from the request (instead of counting responses in memory) means side calls
 * a harness makes mid-turn (titles, summaries) cannot reset or inflate the count,
 * and a restart loses nothing.
 */
export function toolUsesThisTurn(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  const list = messages as Message[];
  let anchor = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isFreshUserMessage(list[i]!)) {
      anchor = i;
      break;
    }
  }
  let uses = 0;
  for (let i = anchor + 1; i < list.length; i += 1) {
    const message = list[i]!;
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    uses += (message.content as Block[]).filter((block) => block?.type === 'tool_use').length;
  }
  return uses;
}

/**
 * The splices that spend a turn's budget: forbid tools and tell the model why. Both
 * land at the end of the body. Returns [] when there is nothing safe to edit.
 */
function toolBudgetSplices(text: string): Splice[] {
  const root = scanJson(text);
  const messages = entry(root, 'messages')?.value;
  if (messages?.kind !== 'array' || messages.items.length === 0) return [];
  const last = messages.items[messages.items.length - 1]!;
  const content = entry(last, 'content')?.value;
  if (content?.kind !== 'array' || root.kind !== 'object') return [];
  const splices: Splice[] = [
    appendItem(content, JSON.stringify({ type: 'text', text: TOOL_BUDGET_EXHAUSTED_INSTRUCTION })),
  ];
  const toolChoice = entry(root, 'tool_choice');
  const none = '{"type":"none"}';
  splices.push(
    toolChoice
      ? { start: toolChoice.value.start, end: toolChoice.value.end, text: none }
      : appendMember(root, '"tool_choice":' + none),
  );
  return splices;
}

/* -------------------------------------------------------------------------- */
/* The gateway                                                                */
/* -------------------------------------------------------------------------- */

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class AnthropicMessagesGateway {
  readonly ledger: CacheLedger;
  readonly tokens: GatewayRunTokenStore;
  private readonly placeholders: PlaceholderSessions;
  private readonly maxToolCallsPerTurn: number;

  constructor(private readonly options: MessagesGatewayOptions) {
    this.ledger = options.ledger ?? new CacheLedger();
    this.tokens = options.tokens ?? gatewayRunTokens;
    this.placeholders = options.placeholders ?? new PlaceholderSessions();
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  }

  /** 401 for a token we never issued, 403 for a run that has finished. */
  authenticate(headers: IncomingMessagesRequest['headers']):
    | { ok: true; binding: GatewayRunBinding }
    | { ok: false; reply: GatewayReply } {
    const resolved = this.tokens.resolve(
      presentedCredential({ authorization: header(headers, 'authorization'), 'x-api-key': header(headers, 'x-api-key') }),
    );
    if (resolved.status === 'unknown')
      return { ok: false, reply: errorReply(401, 'Invalid or missing Zephyr gateway token.') };
    if (resolved.status === 'finished')
      return {
        ok: false,
        reply: errorReply(403, 'This Zephyr run has finished; its gateway token can no longer be used.', {
          'x-should-retry': 'false',
        }),
      };
    return { ok: true, binding: resolved.binding };
  }

  async messages(req: IncomingMessagesRequest): Promise<GatewayReply> {
    const auth = this.authenticate(req.headers);
    if (!auth.ok) return auth.reply;
    const { binding } = auth;

    const decoded = decodeRequest(req.body);
    if ('error' in decoded) return decoded.error;
    const { request } = decoded;

    const blocked = this.checkBudget(binding);
    if (blocked) return blocked;

    let text = decoded.text;
    let edited = false;
    if (binding.redact) {
      const redacted = this.placeholders.redactJson(binding.redactionScope ?? binding.runId, text);
      if (redacted.count > 0) {
        text = redacted.json;
        edited = true;
      }
    }
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    if (hasTools && toolUsesThisTurn(request.messages) >= this.maxToolCallsPerTurn) {
      const splices = toolBudgetSplices(text);
      if (splices.length > 0) {
        text = applySplices(text, splices);
        edited = true;
      }
    }
    const rewrite = this.options.rewrite;
    if (rewrite) {
      const ctx: RewriteContext = { binding, body: text, request };
      if (rewrite.isCompactionPoint(ctx)) {
        const next = rewrite.rewrite(ctx);
        if (next !== text) {
          text = next;
          edited = true;
        }
      }
    }
    // Unedited: the client's own bytes, not a re-encoding of them.
    const body = edited ? encoder.encode(text) : req.body;

    const model = typeof request.model === 'string' ? request.model : undefined;
    const callId = newId('gwc');
    const upstream = this.options.upstreamFor?.({ binding, model }) ?? this.options.upstream;
    let response: Response;
    try {
      response = await upstream({
        runId: binding.runId,
        path: '/v1/messages',
        search: req.search ?? '',
        body,
        headers: upstreamHeaders(req.headers),
        signal: req.signal,
      });
    } catch (error) {
      const message = 'Zephyr gateway could not reach the model upstream: ' + errorMessage(error);
      this.recordCall(binding, callId, { model, status: 502, stream: false, error: { type: 'api_error', message } });
      return errorReply(502, message);
    }

    if (!response.ok) return this.upstreamError(binding, callId, model, response);

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) {
      return { status: response.status, headers: clientHeaders(response.headers), body: this.tapStream(binding, callId, model, response.status, response.body) };
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const message = 'Model upstream disconnected before the response completed: ' + errorMessage(error);
      this.recordCall(binding, callId, { model, status: 502, stream: false, error: { type: 'api_error', message } });
      return errorReply(502, message);
    }
    let usage = { ...ZERO_USAGE };
    let toolUses = 0;
    let actualModel = model;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
        model?: unknown;
        usage?: unknown;
        content?: Block[];
      };
      usage = mergeUsage(usage, parseAnthropicUsage(parsed.usage));
      if (typeof parsed.model === 'string') actualModel = parsed.model;
      if (Array.isArray(parsed.content)) toolUses = parsed.content.filter((b) => b?.type === 'tool_use').length;
    } catch {
      // Forwarded unchanged; an unparseable 2xx is the upstream's to explain.
    }
    this.recordCall(binding, callId, { model: actualModel, status: response.status, stream: false, usage, toolUses });
    return { status: response.status, headers: clientHeaders(response.headers), body: bytes };
  }

  async countTokens(req: IncomingMessagesRequest): Promise<GatewayReply> {
    const auth = this.authenticate(req.headers);
    if (!auth.ok) return auth.reply;
    const { binding } = auth;
    const decoded = decodeRequest(req.body);
    if ('error' in decoded) return decoded.error;
    // Counted on what the model would actually receive, so redact the same way.
    let body = req.body;
    if (binding.redact) {
      const redacted = this.placeholders.redactJson(binding.redactionScope ?? binding.runId, decoded.text);
      if (redacted.count > 0) body = encoder.encode(redacted.json);
    }
    const model = typeof decoded.request.model === 'string' ? decoded.request.model : undefined;
    const upstream = this.options.upstreamFor?.({ binding, model }) ?? this.options.upstream;
    let response: Response;
    try {
      response = await upstream({
        runId: binding.runId,
        path: '/v1/messages/count_tokens',
        search: req.search ?? '',
        body,
        headers: upstreamHeaders(req.headers),
        signal: req.signal,
      });
    } catch (error) {
      return errorReply(502, 'Zephyr gateway could not reach the model upstream: ' + errorMessage(error));
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return errorReply(502, 'Model upstream disconnected before the response completed: ' + errorMessage(error));
    }
    if (!response.ok && !isAnthropicErrorBody(new TextDecoder().decode(bytes))) {
      return errorReply(response.status, new TextDecoder().decode(bytes).slice(0, 500) || response.statusText);
    }
    return { status: response.status, headers: clientHeaders(response.headers), body: bytes };
  }

  /** Mark a run's tokens finished: later calls get 403. */
  finishRun(runId: string): void {
    this.tokens.finishRun(runId);
    this.placeholders.forget(runId);
  }

  private checkBudget(binding: GatewayRunBinding): GatewayReply | null {
    const { maxTokens, maxCostCents } = binding.budget;
    let reason: GatewayBlockReason | undefined;
    let detail = '';
    if (maxTokens !== undefined) {
      const spent = this.ledger.runTokens(binding.runId);
      if (spent >= maxTokens) {
        reason = 'token_budget';
        detail = `run used ${spent.toString()} of its ${maxTokens.toString()} token budget`;
      }
    }
    if (!reason && maxCostCents !== undefined) {
      const spent = this.ledger.run(binding.runId).costCents;
      if (spent >= maxCostCents) {
        reason = 'cost_budget';
        detail = `run spent ${spent.toFixed(2)} of its ${maxCostCents.toString()} cent budget`;
      }
    }
    if (!reason) return null;
    this.emit(binding.runId, { type: 'gateway.blocked', runId: binding.runId, reason, detail, at: nowIso() });
    // 400 + x-should-retry:false: the Anthropic SDK retries 429/5xx, and a budget
    // refusal that the harness silently retries is a silent continue by another name.
    return errorReply(400, 'Zephyr budget exhausted: ' + detail + '. The run is blocked.', {
      'x-should-retry': 'false',
      'x-zephyr-blocked': reason,
    });
  }

  private async upstreamError(
    binding: GatewayRunBinding,
    callId: string,
    model: string | undefined,
    response: Response,
  ): Promise<GatewayReply> {
    let text = '';
    try {
      text = await response.text();
    } catch {
      // body lost: fall through to the synthesized shape
    }
    const headers = clientHeaders(response.headers);
    let body: Uint8Array;
    let error: { type: string; message: string };
    if (isAnthropicErrorBody(text)) {
      body = encoder.encode(text); // Anthropic's own bytes
      const parsed = JSON.parse(text) as { error: { type: string; message?: string } };
      error = { type: parsed.error.type, message: parsed.error.message ?? '' };
    } else {
      // A proxy or load balancer answered (HTML, empty, plain text). Keep its
      // status, give the client the shape it knows how to read.
      error = { type: errorTypeForStatus(response.status), message: text.slice(0, 500) || response.statusText || 'Upstream error' };
      body = encoder.encode(JSON.stringify(anthropicError(error.type, error.message)));
      headers.set('content-type', 'application/json');
    }
    this.recordCall(binding, callId, { model, status: response.status, stream: false, error });
    return { status: response.status, headers, body };
  }

  private tapStream(
    binding: GatewayRunBinding,
    callId: string,
    model: string | undefined,
    status: number,
    source: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const tap = new SseTap();
    let settled = false;
    const settle = (error?: { type: string; message: string }) => {
      if (settled) return;
      settled = true;
      const s = tap.summary;
      this.recordCall(binding, callId, {
        model: s.model ?? model,
        status,
        stream: true,
        usage: s.usage,
        toolUses: s.toolUses,
        error: error ?? s.upstreamError,
      });
    };
    const closingError = (message: string) =>
      encoder.encode(
        'event: error\ndata: ' + JSON.stringify(anthropicError('api_error', message)) + '\n\n',
      );
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (error) {
          const message = 'Model upstream disconnected mid-stream: ' + errorMessage(error);
          controller.enqueue(closingError(message));
          settle({ type: 'api_error', message });
          controller.close();
          return;
        }
        if (result.done) {
          const rest = tap.flush();
          if (rest.length > 0) controller.enqueue(rest);
          const s = tap.summary;
          if (!s.sawMessageStop && !s.upstreamError) {
            // A clean EOF without message_stop is a truncated message, not a finished one.
            const message = 'Model upstream closed the stream before message_stop.';
            controller.enqueue(closingError(message));
            settle({ type: 'api_error', message });
          } else settle();
          controller.close();
          return;
        }
        const out = tap.push(result.value);
        if (out.length > 0) controller.enqueue(out);
      },
      async cancel(reason) {
        settle({ type: 'client_cancelled', message: 'Client closed the stream.' });
        await reader.cancel(reason).catch(() => undefined);
      },
    });
  }

  private recordCall(
    binding: GatewayRunBinding,
    callId: string,
    call: {
      model?: string;
      status: number;
      stream: boolean;
      usage?: typeof ZERO_USAGE;
      toolUses?: number;
      error?: { type: string; message: string };
    },
  ): void {
    const usage = call.usage ?? { ...ZERO_USAGE };
    const recorded = this.ledger.record({ callId, runId: binding.runId, model: call.model, usage });
    const run = this.ledger.run(binding.runId);
    this.emit(binding.runId, {
      type: 'gateway.call',
      runId: binding.runId,
      callId,
      ...(call.model ? { model: call.model } : {}),
      status: call.status,
      stream: call.stream,
      usage,
      ...(recorded.costCents !== undefined ? { costCents: recorded.costCents } : {}),
      runCacheHitRate: run.cacheHitRate,
      toolUses: call.toolUses ?? 0,
      ...(call.error ? { error: call.error } : {}),
      at: recorded.at,
    });
  }

  private emit(runId: string, event: RunEvent): void {
    if (!this.options.emit) return;
    try {
      void Promise.resolve(this.options.emit(runId, event)).catch((error: unknown) => {
        console.warn('[gateway] event emit failed:', errorMessage(error));
      });
    } catch (error) {
      console.warn('[gateway] event emit failed:', errorMessage(error));
    }
  }
}

function decodeRequest(
  body: Uint8Array,
): { text: string; request: MessagesRequestShape } | { error: GatewayReply } {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return { error: errorReply(400, 'Request body is not valid UTF-8.') };
  }
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return { error: errorReply(400, 'Request body is not valid JSON.') };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return { error: errorReply(400, 'Request body must be a JSON object.') };
  return { text, request: request as MessagesRequestShape };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* The real upstream                                                          */
/* -------------------------------------------------------------------------- */

/**
 * api.anthropic.com (or `baseUrl`), authenticated with the SERVER's key. The run
 * token the harness sent never leaves this process.
 */
export function fetchUpstream(opts: {
  baseUrl: string;
  /** A fixed key, or a per-run lookup (user-supplied credentials). */
  apiKey: string | undefined | ((runId: string) => Promise<string | undefined>);
  fetch?: typeof fetch;
}): AnthropicUpstream {
  // Config carries `https://api.anthropic.com/v1`; the paths here include /v1.
  const base = opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const doFetch = opts.fetch ?? fetch;
  return async (req) => {
    const apiKey = typeof opts.apiKey === 'function' ? await opts.apiKey(req.runId) : opts.apiKey;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured on the Zephyr server.');
    const headers = new Headers(req.headers);
    headers.set('x-api-key', apiKey);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return doFetch(base + req.path + req.search, {
      method: 'POST',
      headers,
      body: req.body,
      signal: req.signal,
    });
  };
}
