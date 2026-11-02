/**
 * Anthropic Messages surface, for harnesses pointed here with ANTHROPIC_BASE_URL:
 *
 *   POST /v1/messages                 (Claude Code sends `?beta=true`; forwarded)
 *   POST /v1/messages/count_tokens
 *   GET  /api/gateway/runs/:runId/ledger   (mounted separately, dashboard read)
 *
 * The body is taken RAW. app.ts skips its global JSON parser for these paths, and
 * here `express.raw` hands the gateway the client's exact bytes: re-serializing a
 * parsed body would change the prompt-cache prefix. Auth is the gateway's own
 * per-run token (core/modelGateway/runTokens.ts), not the OpenAI surface's session
 * binding, so this router is mounted before that middleware.
 */

import express, { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import type { AnthropicMessagesGateway, GatewayReply, MessagesPath } from '../core/modelGateway/messages.js';
import { anthropicError } from '../core/modelGateway/messages.js';

/** Paths app.ts must leave unparsed. */
export function isAnthropicMessagesPath(path: string): boolean {
  return path === '/v1/messages' || path.startsWith('/v1/messages/');
}

/** Claude Code bodies carry the whole transcript plus images; 2mb is far too small. */
const RAW_LIMIT = '64mb';

export function createAnthropicMessagesRouter(gateway: () => AnthropicMessagesGateway | undefined): Router {
  const router = Router();
  router.use('/messages', express.raw({ type: () => true, limit: RAW_LIMIT }));

  const handle = (path: MessagesPath) => async (req: Request, res: Response) => {
    const messages = gateway();
    if (!messages) {
      res.status(404).json(anthropicError('not_found_error', 'The Anthropic Messages gateway is not enabled.'));
      return;
    }
    const abort = new AbortController();
    // `close` on the RESPONSE: the request stream closes as soon as its body is read.
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new Error('client disconnected'));
    });
    const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0);
    const search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    try {
      const input = { path, search, body, headers: req.headers, signal: abort.signal };
      const reply = path === '/v1/messages' ? await messages.messages(input) : await messages.countTokens(input);
      await send(res, reply);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error as Error);
        return;
      }
      res
        .status(500)
        .json(anthropicError('api_error', 'Zephyr gateway failed: ' + (error as Error).message));
    }
  };

  router.post('/messages', handle('/v1/messages'));
  router.post('/messages/count_tokens', handle('/v1/messages/count_tokens'));
  return router;
}

async function send(res: Response, reply: GatewayReply): Promise<void> {
  res.status(reply.status);
  reply.headers.forEach((value, key) => res.setHeader(key, value));
  if (reply.body instanceof Uint8Array) {
    res.end(Buffer.from(reply.body.buffer, reply.body.byteOffset, reply.body.byteLength));
    return;
  }
  // SSE: no buffering anywhere between the upstream and the client.
  res.setHeader('cache-control', res.getHeader('cache-control') ?? 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  const stream = Readable.fromWeb(reply.body as import('node:stream/web').ReadableStream<Uint8Array>);
  res.on('close', () => stream.destroy());
  await new Promise<void>((resolve) => {
    stream.on('error', () => {
      res.end();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

/** Dashboard read: one run's `/v1/messages` accounting. */
export function createGatewayLedgerRouter(gateway: () => AnthropicMessagesGateway | undefined): Router {
  const router = Router();
  router.get('/gateway/runs/:runId/ledger', (req, res) => {
    const messages = gateway();
    if (!messages) {
      res.status(404).json({ error: 'The Anthropic Messages gateway is not enabled.' });
      return;
    }
    const runId = req.params.runId;
    res.json({ run: messages.ledger.run(runId), calls: messages.ledger.callsFor(runId) });
  });
  return router;
}
