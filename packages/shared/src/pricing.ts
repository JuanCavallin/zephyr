/**
 * Per-MODEL token pricing — the one place a cost number comes from.
 *
 * Priced by the model that ACTUALLY answered (the provider's `model` field),
 * not the tier that was requested: a tier can be re-pointed at a different
 * model in config, and pricing the tier then reports the wrong bill.
 *
 * An unknown model returns `undefined`, never 0. "We don't know what this cost"
 * and "this was free" are different claims, and the analytics rollup counts
 * the first as an unpriced call instead of silently summing it as zero.
 *
 * Rates are US cents per MILLION tokens, from Anthropic's published API
 * pricing. Cache reads bill at 0.1x input and 5-minute cache writes at 1.25x
 * input unless a row overrides them. Other providers are deliberately absent
 * until someone confirms a rate: add them through `overrides` (the API reads
 * MODEL_PRICES_JSON) rather than guessing here.
 */

export interface ModelPrice {
  /** Cents per million uncached input tokens. */
  in: number;
  /** Cents per million output tokens. */
  out: number;
  /** Cents per million cache-read input tokens. Default 0.1 x `in`. */
  cacheRead?: number;
  /** Cents per million cache-write input tokens. Default 1.25 x `in`. */
  cacheWrite?: number;
}

export interface TokenUsage {
  /** Uncached input tokens — what Anthropic reports as `input_tokens`. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Matched by PREFIX, longest first, so a dated id such as
 * `claude-haiku-4-5-20251001` prices as `claude-haiku-4-5`, and
 * `claude-opus-5-5` is not mistaken for `claude-opus-5`.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { in: 1000, out: 5000, cacheRead: 25 },
  'claude-fable-5': { in: 1000, out: 5000 },
  'claude-opus-5-5': { in: 400, out: 2000, cacheRead: 20 },
  'claude-opus-5': { in: 500, out: 2500 },
  'claude-opus-4-8': { in: 500, out: 2500 },
  'claude-opus-4-7': { in: 500, out: 2500 },
  'claude-opus-4-6': { in: 500, out: 2500 },
  'claude-sonnet-5': { in: 200, out: 1000 },
  'claude-sonnet-4-6': { in: 300, out: 1500 },
  'claude-haiku-4-5': { in: 100, out: 500 },
};

/** Exact match first, then the longest table key the id starts with. */
export function priceForModel(
  modelId: string | undefined,
  overrides?: Readonly<Record<string, ModelPrice>>,
): ModelPrice | undefined {
  if (!modelId) return undefined;
  const table = overrides ? { ...MODEL_PRICES, ...overrides } : MODEL_PRICES;
  if (table[modelId]) return table[modelId];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (modelId.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

/**
 * Cost of one call in cents, or `undefined` when the model has no known price.
 * Fractional on purpose: a single cheap call is well under a cent.
 */
export function modelCostCents(
  modelId: string | undefined,
  usage: TokenUsage,
  overrides?: Readonly<Record<string, ModelPrice>>,
): number | undefined {
  const price = priceForModel(modelId, overrides);
  if (!price) return undefined;
  const cacheRead = price.cacheRead ?? price.in * 0.1;
  const cacheWrite = price.cacheWrite ?? price.in * 1.25;
  return (
    (usage.inputTokens * price.in +
      usage.outputTokens * price.out +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWriteTokens ?? 0) * cacheWrite) /
    1_000_000
  );
}
