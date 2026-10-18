import type { ProviderAdapter, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase } from '../_mock.js';
import { localOllamaEndpoint } from './backend.js';

export function create(cfg: ProviderConfig): ProviderAdapter {
  if (cfg.mode !== 'live') return mockBase('ollama', [], cfg.mode);
  const baseUrl = localOllamaEndpoint(cfg.baseUrl);
  return {
    id: 'ollama',
    mode: 'live',
    capabilities: [],
    async health(): Promise<ProviderResult<{ detail?: string }>> {
      const started = Date.now();
      try {
        const response = await fetch(baseUrl + '/api/tags', {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok)
          return failed(
            'health',
            started,
            baseUrl,
            'Ollama returned HTTP ' + response.status + '.',
          );
        const body = (await response.json()) as { models?: { name?: unknown }[] };
        const configured = cfg.models?.cheap;
        const available = body.models?.some((model) => model.name === configured) ?? false;
        if (!available)
          return failed(
            'health',
            started,
            baseUrl,
            'Configured Ollama model is not installed: ' + configured,
          );
        return {
          ok: true,
          data: { detail: 'live; local model=' + configured },
          meta: metadata('health', started, baseUrl),
        };
      } catch {
        return failed('health', started, baseUrl, 'Ollama is not reachable at ' + baseUrl + '.');
      }
    },
    async invoke<TIn, TOut>(op: string): Promise<ProviderResult<TOut>> {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'Ollama operation is not exposed through generic invoke: ' + op,
          retryable: false,
        },
        meta: metadata(op, Date.now(), baseUrl),
      };
    },
  };
}

function failed<T>(
  op: string,
  started: number,
  destination: string,
  message: string,
): ProviderResult<T> {
  return {
    ok: false,
    error: { code: 'UPSTREAM', message, retryable: true },
    meta: metadata(op, started, destination),
  };
}

function metadata(op: string, started: number, destination: string) {
  return {
    provider: 'ollama' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination,
  };
}
