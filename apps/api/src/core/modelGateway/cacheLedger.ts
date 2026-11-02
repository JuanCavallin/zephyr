/**
 * Token accounting for `/v1/messages` traffic, per call and per run.
 *
 * Anthropic reports four DISJOINT input/output counts: `input_tokens` is the
 * uncached remainder, and cache writes and reads are separate fields. Summing
 * them into one "tokens in" number hides exactly the thing L4 exists to protect,
 * so the ledger keeps all four apart and derives the hit rate from them.
 *
 * Fields that are absent (an older model, a non-caching request, a fixture
 * without cache fields) count as 0. That is what Anthropic means when it omits them.
 */

import { modelCostCents, type GatewayUsage, type ModelPrice } from '@htn/shared';

export interface LedgerCall {
  callId: string;
  runId: string;
  model?: string;
  usage: GatewayUsage;
  /** Undefined when the model has no known price. */
  costCents?: number;
  at: string;
}

export interface RunLedger {
  runId: string;
  calls: number;
  usage: GatewayUsage;
  /** Sum over PRICED calls. */
  costCents: number;
  /** Calls whose model had no known price; their cost is not in `costCents`. */
  unpricedCalls: number;
  /** cache_read / (input + cache_creation + cache_read); 0 when there was no input. */
  cacheHitRate: number;
}

export const ZERO_USAGE: GatewayUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

/**
 * Anthropic's `usage` object -> GatewayUsage. Accepts the `message_start` shape,
 * the `message_delta` shape (output only, sometimes cumulative input too) and the
 * non-streaming body. Non-numeric or negative values are treated as absent.
 */
export function parseAnthropicUsage(raw: unknown): Partial<GatewayUsage> {
  if (!raw || typeof raw !== 'object') return {};
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const out: Partial<GatewayUsage> = {};
  const set = (key: keyof GatewayUsage, v: number | undefined) => {
    if (v !== undefined) out[key] = v;
  };
  set('inputTokens', n(u.input_tokens));
  set('outputTokens', n(u.output_tokens));
  set('cacheCreationInputTokens', n(u.cache_creation_input_tokens));
  set('cacheReadInputTokens', n(u.cache_read_input_tokens));
  return out;
}

/**
 * Fold a later usage report over an earlier one. Streaming `message_delta.usage`
 * counts are CUMULATIVE for the message, so a later value replaces an earlier one
 * rather than adding to it.
 */
export function mergeUsage(base: GatewayUsage, update: Partial<GatewayUsage>): GatewayUsage {
  return { ...base, ...update };
}

export function totalInput(u: GatewayUsage): number {
  return u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
}

export function hitRate(u: GatewayUsage): number {
  const input = totalInput(u);
  return input === 0 ? 0 : u.cacheReadInputTokens / input;
}

export class CacheLedger {
  private readonly calls = new Map<string, LedgerCall[]>();

  constructor(private readonly prices?: Readonly<Record<string, ModelPrice>>) {}

  record(input: Omit<LedgerCall, 'costCents' | 'at'> & { at?: string }): LedgerCall {
    const call: LedgerCall = {
      ...input,
      usage: { ...input.usage },
      costCents: modelCostCents(
        input.model,
        {
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadInputTokens,
          cacheWriteTokens: input.usage.cacheCreationInputTokens,
        },
        this.prices,
      ),
      at: input.at ?? new Date().toISOString(),
    };
    const list = this.calls.get(call.runId) ?? [];
    list.push(call);
    this.calls.set(call.runId, list);
    return call;
  }

  callsFor(runId: string): readonly LedgerCall[] {
    return this.calls.get(runId) ?? [];
  }

  run(runId: string): RunLedger {
    const calls = this.callsFor(runId);
    const usage = { ...ZERO_USAGE };
    let costCents = 0;
    let unpricedCalls = 0;
    for (const call of calls) {
      usage.inputTokens += call.usage.inputTokens;
      usage.outputTokens += call.usage.outputTokens;
      usage.cacheCreationInputTokens += call.usage.cacheCreationInputTokens;
      usage.cacheReadInputTokens += call.usage.cacheReadInputTokens;
      if (call.costCents === undefined) unpricedCalls += 1;
      else costCents += call.costCents;
    }
    return { runId, calls: calls.length, usage, costCents, unpricedCalls, cacheHitRate: hitRate(usage) };
  }

  /** Tokens a budget counts: every input token (cached or not) plus output. */
  runTokens(runId: string): number {
    const { usage } = this.run(runId);
    return totalInput(usage) + usage.outputTokens;
  }
}
