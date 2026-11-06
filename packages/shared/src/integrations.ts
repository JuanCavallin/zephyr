/**
 * The Integrations tab's read model: one row per thing the user can connect.
 * Composed server-side from the per-kind services; it owns no state.
 */

export type IntegrationKind = 'key' | 'harness' | 'mcp' | 'connector';
export type IntegrationStatus =
  'connected' | 'needs_attention' | 'available' | 'error' | 'disabled';

export interface IntegrationItem {
  kind: IntegrationKind;
  id: string;
  name: string;
  status: IntegrationStatus;
  /** One short line for the list row. Never contains a secret. */
  detail: string;
  /** Why it needs attention or failed. */
  reason?: string;
  /** What the user can do about it. */
  fix?: string;
  updatedAt?: string;
}

export interface IntegrationsSummary {
  connected: number;
  /** `needs_attention` plus `error`. */
  needsAttention: number;
  available: number;
}

export interface IntegrationsResponse {
  summary: IntegrationsSummary;
  items: IntegrationItem[];
}
