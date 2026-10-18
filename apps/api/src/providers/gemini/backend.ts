/**
 * Gemini — direct Google backend for the AgentOS model gateway.
 *
 * ============================================================================
 * This is a direct Google route. A route is a privacy and cost claim, not just
 * a model name, so the egress ledger records Google as the actual destination.
 * ---------------------------------------------------------------------------
 * THE WIRE TRANSLATION, AND WHY IT IS NOT A PASS-THROUGH.
 *
 * Hermes speaks OpenAI chat-completions TO US. Gemini does not speak it. So
 * this file converts in both directions, and three of those conversions are
 * easy to get quietly wrong:
 *
 *   1. SYSTEM MESSAGES. Gemini has no 'system' role. They belong in the
 *      top-level `systemInstruction`, not prepended to the first user turn —
 *      prepending changes what the model treats as instruction vs. content.
 *   2. TOOL RESULTS. OpenAI sends role:'tool' keyed by tool_call_id. Gemini
 *      wants a `functionResponse` part keyed by function NAME, and the name has
 *      to be recovered from the assistant turn that requested it.
 *   3. JSON SCHEMA. Gemini's function declarations reject several standard
 *      JSON Schema keywords that our tool schemas legitimately carry
 *      (`additionalProperties`, `$schema`, `default`). They are stripped rather
 *      than passed through, because a 400 here reads like a model failure.
 *
 * SECURITY: a returned function call whose
 * name AgentOS did not expose this turn is rejected, not executed. The gateway
 * filters which tools the model may see; this enforces that it cannot invent
 * one anyway.
 *
 * ONE TOOL CALL PER TURN. Gemini has no equivalent request flag, so the constraint is applied
 * to the RESPONSE instead: extras are dropped and warned about rather than fed
 * into a path that has never seen them. Silently passing two through would make
 * ---------------------------------------------------------------------------
 * VERIFIED: endpoint shape, auth header and model ids confirmed against
 * Google's published API docs and Sept-2026 release notes. NOT exercised
 * against a live key here — model ids are env-overridable
 * (GEMINI_CHEAP_MODEL / GEMINI_FRONTIER_MODEL) precisely so a renamed model is
 * a config change, and `health()` lists models so a wrong id is visible on the
 * providers page rather than at demo time.
 * ============================================================================
 */

import type { ModelRoute, ProviderCallContext } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import type {
  ChatModelBackend,
  ChatModelBackendInput,
  ChatModelBackendResult,
  GatewayToolCall,
  OpenAiMessage,
  OpenAiTool,
} from '../../core/modelGateway/service.js';
import { isBoundTextRoute } from '../../core/modelGateway/catalog.js';
import { newId } from '../../lib/ids.js';
import type { RecordEgress } from '../withEgress.js';
import { costCents } from '../pricing.js';
import type { CredentialStore } from '../../services/credentials.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 45_000;

/** JSON Schema keywords Gemini's functionDeclarations parser rejects outright. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  'additionalProperties',
  'default',
  'examples',
  'const',
  'definitions',
  '$defs',
  '$ref',
]);

export interface GeminiPart {
  text?: string;
  functionCall?: { name?: unknown; args?: unknown };
  thoughtSignature?: unknown;
}

/**
 * Gemini 3 signs every function call it makes, and a later request that
 * replays the call without its `thoughtSignature` is refused with HTTP 400
 * ("Function call is missing a thought_signature"). Hermes speaks OpenAI
 * chat-completions, which has nowhere to carry the signature, so it is kept
 * here by the call id this backend hands out, and put back on replay. Bounded:
 * one entry per call, oldest dropped first.
 */
const thoughtSignatures = new Map<string, string>();
const MAX_THOUGHT_SIGNATURES = 2000;

/**
 * Google's documented stand-in for a call Gemini did not make -- Jev may have
 * routed the turn that made it to Anthropic -- or whose signature was lost to
 * a restart. Verified live: both the real signature and this value are
 * accepted; no signature at all is HTTP 400.
 */
const UNSIGNED_CALL_SIGNATURE = 'skip_thought_signature_validator';

/** Remember the signature of each call Gemini returned, by the id handed out for it. */
export function rememberThoughtSignatures(parts: GeminiPart[], calls: GatewayToolCall[]): void {
  const signed = parts.filter((part) => part.functionCall);
  calls.forEach((call, index) => {
    const signature = signed[index]?.thoughtSignature;
    if (typeof signature !== 'string' || !signature) return;
    thoughtSignatures.set(call.id, signature);
    if (thoughtSignatures.size > MAX_THOUGHT_SIGNATURES) {
      const oldest = thoughtSignatures.keys().next().value;
      if (oldest !== undefined) thoughtSignatures.delete(oldest);
    }
  });
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
  error?: { message?: string };
}

