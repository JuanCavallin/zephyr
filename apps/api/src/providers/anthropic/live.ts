/**
 * Anthropic — frontier text model. LIVE ADAPTER, implemented.
 *
 * ============================================================================
 * Needs ANTHROPIC_API_KEY. Nothing else — no cwd, no project id, a plain
 * HTTP API unlike Hermes.
 *
 * Model tier maps onto a real Anthropic model, not just a label:
 *   cheap    -> Haiku 4.5   (claude-haiku-4-5-20251001)
 *   standard -> Sonnet 5    (claude-sonnet-5)
 *   frontier -> Opus 5      (claude-opus-5)
 * `tier` on the call defaults to 'standard' when the caller doesn't specify
 * one (most existing call sites predate the tier field and don't pass it).
 *
 * PRIVACY INVARIANT — DO NOT BREAK THIS:
 *   Text reaching this adapter must ALREADY be redacted. Callers pass
 *   ctx.redactions listing the placeholders present; this adapter must never
 *   be handed raw values and must never attempt to rehydrate them. If you
 *   find yourself importing core/redaction.ts here, something upstream broke.
 * ============================================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelTier, ProviderResult, TextModelAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { costCents } from '../pricing.js';
import { CredentialRequiredError, type CredentialStore } from '../../services/credentials.js';

const MODEL_BY_TIER: Record<ModelTier, string> = {
  local: 'claude-haiku-4-5-20251001',
  cheap: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  frontier: 'claude-opus-5',
};

function meta(
  op: string,
  started: number,
  /**
   * Token/cost accounting. MUST be passed on any call that reports usage:
   * withEgress reads `result.meta`, never `result.data`, so usage returned only
   * in `data` never reaches the egress ledger and every cost number reads zero.
   */
  cost?: {
    tokensIn?: number;
    tokensOut?: number;
    estimatedCostCents?: number;
    model?: string;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
) {
  return {
    provider: 'anthropic' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination: 'https://api.anthropic.com',
    ...cost,
  };
}

function failure<T>(op: string, started: number, err: unknown): ProviderResult<T> {
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  const credentialError = err instanceof CredentialRequiredError;
  const message = status
    ? 'Anthropic returned HTTP ' + status + '.'
    : credentialError
      ? err.message
      : err instanceof Error &&
          (err.message.startsWith('User credentials') ||
            err.message.startsWith('Credential changed'))
        ? err.message
        : 'Anthropic request failed.';
  return {
    ok: false,
    error: {
      code: status === 401 || credentialError ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'UPSTREAM',
      message,
      retryable: !credentialError && status !== 401 && status !== 400,
    },
    meta: meta(op, started),
  };
}

export function createLiveAnthropic(
  cfg: ProviderConfig,
  credentialResolver?: CredentialStore,
  options: { fetch?: typeof globalThis.fetch } = {},
): TextModelAdapter {
  // cfg.baseUrl ends in /v1 for the direct Messages backend (backend.ts), but
  // the SDK appends /v1/messages itself; passing it through hit /v1/v1/messages
  // and every synthesis call 404'd with a bare "Not found".
  const createClient = (apiKey: string) =>
    new Anthropic({
      apiKey,
      baseURL: cfg.baseUrl?.replace(/\/v1\/?$/, ''),
      maxRetries: 0,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

  return {
    id: 'anthropic',
    mode: 'live',
    capabilities: ['text.model'],

    async health() {
      const started = Date.now();
      if (credentialResolver?.source === 'user') {
        return {
          ok: true,
          data: { detail: 'User-funded Anthropic; credentials checked per run.' },
          meta: { ...meta('health', started), destination: 'local://credential-status' },
        };
      }
      if (!cfg.apiKey) {
        return {
          ok: false,
          error: { code: 'AUTH', message: 'ANTHROPIC_API_KEY is not set', retryable: false },
          meta: meta('health', started),
        };
      }
      // A real ping without spending a real completion call: list models.
      try {
        await createClient(cfg.apiKey).models.list({ limit: 1 });
        return { ok: true, data: {}, meta: meta('health', started) };
      } catch (err) {
        return failure('health', started, err);
      }
    },

    async invoke(op) {
      return failure(op, Date.now(), new Error('No generic invoke() op is defined for anthropic.'));
    },

    async complete(input, ctx) {
      const started = Date.now();
      try {
        const credential = credentialResolver
          ? await credentialResolver.require({
              runId: ctx.runId,
              providerId: 'anthropic',
              purpose: 'model',
            })
          : null;
        const apiKey = credential?.secret ?? cfg.apiKey;
        if (!apiKey)
          throw new Error(
            'User credentials are required for anthropic. Configure them in Connections.',
          );
        const client = createClient(apiKey);
        ctx.signal?.throwIfAborted();
        if (credential && credentialResolver)
          credentialResolver.assertCurrent(credential.reference, {
            runId: ctx.runId,
            providerId: 'anthropic',
            purpose: 'model',
          });
        const requestedTier = input.tier ?? 'standard';
        const model =
          (requestedTier === 'local' ? undefined : cfg.models?.[requestedTier]) ??
          MODEL_BY_TIER[requestedTier];
        const message = await client.messages.create(
          {
            model,
            max_tokens: input.maxTokens ?? 1024,
            system: input.system,
            messages: [{ role: 'user', content: input.prompt }],
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          },
          { signal: ctx.signal },
        );
        if (JSON.stringify(message).includes(apiKey))
          throw new Error('Provider response contained credential data.');

        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        // `input_tokens` excludes cached tokens; report the whole prompt.
        const cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0;
        const tokensIn = message.usage.input_tokens + cacheReadTokens + cacheWriteTokens;
        const tokensOut = message.usage.output_tokens;

        return {
          ok: true,
          data: { text, tokensIn, tokensOut },
          // Also on `meta` - that is the half withEgress actually records.
          // Priced by the model that ANSWERED, not the requested tier: a tier
          // re-pointed in config would otherwise report the wrong bill.
          meta: meta('complete', started, {
            tokensIn,
            tokensOut,
            model: message.model,
            cacheReadTokens,
            cacheWriteTokens,
            estimatedCostCents: costCents(message.model, {
              inputTokens: message.usage.input_tokens,
              outputTokens: tokensOut,
              cacheReadTokens,
              cacheWriteTokens,
            }),
          }),
        };
      } catch (err) {
        return failure('complete', started, err);
      }
    },
  };
}
