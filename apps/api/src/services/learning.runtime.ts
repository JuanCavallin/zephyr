/**
 * The process-wide learning service, wired to the runtime singletons. Lazy, like the
 * board: the check scripts build their own over an in-memory profile.
 *
 * The profile lives at `~/.zephyr/profile.db` when the server persists to disk, and in
 * memory otherwise, so a dev or test server never writes into the user's home.
 *
 * Private signals are drafted only by a local model: Ollama when it is live, or the
 * text model when that is a mock (a mock never leaves the process). With neither, private
 * signals wait in the profile until one exists.
 */

import type { ProviderCallContext, ProviderResult, TextModelAdapter } from '@htn/shared';
import { config } from '../config.js';
import { defaultProfilePath, ProfileStore } from '../core/learning/profileStore.js';
import { createOllamaBackend, ollamaModelRoutes } from '../providers/ollama/backend.js';
import { LearningService } from './learning.service.js';
import { bus, decisionService, providers, recordEgress } from './runtime.js';

type Complete = TextModelAdapter['complete'];

/** Ollama's chat endpoint as a `complete`, or undefined when Ollama is not live. */
export function ollamaComplete(): Complete | undefined {
  const cfg = config.providers.ollama;
  const route = ollamaModelRoutes(cfg)[0];
  if (!route) return undefined;
  const backend = createOllamaBackend(cfg, recordEgress, {
    complete: () => Promise.reject(new Error('learning drafts only on the local route')),
  });
  return async (req, ctx: ProviderCallContext): Promise<ProviderResult<{ text: string; tokensIn: number; tokensOut: number }>> => {
    const started = Date.now();
    const meta = () => ({
      provider: 'ollama' as const,
      op: 'complete',
      mode: 'live' as const,
      latencyMs: Date.now() - started,
      destination: cfg.baseUrl ?? 'http://127.0.0.1:11434',
    });
    try {
      const r = await backend.complete(
        {
          route,
          messages: [
            ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
            { role: 'user' as const, content: req.prompt },
          ],
          tools: [],
          ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
        },
        ctx,
      );
      return { ok: true, data: { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut }, meta: meta() };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'UPSTREAM', message: (error as Error).message, retryable: true },
        meta: meta(),
      };
    }
  };
}

let instance: LearningService | undefined;

export function learningService(): LearningService {
  if (instance) return instance;
  const text = () => providers.provider('text.model');
  const complete: Complete = (req, ctx) => text().complete(req, ctx);
  const completeLocal = ollamaComplete() ?? (text().mode === 'mock' ? complete : undefined);
  instance = new LearningService({
    store: new ProfileStore(config.persistToDisk ? defaultProfilePath() : ':memory:'),
    decisions: decisionService,
    complete,
    ...(completeLocal ? { completeLocal } : {}),
    emit: (runId, event) => bus.emit(runId, event),
    onError: (error) => console.error('[learning]', error instanceof Error ? error.message : error),
    repoRoot: config.providers.git.repoRoot ?? process.cwd(),
    isPrivate: async (origin) => (await import('./board.runtime.js')).boardService().isPrivate(origin),
  });
  return instance;
}