export function createGeminiBackend(
  cfg: ProviderConfig,
  recordEgress: RecordEgress,
  fallback: ChatModelBackend,
  credentialResolver?: CredentialStore,
): ChatModelBackend {
  return {
    async complete(input, ctx) {
      if (input.route.providerId !== 'gemini' || isBoundTextRoute(input.route)) {
        return fallback.complete(input, ctx);
      }
      if (cfg.mode !== 'live') {
        throw new Error('Gemini route selected while GEMINI_MODE is not live.');
      }
      const credential = credentialResolver
        ? await credentialResolver.require({
            runId: ctx.runId,
            providerId: 'gemini',
            purpose: 'model',
          })
        : null;
      const effective = credential ? { ...cfg, apiKey: credential.secret } : cfg;
      if (!effective.apiKey) throw new Error('Gemini credentials are required.');
      try {
        return await completeLive(
          effective,
          input,
          ctx,
          recordEgress,
          credential && credentialResolver
            ? () =>
                credentialResolver.assertCurrent(credential.reference, {
                  runId: ctx.runId,
                  providerId: 'gemini',
                  purpose: 'model',
                })
            : undefined,
        );
      } catch (error) {
        const message =
          error instanceof Error && error.message.startsWith('Gemini ')
            ? error.message.replaceAll(effective.apiKey, '[credential redacted]')
            : 'Gemini request failed.';
        throw new Error(message);
      }
    },
  };
}

export function geminiModelRoutes(cfg: ProviderConfig): ModelRoute[] {
  if (cfg.mode !== 'live' || !cfg.models) return [];
  const routes = [
    route('gemini-cheap', cfg.models.cheap, 'cheap'),
    route('gemini-frontier', cfg.models.frontier, 'frontier'),
  ];
  // Both tiers pointed at one model is a valid config; do not offer it twice.
  return routes.filter(
    (candidate, index) =>
      routes.findIndex((other) => other.modelId === candidate.modelId) === index,
  );
}

function route(id: string, modelId: string, costTier: 'cheap' | 'frontier'): ModelRoute {
  return {
    id,
    providerId: 'gemini',
    modelId,
    costTier,
    deployment: 'cloud',
    contextScope: 'public',
    supportsTools: true,
    // Cloud egress to a third party. Until a retention agreement is represented
    // in the route, only explicitly public state may take this path — same
    // Cloud routes are public-only until a retention policy is represented.
    allowedDataLabels: ['public'],
    enabled: true,
  };
}

// --- request translation -----------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('');
}

/**
 * Recover tool_call_id -> function name from assistant turns, so a later
 * role:'tool' message can be addressed by name the way Gemini requires.
 */
function toolNamesById(messages: OpenAiMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      const { id, function: fn } = call as { id?: unknown; function?: { name?: unknown } };
      if (typeof id === 'string' && typeof fn?.name === 'string') names.set(id, fn.name);
    }
  }
  return names;
}

interface TranslatedRequest {
  contents: { role: 'user' | 'model'; parts: unknown[] }[];
  systemInstruction?: { parts: { text: string }[] };
}

export function toGeminiRequest(messages: OpenAiMessage[]): TranslatedRequest {
  const names = toolNamesById(messages);
  const systemChunks: string[] = [];
  const contents: TranslatedRequest['contents'] = [];

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (text) systemChunks.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const name = names.get(message.tool_call_id ?? '') ?? message.name ?? 'tool';
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name,
              // Gemini requires an object here; a bare string is rejected.
              response: { result: textOf(message.content) },
            },
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const parts: unknown[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });

      const calls = (message as { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!call || typeof call !== 'object') continue;
          const { id, function: fn } = call as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          if (typeof fn?.name !== 'string') continue;
          parts.push({
            functionCall: { name: fn.name, args: safeArgs(fn.arguments) },
            thoughtSignature:
              (typeof id === 'string' ? thoughtSignatures.get(id) : undefined) ??
              UNSIGNED_CALL_SIGNATURE,
          });
        }
      }
      // A turn with no parts at all is rejected by the API; drop it instead.
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const text = textOf(message.content);
    if (text) contents.push({ role: 'user', parts: [{ text }] });
  }

  // Fold consecutive same-role turns into one, the shape Gemini documents: a
  // function response followed by a user note (the gateway's tool-budget
  // instruction, Hermes's empty-reply nudge) is one user turn, as are several
  // function responses.
  const merged: TranslatedRequest['contents'] = [];
  for (const content of contents) {
    const previous = merged.at(-1);
    if (previous?.role === content.role) previous.parts.push(...content.parts);
    else merged.push({ role: content.role, parts: [...content.parts] });
  }

  return {
    contents: merged,
    ...(systemChunks.length > 0
      ? { systemInstruction: { parts: [{ text: systemChunks.join('\n\n') }] } }
      : {}),
  };
}

function safeArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Recursively drop keywords Gemini rejects. Structure is otherwise preserved. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    output[key] = sanitizeSchema(value);
  }
  return output;
}

