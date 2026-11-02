/**
 * A fake api.anthropic.com that replays scripted responses and records every
 * request it receives. The gateway is pointed at it in place of `fetchUpstream`.
 *
 * Streams are re-chunked at ARBITRARY byte offsets (mid-event, mid-UTF-8-sequence),
 * because a real TCP stream does that and the gateway must not care. A response can
 * also break mid-stream: `failAfterBytes` errors the body after that many bytes,
 * `truncateAtBytes` ends it cleanly there.
 */

import type { AnthropicUpstream, AnthropicUpstreamRequest } from '../messages.js';

export interface ReplayResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
  /** Byte chunk sizes, cycled. Default: [7, 64, 1, 300]. */
  chunks?: number[];
  /** Error the body stream after this many bytes (a dropped connection). */
  failAfterBytes?: number;
  /** End the body cleanly after this many bytes (EOF without message_stop). */
  truncateAtBytes?: number;
}

export interface RecordedRequest extends Omit<AnthropicUpstreamRequest, 'signal'> {
  /** The body as text, for assertions. */
  text: string;
}

export type ReplayStep = ReplayResponse | ((req: RecordedRequest) => ReplayResponse) | Error;

export interface Replayer {
  upstream: AnthropicUpstream;
  requests: RecordedRequest[];
  /** Responses not yet served. */
  remaining(): number;
}

const encoder = new TextEncoder();

export function bytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? encoder.encode(body) : body;
}

/** A body stream that delivers `data` in the given chunk sizes. */
export function chunkedStream(
  data: Uint8Array,
  opts: { chunks?: number[]; failAfterBytes?: number; truncateAtBytes?: number } = {},
): ReadableStream<Uint8Array> {
  const sizes = opts.chunks && opts.chunks.length > 0 ? opts.chunks : [7, 64, 1, 300];
  const limit = Math.min(data.length, opts.failAfterBytes ?? opts.truncateAtBytes ?? data.length);
  let offset = 0;
  let turn = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= limit) {
        if (opts.failAfterBytes !== undefined) controller.error(new Error('socket hang up'));
        else controller.close();
        return;
      }
      const size = Math.max(1, sizes[turn % sizes.length]!);
      turn += 1;
      const end = Math.min(limit, offset + size);
      controller.enqueue(data.slice(offset, end));
      offset = end;
    },
  });
}

export function createReplayer(steps: ReplayStep[]): Replayer {
  const queue = [...steps];
  const requests: RecordedRequest[] = [];
  const upstream: AnthropicUpstream = async (req) => {
    const recorded: RecordedRequest = {
      runId: req.runId,
      path: req.path,
      search: req.search,
      body: req.body,
      headers: req.headers,
      text: new TextDecoder().decode(req.body),
    };
    requests.push(recorded);
    const step = queue.shift();
    if (!step) throw new Error('replayer: no scripted response left for ' + req.path);
    if (step instanceof Error) throw step;
    const res = typeof step === 'function' ? step(recorded) : step;
    const data = bytes(res.body);
    return new Response(chunkedStream(data, res), {
      status: res.status ?? 200,
      headers: res.headers ?? { 'content-type': 'application/json' },
    });
  };
  return { upstream, requests, remaining: () => queue.length };
}

/** Drain a gateway reply body to bytes, however it is shaped. */
export async function readAll(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Parse an SSE byte stream into `{event, data}` records, for shape assertions. */
export function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const raw = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      return { event, data: JSON.parse(raw) as unknown };
    });
}
