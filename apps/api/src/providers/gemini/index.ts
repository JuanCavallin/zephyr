/**
 * Gemini — status/health adapter.
 *
 * Completions do NOT go through here. They go through the model gateway's
 * backend seam (backend.ts), exactly like Ollama, because the
 * gateway owns route selection, tool filtering and the model lifecycle trace.
 * This adapter exists so the provider shows up on the providers page with a
 * real credential check rather than an assumption.
 */

import type { ProviderAdapter, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase } from '../_mock.js';
import { credentials } from '../../services/credentials.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function meta(cfg: ProviderConfig, op: string, started: number) {
  return {
    provider: 'gemini' as const,
    op,
    mode: cfg.mode,
    latencyMs: Date.now() - started,
    destination: cfg.mode === 'live' ? (cfg.baseUrl ?? DEFAULT_BASE_URL) : 'mock://gemini',
  };
}

export function create(cfg: ProviderConfig): ProviderAdapter {
  if (cfg.mode !== 'live') return mockBase('gemini', [], cfg.mode);
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    id: 'gemini',
    mode: 'live',
    capabilities: [],

    async health(): Promise<ProviderResult<{ detail?: string }>> {
      const started = Date.now();
      if (credentials.source === 'user') {
        return {
          ok: true,
          data: { detail: 'User-funded Gemini; credentials checked per run.' },
          meta: { ...meta(cfg, 'health', started), destination: 'local://credential-status' },
        };
      }
      try {
        // Listing models validates the key AND surfaces a stale model id: the
        // configured routes are checked against what the account can actually
        // see, so a renamed model is visible here instead of mid-demo.
        const response = await fetch(baseUrl + '/models', {
          headers: { 'x-goog-api-key': cfg.apiKey ?? '' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: response.status === 401 || response.status === 403 ? 'AUTH' : 'UPSTREAM',
              message: 'Gemini credential check returned HTTP ' + response.status + '.',
              retryable: response.status === 429 || response.status >= 500,
            },
            meta: meta(cfg, 'health', started),
          };
        }

        const body = (await response.json()) as { models?: { name?: unknown }[] };
        const available = new Set(
          (body.models ?? []).flatMap((model) =>
            typeof model.name === 'string' ? [model.name.replace(/^models\//, '')] : [],
          ),
        );
        const configured = [cfg.models?.cheap, cfg.models?.frontier].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        );
        const missing = configured.filter((id) => !available.has(id));

        if (missing.length > 0) {
          return {
            ok: false,
            error: {
              code: 'BAD_INPUT',
              message:
                'Gemini key is valid but these configured models are not available: ' +
                missing.join(', ') +
                '. Set GEMINI_CHEAP_MODEL / GEMINI_FRONTIER_MODEL.',
              retryable: false,
            },
            meta: meta(cfg, 'health', started),
          };
        }

        return {
          ok: true,
          data: { detail: 'live; ' + configured.length.toString() + ' model route(s) verified' },
          meta: meta(cfg, 'health', started),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              error instanceof DOMException && error.name === 'TimeoutError'
                ? 'TIMEOUT'
                : 'UPSTREAM',
            message: 'Gemini credential check failed.',
            retryable: true,
          },
          meta: meta(cfg, 'health', started),
        };
      }
    },

    async invoke<TIn, TOut>(op: string): Promise<ProviderResult<TOut>> {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'Gemini completions go through the model gateway, not invoke: ' + op,
          retryable: false,
        },
        meta: meta(cfg, op, Date.now()),
      };
    },
  };
}
