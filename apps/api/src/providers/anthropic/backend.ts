/**
 * Anthropic — direct Messages API backend for the AgentOS model gateway.
 *
 * The gateway presents an OpenAI-shaped conversation to provider backends.
 * This adapter translates that contract to Anthropic's Messages API and back:
 * system/developer turns become the top-level `system` field, assistant tool
 * calls become `tool_use` blocks, and gateway tool results become
 * `tool_result` blocks. The gateway's exact exposed-tool set is enforced again
 * while parsing the response, so a provider cannot widen its authority by
 * inventing a function name.
 */

import type { ModelRoute, ModelCostTier, ProviderCallContext } from '@htn/shared';
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
import type { CredentialStore } from '../../services/credentials.js';
import { costCents } from '../pricing.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 45_000;

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  system?: string;
  messages: AnthropicMessage[];
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  error?: { message?: string };
}

export function createAnthropicBackend(
  cfg: ProviderConfig,
  recordEgress: RecordEgress,
  fallback: ChatModelBackend,
  credentialResolver?: CredentialStore,
): ChatModelBackend {
  return {
    async complete(input, ctx) {
      if (input.route.providerId !== 'anthropic' || isBoundTextRoute(input.route)) {
        return fallback.complete(input, ctx);
      }
      if (cfg.mode !== 'live') {
        throw new Error('Anthropic route selected while ANTHROPIC_MODE is not live.');
      }
      const credential = credentialResolver
        ? await credentialResolver.require({
            runId: ctx.runId,
            providerId: 'anthropic',
            purpose: 'model',
          })
        : null;
      const effective = credential ? { ...cfg, apiKey: credential.secret } : cfg;
      if (!effective.apiKey) throw new Error('Anthropic credentials are required.');
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
                  providerId: 'anthropic',
                  purpose: 'model',
                })
            : undefined,
        );
      } catch (error) {
        const message =
          error instanceof Error && error.message.startsWith('Anthropic ')
            ? error.message.replaceAll(effective.apiKey, '[credential redacted]')
            : 'Anthropic request failed.';
        throw new Error(message);
      }
    },
  };
}

export function anthropicModelRoutes(cfg: ProviderConfig): ModelRoute[] {
  if (cfg.mode !== 'live' || !cfg.models) return [];

  const candidates: { id: string; modelId: string; costTier: ModelCostTier }[] = [
    { id: 'anthropic-cheap', modelId: cfg.models.cheap, costTier: 'cheap' },
    {
      id: 'anthropic-standard',
      modelId: cfg.models.standard ?? cfg.models.cheap,
      costTier: 'standard',
    },
    { id: 'anthropic-frontier', modelId: cfg.models.frontier, costTier: 'frontier' },
  ];

  return candidates
    .filter(
      (candidate, index) =>
        candidates.findIndex((other) => other.modelId === candidate.modelId) === index,
    )
    .map((candidate) => route(candidate.id, candidate.modelId, candidate.costTier));
}

function route(id: string, modelId: string, costTier: ModelCostTier): ModelRoute {
  return {
    id,
    providerId: 'anthropic',
    modelId,
    costTier,
    deployment: 'cloud',
    contextScope: 'public',
    supportsTools: true,
    allowedDataLabels: ['public'],
    enabled: true,
  };
}

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

function safeArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function appendMessage(
  messages: AnthropicMessage[],
  role: AnthropicMessage['role'],
  content: string | AnthropicContentBlock[],
): void {
  if (typeof content === 'string' && content.length === 0) return;
  const previous = messages[messages.length - 1];
  if (!previous || previous.role !== role) {
    messages.push({ role, content });
    return;
  }

  const previousBlocks =
    typeof previous.content === 'string'
      ? previous.content.length > 0
        ? [{ type: 'text' as const, text: previous.content }]
        : []
      : previous.content;
  const nextBlocks =
    typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  previous.content = [...previousBlocks, ...nextBlocks];
}

/** Translate the gateway's conversation into Anthropic Messages API shape. */
export function toAnthropicRequest(messages: OpenAiMessage[]): AnthropicRequest {
  const system: string[] = [];
  const translated: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id;
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        appendMessage(translated, 'user', textOf(message.content));
      } else {
        appendMessage(translated, 'user', [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: textOf(message.content),
          },
        ]);
      }
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: 'text', text });

      if (Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls) {
          if (!raw || typeof raw !== 'object') continue;
          const call = raw as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          if (typeof call.function?.name !== 'string') continue;
          blocks.push({
            type: 'tool_use',
            id: typeof call.id === 'string' && call.id.length > 0 ? call.id : newId('call'),
            name: call.function.name,
            input: safeArgs(call.function.arguments),
          });
        }
      }
      if (blocks.length > 0) appendMessage(translated, 'assistant', blocks);
      continue;
    }

    appendMessage(translated, 'user', textOf(message.content));
  }

  return {
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages: translated,
  };
}

