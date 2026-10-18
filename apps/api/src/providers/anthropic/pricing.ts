/**
 * Per-TIER pricing, for the mock only.
 *
 * A mock call has no real model behind it, so it prices as the model the tier
 * maps to in live.ts, through the same shared per-model table the live
 * adapters use (@htn/shared pricing.ts). A demo rehearsed on mocks therefore
 * shows the same order of magnitude as the live run, and there is one rate
 * table to keep current instead of two.
 */

import { modelCostCents, type ModelTier } from '@htn/shared';

const MODEL_FOR_TIER: Record<ModelTier, string> = {
  local: 'claude-haiku-4-5',
  cheap: 'claude-haiku-4-5',
  standard: 'claude-sonnet-5',
  frontier: 'claude-opus-5',
};

/**
 * Cost of one call in cents. Fractional on purpose: a single cheap call is well
 * under a cent, and rounding here would report every demo as costing nothing.
 */
export function estimateCostCents(tier: ModelTier, tokensIn: number, tokensOut: number): number {
  return (
    modelCostCents(MODEL_FOR_TIER[tier], { inputTokens: tokensIn, outputTokens: tokensOut }) ?? 0
  );
}
