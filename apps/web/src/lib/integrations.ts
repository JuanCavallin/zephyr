/**
 * Pure helpers for the Integrations tab. No React, no fetch: unit-tested directly.
 */

import type {
  IntegrationItem,
  IntegrationKind,
  IntegrationStatus,
  IntegrationsSummary,
} from '@htn/shared';

export type CategoryId = 'keys' | 'harnesses' | 'mcp' | 'connectors' | 'system';

export const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; kind?: IntegrationKind }> =
  [
    { id: 'keys', label: 'Model keys', kind: 'key' },
    { id: 'harnesses', label: 'Harnesses', kind: 'harness' },
    { id: 'mcp', label: 'MCP servers', kind: 'mcp' },
    { id: 'connectors', label: 'Connectors', kind: 'connector' },
    { id: 'system', label: 'System' },
  ];

export function categoryFromParam(kind: string | undefined): CategoryId {
  return CATEGORIES.find((category) => category.id === kind)?.id ?? 'keys';
}

export function countsByCategory(items: IntegrationItem[]): Record<CategoryId, number> {
  const counts: Record<CategoryId, number> = {
    keys: 0,
    harnesses: 0,
    mcp: 0,
    connectors: 0,
    system: 0,
  };
  for (const item of items) {
    if (item.status !== 'connected') continue;
    const category = CATEGORIES.find((entry) => entry.kind === item.kind);
    if (category) counts[category.id] += 1;
  }
  return counts;
}

/** Where "needs you" in the header goes: the first item in need_attention or error. */
export function firstAttentionPath(items: IntegrationItem[]): string | undefined {
  const item = items.find(
    (entry) => entry.status === 'needs_attention' || entry.status === 'error',
  );
  const category = item && CATEGORIES.find((entry) => entry.kind === item.kind);
  return category ? '/integrations/' + category.id + '/' + encodeURIComponent(item.id) : undefined;
}

export function summaryLine(summary: IntegrationsSummary): string {
  const connected = summary.connected + ' connected';
  if (summary.needsAttention === 0) return connected;
  return (
    connected +
    ', ' +
    summary.needsAttention +
    (summary.needsAttention === 1 ? ' needs you' : ' need you')
  );
}

export type StatusGlyph = 'done' | 'attention' | 'error' | 'planned' | 'off';

export function statusGlyph(status: IntegrationStatus): StatusGlyph {
  switch (status) {
    case 'connected':
      return 'done';
    case 'needs_attention':
      return 'attention';
    case 'error':
      return 'error';
    case 'available':
      return 'planned';
    default:
      return 'off';
  }
}

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  return Math.round(hours / 24) + ' d ago';
}