export function toAnthropicTools(tools: OpenAiTool[]): unknown[] {
  return tools.flatMap((tool) => {
    const fn = tool.function;
    if (!fn || typeof fn.name !== 'string') return [];
    return [
      {
        name: fn.name,
        description: fn.description ?? '',
        input_schema: fn.parameters ?? { type: 'object', properties: {} },
      },
    ];
  });
}

/** Convert response tool_use blocks and refuse any tool outside this turn's grant. */
export function parseToolCalls(
  blocks: AnthropicContentBlock[],
  input: ChatModelBackendInput,
): GatewayToolCall[] {
  const allowed = new Set(
    input.tools.flatMap((tool) =>
      typeof tool.function?.name === 'string' ? [tool.function.name] : [],
    ),
  );

  const calls = blocks.flatMap((block, index) => {
    if (block.type !== 'tool_use') return [];
    if (!allowed.has(block.name)) {
      throw new Error('Anthropic requested a tool that AgentOS did not expose.');
    }
    if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
      throw new Error('Anthropic returned invalid tool arguments.');
    }
    return [
      {
        id: block.id || 'anthropic_call_' + index,
        type: 'function' as const,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      },
    ];
  });

  if (calls.length > 1) {
    console.warn(
      '[anthropic] model returned ' +
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
  const endpoint = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '') + '/messages';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let model: string | undefined;
  let estimatedCostCents: number | undefined;

  try {
    const translated = toAnthropicRequest(input.messages);
    const tools = toAnthropicTools(input.tools);
    const payload = {
      model: input.route.modelId,
      max_tokens: input.maxTokens ?? 1024,
      // An agent turn resends the same system prompt, tool schemas and growing
      // transcript every time. Automatic caching bills the repeated prefix at
      // ~0.1x input on the next turn. Prefixes under the model's minimum are
      // simply not cached, so this is safe on short calls too.
      cache_control: { type: 'ephemeral' },
      ...translated,
      ...(tools.length > 0
        ? {
            tools,
            // Ask for one call at a time rather than discarding extras in
            // parseToolCalls: a model that planned three parallel searches and
            // saw one run re-planned the other two on every following call.
            tool_choice:
              input.toolChoice === 'none'
                ? { type: 'none' }
                : { type: 'auto', disable_parallel_tool_use: true },
          }
        : {}),
    };
    const response = await fetchWithOneRetry(
      endpoint,
      cfg.apiKey ?? '',
      payload,
      ctx.signal,
      beforeRequest,
    );
    if (!response.ok) {
      throw new Error('Anthropic returned HTTP ' + response.status + '.');
    }

    const body = (await response.json()) as AnthropicResponse;
    if (cfg.apiKey && JSON.stringify(body).includes(cfg.apiKey))
      throw new Error('Anthropic response contained credential data and was refused.');
    const blocks = body.content;
    if (!Array.isArray(blocks)) {
      throw new Error('Anthropic returned no content.');
    }
    // `input_tokens` EXCLUDES cached tokens; tokensIn reports the whole prompt
    // so token counts stay comparable with and without caching.
    const uncached = finite(body.usage?.input_tokens) ?? 0;
    cacheReadTokens = finite(body.usage?.cache_read_input_tokens) ?? 0;
    cacheWriteTokens = finite(body.usage?.cache_creation_input_tokens) ?? 0;
    tokensIn = uncached + cacheReadTokens + cacheWriteTokens;
    tokensOut = finite(body.usage?.output_tokens) ?? 0;
    model = body.model ?? input.route.modelId;
    estimatedCostCents = costCents(model, {
      inputTokens: uncached,
      outputTokens: tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
    });

    return {
      text: blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      toolCalls: parseToolCalls(blocks, input),
      tokensIn,
      tokensOut,
      actualModel: model,
      estimatedCostCents,
    };
  } finally {
    await recordEgress({
      id: newId('egr'),
      runId: ctx.runId,
      stepId: ctx.stepId,
      providerId: 'anthropic',
      op: 'messages.create',
      destination: endpoint,
      dataSpans: ctx.redactions ?? [],
      policyRule: ctx.policyRule,
      latencyMs: Date.now() - started,
      tokensIn,
      tokensOut,
      estimatedCostCents,
      model: model ?? input.route.modelId,
      cacheReadTokens,
      cacheWriteTokens,
    }).catch((error: unknown) => {
      console.error(
        '[egress] failed to record Anthropic call:',
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
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
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
  throw new Error('Anthropic retry loop exhausted.');
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
