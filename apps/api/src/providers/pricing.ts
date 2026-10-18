/**
 * Server-side cost for one model call: the shared per-model table plus any
 * operator-supplied rates.
 *
 * MODEL_PRICES_JSON adds or corrects rates without a code change, e.g. for a
 * Gemini model or Jev once their real pricing is confirmed:
 *
 *   MODEL_PRICES_JSON={"gemini-3.8-flash":{"in":0.3,"out":2.5}}
 *
 * Values there are DOLLARS per million tokens (how providers publish them);
 * they are converted to the table's cents. A malformed value is ignored with a
 * warning: a typo in a price must never stop the API from booting.
 */

import { modelCostCents, type ModelPrice, type TokenUsage } from '@htn/shared';

let overrides: Record<string, ModelPrice> | undefined;

function loadOverrides(): Record<string, ModelPrice> {
  if (overrides) return overrides;
  overrides = {};
  const raw = process.env.MODEL_PRICES_JSON?.trim();
  if (!raw) return overrides;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<Record<keyof ModelPrice, number>>>;
    for (const [model, rate] of Object.entries(parsed)) {
      if (typeof rate?.in !== 'number' || typeof rate.out !== 'number') continue;
      overrides[model] = {
        in: rate.in * 100,
        out: rate.out * 100,
        ...(typeof rate.cacheRead === 'number' ? { cacheRead: rate.cacheRead * 100 } : {}),
        ...(typeof rate.cacheWrite === 'number' ? { cacheWrite: rate.cacheWrite * 100 } : {}),
      };
    }
  } catch {
    console.warn('[pricing] MODEL_PRICES_JSON is not valid JSON; using the built-in table only.');
  }
  return overrides;
}

/** Cents for one call, or undefined when the model has no known rate. */
export function costCents(modelId: string | undefined, usage: TokenUsage): number | undefined {
  return modelCostCents(modelId, usage, loadOverrides());
}
