/**
 * Wraps a ProviderAdapter so that EVERY call is recorded in the egress ledger.
 *
 * This is a Proxy rather than a logging call inside each adapter method, because
 * the guarantee we want is "an unlogged outbound call is unreachable" — not
 * "everyone remembered to log". A teammate adding a method at 3am gets the
 * ledger entry for free.
 *
 * ONE CONVENTION THIS RELIES ON:
 *   the ProviderCallContext is ALWAYS the last argument of every adapter method.
 *   Every interface in @htn/shared/providers.ts is written that way. Keep it.
 *
 * `health()` is exempt: it is a liveness probe, carries no user data, and would
 * otherwise flood the ledger.
 *
 * SENTRY TRACING RIDES ON THIS SAME PROXY, deliberately. Putting the span here
 * rather than in each adapter means "an untraced outbound call is unreachable"
 * holds for exactly the same structural reason "an unlogged one is unreachable"
 * does. The span is a no-op without SENTRY_DSN.
 */

import type { ProviderAdapter, ProviderCallContext, ProviderResult } from '@htn/shared';
import type { EgressInput } from '../core/ledger.js';
import { annotateEgress, traceProviderCall } from '../lib/observability.js';

export type RecordEgress = (input: EgressInput) => Promise<void>;

const EXEMPT = new Set(['health', 'id', 'mode', 'capabilities']);

function isCallContext(value: unknown): value is ProviderCallContext {
  return typeof value === 'object' && value !== null && 'runId' in value && 'policyRule' in value;
}

export function withEgress(
  adapter: ProviderAdapter,
  record: RecordEgress,
  newId: (prefix: string) => string,
): ProviderAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || EXEMPT.has(String(prop))) return value;

      return async (...args: unknown[]) => {
        const callCtx = args[args.length - 1];
        const traced = isCallContext(callCtx)
          ? { runId: callCtx.runId, stepId: callCtx.stepId }
          : { runId: 'unattributed' };

        // The span wraps the call itself, so latency and thrown errors are the
        // provider's real ones rather than ours.
        const result = (await traceProviderCall(
          { providerId: target.id, op: String(prop), ...traced },
          () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
        )) as ProviderResult<unknown>;

        if (!isCallContext(callCtx)) {
          // No context means nothing to attribute the call to. Loud, because it
          // means someone broke the convention above rather than that it is fine.
          console.warn(
            '[egress] ' + target.id + '.' + String(prop) + ' called without a ProviderCallContext',
          );
          return result;
        }
        const ctx = callCtx;

        try {
          const entry: EgressInput = {
            id: newId('egr'),
            runId: ctx.runId,
            stepId: ctx.stepId,
            providerId: target.id,
            op: String(prop),
            destination:
              result?.meta?.destination ??
              // No network destination: in-process work on the adapter (session
              // ownership, run release, task cancel). On a live adapter that is
              // local, not a mock; the ledger default would label it mock://,
              // which marks the whole run as mocked.
              (target.mode === 'live' ? 'local://' + target.id : null),
            dataSpans: ctx.redactions ?? [],
            policyRule: ctx.policyRule,
            latencyMs: result?.meta?.latencyMs,
            // Forwarded automatically whenever a provider's meta reports them —
            // no per-call-site plumbing needed for cost accounting to work.
            tokensIn: result?.meta?.tokensIn,
            tokensOut: result?.meta?.tokensOut,
            estimatedCostCents: result?.meta?.estimatedCostCents,
            model: result?.meta?.model,
            cacheReadTokens: result?.meta?.cacheReadTokens,
            cacheWriteTokens: result?.meta?.cacheWriteTokens,
          };
          // Same numbers on the span and in the ledger, from one source, so the
          // two can never disagree about what a call cost or where it went.
          annotateEgress(entry);
          await record(entry);
        } catch (err) {
          // Never fail a provider call because the ledger write failed.
          console.error('[egress] failed to record:', (err as Error).message);
        }

        return result;
      };
    },
  });
}
