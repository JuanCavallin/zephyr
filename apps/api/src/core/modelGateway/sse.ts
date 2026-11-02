/**
 * Reads an Anthropic Messages event stream WITHOUT changing it.
 *
 * `push` takes upstream bytes and returns the bytes to forward: every complete
 * event, exactly as received. A trailing partial event is held back until its
 * terminating blank line arrives, so a client never receives half an event. That
 * matters only when the upstream dies mid-event: the gateway can then append a
 * well-formed `error` event instead of handing the SDK a truncated JSON line it
 * would choke on before ever seeing the error. Concatenated, the forwarded bytes
 * equal the upstream bytes; only chunk boundaries move.
 */

import { mergeUsage, parseAnthropicUsage, ZERO_USAGE } from './cacheLedger.js';
import type { GatewayUsage } from '@htn/shared';

export interface StreamSummary {
  model?: string;
  usage: GatewayUsage;
  toolUses: number;
  sawMessageStop: boolean;
  /** An `error` event the upstream itself sent in-stream. */
  upstreamError?: { type: string; message: string };
  events: number;
}

export class SseTap {
  private pending: Uint8Array = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  readonly summary: StreamSummary = { usage: { ...ZERO_USAGE }, toolUses: 0, sawMessageStop: false, events: 0 };

  push(chunk: Uint8Array): Uint8Array {
    const buf = concat(this.pending, chunk);
    const cut = lastBoundary(buf);
    if (cut === 0) {
      this.pending = buf;
      return new Uint8Array(0);
    }
    const complete = buf.subarray(0, cut);
    this.pending = buf.slice(cut);
    this.parse(this.decoder.decode(complete));
    return complete;
  }

  /** Clean EOF: whatever is left is forwarded as-is (and parsed if it is a whole event). */
  flush(): Uint8Array {
    const rest = this.pending;
    this.pending = new Uint8Array(0);
    if (rest.length > 0) this.parse(this.decoder.decode(rest));
    return rest;
  }

  get holdingPartialEvent(): boolean {
    return this.pending.length > 0;
  }

  private parse(text: string): void {
    for (const block of text.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue; // not ours to judge; it was forwarded unchanged
      }
      this.summary.events += 1;
      this.observe(event);
    }
  }

  private observe(event: Record<string, unknown>): void {
    const s = this.summary;
    switch (event.type) {
      case 'message_start': {
        const message = (event.message ?? {}) as Record<string, unknown>;
        if (typeof message.model === 'string') s.model = message.model;
        s.usage = mergeUsage(s.usage, parseAnthropicUsage(message.usage));
        break;
      }
      case 'message_delta':
        s.usage = mergeUsage(s.usage, parseAnthropicUsage(event.usage));
        break;
      case 'content_block_start': {
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        if (block.type === 'tool_use') s.toolUses += 1;
        break;
      }
      case 'message_stop':
        s.sawMessageStop = true;
        break;
      case 'error': {
        const error = (event.error ?? {}) as Record<string, unknown>;
        s.upstreamError = {
          type: typeof error.type === 'string' ? error.type : 'api_error',
          message: typeof error.message === 'string' ? error.message : '',
        };
        break;
      }
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Offset just past the last blank line ("\n\n" or "\r\n\r\n"), or 0. */
function lastBoundary(buf: Uint8Array): number {
  for (let i = buf.length - 1; i >= 1; i -= 1) {
    if (buf[i] !== 0x0a) continue;
    if (buf[i - 1] === 0x0a) return i + 1;
    if (buf[i - 1] === 0x0d && i >= 3 && buf[i - 2] === 0x0a && buf[i - 3] === 0x0d) return i + 1;
  }
  return 0;
}
