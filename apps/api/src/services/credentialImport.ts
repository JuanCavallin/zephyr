/**
 * Reads provider keys out of a pasted `.env` file. Pure: the caller decides what to store.
 * Only recognised variables are returned; everything else is counted, never echoed.
 */

import type { CredentialProvider } from './credentials.js';

/** Env var -> credential provider. Earlier entries win when two map to one provider. */
export const ENV_CREDENTIALS: Readonly<Record<string, CredentialProvider>> = {
  ANTHROPIC_API_KEY: 'anthropic',
  GEMINI_API_KEY: 'gemini',
  AI_GATEWAY_API_KEY: 'jev',
  JEV_API_KEY: 'jev',
  BROWSERBASE_API_KEY: 'browserbase',
  BROWSERLESS_API_KEY: 'browserless',
  TAVILY_API_KEY: 'tavily',
};
const METADATA_VARS: Readonly<
  Record<string, { provider: CredentialProvider; field: 'projectId' }>
> = { BROWSERBASE_PROJECT_ID: { provider: 'browserbase', field: 'projectId' } };

export interface EnvCredentialMatch {
  providerId: CredentialProvider;
  envVar: string;
  secret: string;
  metadata?: { projectId?: string };
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
    return value.slice(1, -1);
  }
  // Unquoted values may carry a trailing ` # comment`.
  return value.replace(/\s+#.*$/, '');
}

export function parseEnvCredentials(text: string): {
  matches: EnvCredentialMatch[];
  ignored: number;
} {
  const values = new Map<string, string>();
  let ignored = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    if (!(name in ENV_CREDENTIALS) && !(name in METADATA_VARS)) {
      ignored += 1;
      continue;
    }
    const value = unquote(match[2]!);
    if (value) values.set(name, value);
  }

  const byProvider = new Map<CredentialProvider, EnvCredentialMatch>();
  for (const [envVar, providerId] of Object.entries(ENV_CREDENTIALS)) {
    const secret = values.get(envVar);
    if (secret && !byProvider.has(providerId))
      byProvider.set(providerId, { providerId, envVar, secret });
  }
  for (const [envVar, { provider, field }] of Object.entries(METADATA_VARS)) {
    const value = values.get(envVar);
    const target = byProvider.get(provider);
    if (value && target) target.metadata = { ...target.metadata, [field]: value };
  }
  return { matches: [...byProvider.values()], ignored };
}
