import { Router, type Response } from 'express';
import type { OpenAiChatRequest } from '../core/modelGateway/service.js';
import { modelGateway, sessionStateService } from '../services/runtime.js';
import { createAnthropicMessagesRouter } from './anthropicMessages.routes.js';

export const modelGatewayRouter = Router();

// Anthropic Messages (Claude Code). Mounted BEFORE the session-binding middleware
// below: it authenticates with its own per-run token (401 unknown, 403 finished),
// and it reads the body raw.
modelGatewayRouter.use(createAnthropicMessagesRouter(() => modelGateway.messages));

modelGatewayRouter.get('/models', (_req, res) => {
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: [
      { id: 'agentos-router', object: 'model', created, owned_by: 'agentos' },
      ...modelGateway.listModels().map((route) => ({
        id: route.id,
        object: 'model',
        created,
        owned_by: route.providerId,
      })),
    ],
  });
});

modelGatewayRouter.get('/models/:id', (req, res) => {
  res.json({
    id: req.params.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'agentos',
    context_length: 131_072,
  });
});

// Model metadata is non-sensitive and some local-runtime probes do not attach
// bearer credentials. Completions below remain authenticated.
/**
 * The bearer token, with one specific client quirk absorbed.
 *
 * Hermes resolves its `key_env` value and sends it WRAPPED IN DOUBLE QUOTES:
 * the subprocess reads the env var correctly (verified -- the child sees 13
 * chars, unquoted), and the quotes appear only in the Authorization header it
 * builds. That is Hermes's own behaviour and not something this side can fix,
 * and the symptom is an unexplainable 401 against a key that is demonstrably
 * correct on both ends.
 *
 * So exactly one extra form is accepted: a token wrapped in symmetric double
 * quotes. The comparison is still against the same fixed value, so this widens
 * what is accepted by one string, not by a class of strings.
 */
function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const raw = authorization.slice('Bearer '.length);
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

// No global key or loopback placeholder can select an agent's state.
modelGatewayRouter.use(async (req, res, next) => {
  try {
    res.locals.gatewayBinding = await sessionStateService.resolveGatewayToken(
      bearerToken(req.header('authorization')) ?? undefined,
      'model',
    );
    next();
  } catch {
    res
      .status(401)
      .json({
        error: {
          message: 'Invalid or expired AgentOS gateway binding.',
          type: 'authentication_error',
        },
      });
  }
});

modelGatewayRouter.post('/chat/completions', async (req, res) => {
  try {
    const input = req.body as OpenAiChatRequest;
    const completion = await modelGateway.complete(input, res.locals.gatewayBinding);
    res.setHeader('X-AgentOS-Run-Id', completion.runId);
    res.setHeader('X-AgentOS-Session-Id', completion.sessionStateId);

    if (input.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      writeChunk(res, completion, { role: 'assistant' }, null);
      writeChunk(
        res,
        completion,
        completion.toolCalls.length > 0
          ? { tool_calls: completion.toolCalls.map((toolCall, index) => ({ index, ...toolCall })) }
          : { content: completion.text },
        null,
      );
      writeChunk(res, completion, {}, completion.toolCalls.length > 0 ? 'tool_calls' : 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.json({
      id: completion.id,
      object: 'chat.completion',
      created: completion.created,
      model: completion.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: completion.text || null,
            ...(completion.toolCalls.length > 0 ? { tool_calls: completion.toolCalls } : {}),
          },
          finish_reason: completion.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: completion.tokensIn,
        completion_tokens: completion.tokensOut,
        total_tokens: completion.tokensIn + completion.tokensOut,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const conflict = message.startsWith('No active') || message.startsWith('Multiple active');
    res.status(conflict ? 409 : 502).json({
      error: { message, type: conflict ? 'session_state_error' : 'gateway_error' },
    });
  }
});

function writeChunk(
  res: Response,
  completion: Awaited<ReturnType<typeof modelGateway.complete>>,
  delta: Record<string, unknown>,
  finishReason: string | null,
): void {
  res.write(
    'data: ' +
      JSON.stringify({
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) +
      '\n\n',
  );
}
