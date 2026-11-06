/**
 * Composes the Integrations read model from the services that own each kind.
 * Pure: the route gathers inputs, this maps them. Every status is the owning
 * service's real state; nothing is inferred optimistically.
 */

import type {
  IntegrationItem,
  IntegrationsResponse,
  McpConnection,
  ProviderId,
  ProviderStatus,
} from '@htn/shared';
import type { CredentialProvider, CredentialStatus } from './credentials.js';

export const KEY_NAMES: Readonly<Record<CredentialProvider, string>> = {
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  jev: 'Jev / AI Gateway',
  browserbase: 'Browserbase',
  browserless: 'Browserless',
  tavily: 'Tavily',
};

const HARNESSES: ReadonlyArray<{ id: ProviderId; name: string; keyVar: string }> = [
  { id: 'hermes', name: 'Hermes', keyVar: 'HERMES_CWD' },
  { id: 'claudecode', name: 'Claude Code', keyVar: 'CLAUDECODE_MODE' },
];
const CONNECTORS: ReadonlyArray<{ id: ProviderId; name: string; keyVar: string }> = [
  { id: 'composio', name: 'Composio', keyVar: 'COMPOSIO_API_KEY' },
];

function keyItem(status: CredentialStatus): IntegrationItem {
  const base = { kind: 'key' as const, id: status.providerId, name: KEY_NAMES[status.providerId] };
  if (status.error) {
    return {
      ...base,
      status: 'error',
      detail: 'Unreadable',
      reason: status.error,
      fix: 'Enter the key again.',
    };
  }
  if (!status.configured) return { ...base, status: 'available', detail: 'Not set' };
  return {
    ...base,
    status: 'connected',
    detail:
      '…' +
      (status.last4 ?? '—') +
      ' · ' +
      (status.source === 'user' ? 'your key' : 'operator key'),
    ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
  };
}

function mcpItem(connection: McpConnection): IntegrationItem {
  const tools = connection.toolIds.length;
  return {
    kind: 'mcp',
    id: connection.id,
    name: connection.name,
    status: connection.status,
    detail: tools + (tools === 1 ? ' tool' : ' tools'),
    ...(connection.lastError ? { reason: connection.lastError } : {}),
    updatedAt: connection.updatedAt,
  };
}

function providerItem(
  kind: 'harness' | 'connector',
  entry: { id: ProviderId; name: string; keyVar: string },
  status: ProviderStatus | undefined,
): IntegrationItem {
  const base = { kind, id: entry.id, name: entry.name };
  if (!status || status.mode === 'disabled')
    return { ...base, status: 'disabled', detail: 'Disabled' };
  if (status.mode === 'mock') return { ...base, status: 'available', detail: 'mock' };
  if (status.healthy) return { ...base, status: 'connected', detail: status.detail ?? 'live' };
  return {
    ...base,
    status: 'needs_attention',
    detail: 'live · unhealthy',
    reason: status.detail ?? 'Health check failed.',
    fix: 'Check ' + entry.keyVar + ' in .env.',
  };
}

export function buildIntegrations(input: {
  credentials: CredentialStatus[];
  mcp: McpConnection[];
  providers: ProviderStatus[];
}): IntegrationsResponse {
  const byId = new Map(input.providers.map((status) => [status.id, status]));
  const items: IntegrationItem[] = [
    ...input.credentials.map(keyItem),
    ...HARNESSES.map((entry) => providerItem('harness', entry, byId.get(entry.id))),
    ...input.mcp.map(mcpItem),
    ...CONNECTORS.map((entry) => providerItem('connector', entry, byId.get(entry.id))),
  ];
  return {
    summary: {
      connected: items.filter((item) => item.status === 'connected').length,
      needsAttention: items.filter(
        (item) => item.status === 'needs_attention' || item.status === 'error',
      ).length,
      available: items.filter((item) => item.status === 'available').length,
    },
    items,
  };
}
