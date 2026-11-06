/**
 * Reads provider keys out of a pasted `.env` file. Pure: the caller decides what to store.
 * Only recognised variables are returned; everything else is counted, never echoed.
 */

import type { CredentialProvider, CredentialStatus, CredentialStore } from './credentials.js';

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
  // A quoted value, optionally followed by ` # comment`.
  const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
  if (quoted) return quoted[2]!;
  // Unquoted values may carry a trailing ` # comment`.
  return value.replace(/\s+#.*$/, '');
}

/** Same rule PUT /credentials/:providerId enforces for metadata.projectId. */
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

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
    if (value && target && PROJECT_ID.test(value)) {
      target.metadata = { ...target.metadata, [field]: value };
    }
  }
  return { matches: [...byProvider.values()], ignored };
}

/**
 * Store the selected keys, all or nothing. On a failed write, every key this call
 * already replaced goes back exactly as it was (secret and metadata); a key that did
 * not exist is removed again; an unreadable previous key is left alone so its
 * "re-enter" signal survives.
 */
export async function importCredentials(
  store: CredentialStore,
  principalId: string,
  selected: EnvCredentialMatch[],
): Promise<CredentialStatus[]> {
  const done: Array<{
    providerId: CredentialProvider;
    previous?: { secret: string; metadata?: { projectId?: string } };
    unreadable: boolean;
  }> = [];
  try {
    for (const match of selected) {
      const previous = store.userEntry(principalId, match.providerId);
      const unreadable = store.unreadable(principalId, match.providerId);
      await store.save(principalId, match.providerId, match.secret, match.metadata);
      done.push({ providerId: match.providerId, ...(previous ? { previous } : {}), unreadable });
    }
  } catch (error) {
    for (const { providerId, previous, unreadable } of done.reverse()) {
      if (previous) {
        await store
          .save(principalId, providerId, previous.secret, previous.metadata)
          .catch(() => undefined);
      } else if (!unreadable) {
        await store.delete(principalId, providerId).catch(() => undefined);
      }
    }
    throw error;
  }
  const statuses = store.statuses(principalId);
  return selected.map((match) =>
    statuses.find((status) => status.providerId === match.providerId)!,
  );
}