export function toGeminiTools(tools: OpenAiTool[]): unknown[] {
  const declarations = tools.flatMap((tool) => {
    const fn = tool.function;
    if (!fn || typeof fn.name !== 'string') return [];
    return [
      {
        name: fn.name,
        description: fn.description ?? '',
        parameters: sanitizeSchema(fn.parameters ?? { type: 'object', properties: {} }),
      },
    ];
  });
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

// --- response translation ----------------------------------------------------

/**
 * Convert Gemini function calls into the gateway's OpenAI-shaped tool calls.
 *
 * Throws on a name AgentOS did not expose this turn. That is the same rule the
 * model backends enforce and it is not optional: tool exposure is the
 * boundary, so a model naming something outside it is a failure, not a request.
 */
export function parseToolCalls(
  parts: GeminiPart[],
  input: ChatModelBackendInput,
): GatewayToolCall[] {
  const allowed = new Set(
    input.tools.flatMap((tool) =>
      typeof tool.function?.name === 'string' ? [tool.function.name] : [],
    ),
  );

  const calls = parts.flatMap((part, index) => {
    const call = part.functionCall;
    if (!call) return [];
    if (typeof call.name !== 'string' || !allowed.has(call.name)) {
      throw new Error('Gemini requested a tool that AgentOS did not expose.');
    }
    return [
      {
        // Gemini returns no call id. A unique one, not the index, because the
        // call's thought signature is remembered by it across requests.
        id: newId('call') + '_' + index.toString(),
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      },
    ];
  });

  // Validation above runs over EVERY call first, so an unexposed tool is still
  // refused even when it is one we would go on to drop.
  if (calls.length > 1) {
    console.warn(
      '[gemini] model returned ' +
        calls.length.toString() +
        ' tool calls; keeping the first to match the one-call-per-turn contract.',
    );
    return calls.slice(0, 1);
  }
  return calls;
}

async function completeLive(
  cfg: ProviderConfig,
  input: ChatModelBackendInput,
  ctx: ProviderCallContext,
  recordEgress: RecordEgress,
  beforeRequest?: () => void,
): Promise<ChatModelBackendResult> {
  const started = Date.now();
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const endpoint = baseUrl + '/models/' + input.route.modelId + ':generateContent';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let model: string | undefined;
  let estimatedCostCents: number | undefined;

  try {
    const translated = toGeminiRequest(input.messages);
    const tools = toGeminiTools(input.tools);
    const payload = {
      ...translated,
      ...(tools.length > 0 ? { tools } : {}),
      ...(tools.length > 0 && input.toolChoice === 'none'
        ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } }
        : {}),
      ...(input.maxTokens ? { generationConfig: { maxOutputTokens: input.maxTokens } } : {}),
    };

    const response = await fetchWithOneRetry(
      endpoint,
      cfg.apiKey ?? '',
      payload,
      ctx.signal,
      beforeRequest,
    );
    if (!response.ok) {
      // Gemini's own reason ("Function call is missing a thought_signature...")
      // is what makes a 400 fixable; the caller redacts the key from it.
      const reason = await response
        .json()
        .then((failed) => (failed as GeminiResponse).error?.message?.slice(0, 200))
        .catch(() => undefined);
      throw new Error(
        'Gemini returned HTTP ' + response.status.toString() + (reason ? ': ' + reason : '.'),
      );
    }

    const body = (await response.json()) as GeminiResponse;
    if (cfg.apiKey && JSON.stringify(body).includes(cfg.apiKey))
      throw new Error('Gemini response contained credential data and was refused.');
    const parts = body.candidates?.[0]?.content?.parts;
    if (!parts) {
      // A blocked or empty candidate is a real outcome, not a parse bug — say which.
      throw new Error('Gemini returned no content.');
    }

    tokensIn = finite(body.usageMetadata?.promptTokenCount) ?? 0;
    tokensOut = finite(body.usageMetadata?.candidatesTokenCount) ?? 0;
    model = body.modelVersion ?? input.route.modelId;
    // No built-in Gemini rate: this stays undefined (counted as UNPRICED, not
    // free) unless MODEL_PRICES_JSON supplies one. See providers/pricing.ts.
    estimatedCostCents = costCents(model, { inputTokens: tokensIn, outputTokens: tokensOut });

    const toolCalls = parseToolCalls(parts, input);
    rememberThoughtSignatures(parts, toolCalls);
    return {
      text: parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])).join(''),
      toolCalls,
      tokensIn,
      tokensOut,
      actualModel: model,
      estimatedCostCents,
    };
  } finally {
    // Recorded in `finally` so a thrown request still leaves a ledger row: a
    // failed call still opened a connection to Google.
    await recordEgress({
      id: newId('egr'),
      runId: ctx.runId,
      stepId: ctx.stepId,
      providerId: 'gemini',
      op: 'generateContent',
      destination: endpoint,
      dataSpans: ctx.redactions ?? [],
      policyRule: ctx.policyRule,
      latencyMs: Date.now() - started,
      tokensIn,
      tokensOut,
      estimatedCostCents,
      model: model ?? input.route.modelId,
    }).catch((error: unknown) => {
      console.error(
        '[egress] failed to record Gemini call:',
        error instanceof Error ? error.message : 'unknown error',
      );
    });
  }
}

async function fetchWithOneRetry(
  endpoint: string,
  apiKey: string,
  payload: unknown,
  signal?: AbortSignal,
  beforeRequest?: () => void,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    beforeRequest?.();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    return response;
  }
  throw new Error('Gemini retry loop exhausted.');
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
