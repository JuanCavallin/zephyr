import type { ModelRoute, ProviderCallContext } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import type {
  ChatModelBackend,
  ChatModelBackendInput,
  ChatModelBackendResult,
  GatewayToolCall,
  OpenAiMessage,
} from '../../core/modelGateway/service.js';
import { isBoundTextRoute } from '../../core/modelGateway/catalog.js';
import { newId } from '../../lib/ids.js';
import type { RecordEgress } from '../withEgress.js';

interface OllamaResponse {
  model?: string;
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

export function createOllamaBackend(
  cfg: ProviderConfig,
  recordEgress: RecordEgress,
  fallback: ChatModelBackend,
): ChatModelBackend {
  return {
    async complete(input, ctx) {
      if (input.route.providerId !== 'ollama' || isBoundTextRoute(input.route)) {
        return fallback.complete(input, ctx);
      }
      if (cfg.mode !== 'live')
        throw new Error('Ollama route selected while OLLAMA_MODE is not live.');
      return completeLocal(cfg, input, ctx, recordEgress);
    },
  };
}

export function ollamaModelRoutes(cfg: ProviderConfig): ModelRoute[] {
  if (cfg.mode !== 'live' || !cfg.models?.cheap) return [];
  return [
    {
      id: 'ollama-local',
      providerId: 'ollama',
      modelId: cfg.models.cheap,
      costTier: 'cheap',
      deployment: 'local',
      contextScope: 'local_only',
      supportsTools: true,
      allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
      enabled: true,
      noTraining: true,
      zeroDataRetention: true,
    },
  ];
}

async function completeLocal(
  cfg: ProviderConfig,
  input: ChatModelBackendInput,
  ctx: ProviderCallContext,
  recordEgress: RecordEgress,
): Promise<ChatModelBackendResult> {
  const started = Date.now();
  const endpoint = localOllamaEndpoint(cfg.baseUrl) + '/api/chat';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.route.modelId,
        messages: toOllamaMessages(input.messages),
        // Ollama's /api/chat has no tool_choice; 'none' drops the tools.
        ...(input.tools.length > 0 && input.toolChoice !== 'none' ? { tools: input.tools } : {}),
        ...(input.maxTokens ? { options: { num_predict: input.maxTokens } } : {}),
        stream: false,
        // AgentOS needs the answer/tool call, not an unobserved local reasoning trace.
        think: false,
      }),
      signal: ctx.signal ?? AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error('Ollama returned HTTP ' + response.status + '.');
    const body = (await response.json()) as OllamaResponse;
    if (!body.message) throw new Error('Ollama returned no assistant message.');
    tokensIn = finite(body.prompt_eval_count) ?? 0;
    tokensOut = finite(body.eval_count) ?? 0;
    return {
      text: typeof body.message.content === 'string' ? body.message.content : '',
      toolCalls: parseToolCalls(body.message.tool_calls, input),
      tokensIn,
      tokensOut,
      actualModel: body.model,
      estimatedCostCents: 0,
    };
  } finally {
    await recordEgress({
      id: newId('egr'),
      runId: ctx.runId,
      stepId: ctx.stepId,
      providerId: 'ollama',
      op: 'api.chat',
      destination: endpoint,
      dataSpans: ctx.redactions ?? [],
      policyRule: ctx.policyRule,
      latencyMs: Date.now() - started,
      tokensIn,
      tokensOut,
      estimatedCostCents: 0,
      model: input.route.modelId,
    }).catch((error: unknown) => {
      console.error(
        '[egress] failed to record Ollama call:',
        error instanceof Error ? error.message : 'unknown error',
      );
    });
  }
}

/** A route advertised as local may never send private context to a remote URL. */
export function localOllamaEndpoint(baseUrl = 'http://127.0.0.1:11434'): string {
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Ollama local routes require an approved loopback endpoint.');
  }
  return url.toString().replace(/\/$/, '');
}

function toOllamaMessages(messages: OpenAiMessage[]): Record<string, unknown>[] {
  const callNames = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) continue;
    for (const raw of message.tool_calls) {
      if (!raw || typeof raw !== 'object') continue;
      const call = raw as { id?: unknown; function?: { name?: unknown } };
      if (typeof call.id === 'string' && typeof call.function?.name === 'string') {
        callNames.set(call.id, call.function.name);
      }
    }
  }
  return messages.map((message) => {
    const converted: Record<string, unknown> = {
      role: message.role,
      content: contentText(message.content),
    };
    if (message.role === 'tool') {
      const toolName =
        message.name ?? (message.tool_call_id ? callNames.get(message.tool_call_id) : undefined);
      if (toolName) converted.tool_name = toolName;
    }
    if (Array.isArray(message.tool_calls)) {
      converted.tool_calls = message.tool_calls.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const call = raw as { type?: unknown; function?: { name?: unknown; arguments?: unknown } };
        let args = call.function?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args) as unknown;
          } catch {
            args = {};
          }
        }
        return { type: 'function', function: { name: call.function?.name, arguments: args } };
      });
    }
    return converted;
  });
}

function parseToolCalls(value: unknown, input: ChatModelBackendInput): GatewayToolCall[] {
  if (!Array.isArray(value)) return [];
  const allowedNames = new Set(
    input.tools.flatMap((tool) =>
      typeof tool.function?.name === 'string' ? [tool.function.name] : [],
    ),
  );
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error('Ollama returned an invalid tool call.');
    const call = raw as { function?: { name?: unknown; arguments?: unknown } };
    const name = call.function?.name;
    if (typeof name !== 'string' || !allowedNames.has(name)) {
      throw new Error('Ollama requested a tool that AgentOS did not expose.');
    }
    const args = call.function?.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Ollama returned invalid tool arguments.');
    }
    return {
      id: 'ollama_call_' + index,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    };
  });
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n');
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
