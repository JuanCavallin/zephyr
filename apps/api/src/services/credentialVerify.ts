/**
 * One cheap, read-only call per provider to check a key works. The result is the
 * provider's real answer: no mock fallback, and the detail never contains the key or
 * the provider's response body.
 */

import { config } from '../config.js';
import type { CredentialProvider } from './credentials.js';

export type VerifyResult =
  { ok: true; detail: string } | { ok: false; detail: string } | { ok: null; detail: string };

interface VerifyOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

function endpoint(
  providerId: CredentialProvider,
  secret: string,
  baseUrl?: string,
): { url: string; headers: Record<string, string> } | null {
  switch (providerId) {
    case 'anthropic':
      return {
        url:
          (baseUrl ?? config.providers.anthropic.baseUrl ?? 'https://api.anthropic.com/v1') +
          '/models',
        headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
      };
    case 'gemini':
      return {
        url:
          (baseUrl ??
            config.providers.gemini.baseUrl ??
            'https://generativelanguage.googleapis.com/v1beta') + '/models',
        headers: { 'x-goog-api-key': secret },
      };
    case 'browserbase':
      return {
        url: (baseUrl ?? 'https://api.browserbase.com/v1') + '/projects',
        headers: { 'X-BB-API-Key': secret },
      };
    default:
      return null;
  }
}

export async function verifyCredential(
  providerId: CredentialProvider,
  secret: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const target = endpoint(providerId, secret, options.baseUrl);
  if (!target) return { ok: null, detail: 'No verification endpoint; checked on first use.' };
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(target.url, {
      method: 'GET',
      headers: target.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch {
    return { ok: false, detail: 'Could not reach ' + new URL(target.url).host + '.' };
  }
  // Never read the body: providers echo request details in error payloads.
  void response.body?.cancel().catch(() => undefined);
  if (response.ok) return { ok: true, detail: 'Key accepted.' };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: 'Key rejected (' + response.status + ').' };
  }
  return { ok: false, detail: 'Provider returned ' + response.status + '.' };
}
