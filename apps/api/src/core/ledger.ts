/**
 * Egress ledger — the record of every byte that left the machine.
 *
 * This file is pure: it builds the event. The wiring that guarantees the record
 * gets written lives in providers/withEgress.ts, which wraps every adapter so an
 * unlogged call is not reachable.
 */

import type { EgressEvent, ProviderId } from '@htn/shared';

export interface EgressInput {
  id: string;
  runId: string;
  stepId?: string;
  providerId: ProviderId | 'tavily';
  op: string;
  destination: string | null;
  dataSpans?: { placeholder: string; type: string }[];
  policyRule: string;
  latencyMs?: number;
  blocked?: boolean;
  /** Cost accounting, forwarded from ProviderMeta by withEgress when present. */
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostCents?: number;
  model?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function buildEgressEvent(input: EgressInput, at: string): EgressEvent {
  const dataSpans = input.dataSpans ?? [];
  return {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId,
    at,
    providerId: input.providerId,
    op: input.op,
    destination: input.destination ?? 'mock://' + input.providerId,
    dataSpans,
    policyRule: input.policyRule,
    decision: input.blocked ? 'blocked' : dataSpans.length > 0 ? 'redacted' : 'allowed',
    latencyMs: input.latencyMs,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    estimatedCostCents: input.estimatedCostCents,
    ...(input.model ? { model: input.model } : {}),
    ...(input.cacheReadTokens ? { cacheReadTokens: input.cacheReadTokens } : {}),
    ...(input.cacheWriteTokens ? { cacheWriteTokens: input.cacheWriteTokens } : {}),
  };
}

/**
 * The egress summary now lives in @htn/shared/analytics.ts so the browser can
 * compute it too (see rollup()). Re-exported here so server call sites such as
 * services/egress.service.ts keep importing it from the ledger, where it reads
 * most naturally.
 */
export { summarise, type EgressSummary } from '@htn/shared';
