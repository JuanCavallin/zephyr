/**
 * Scoped per-run credentials for `/v1/messages`.
 *
 * A harness pointed at the gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`)
 * presents one of these on every call. The token names exactly one run and carries
 * that run's budget; it is the ONLY thing that selects which run a call is billed to.
 *
 * Unknown and finished are different answers on purpose: a token we never issued
 * is an authentication failure (401), while a token for a run that has ended is a
 * valid identity that is no longer allowed to spend (403). A harness that keeps
 * calling after its run ended is a bug worth seeing, not a typo.
 *
 * Stored as SHA-256 digests only, like hookTokens.ts. Process-local: a restart
 * forgets every token, which turns into 401 -- the safe direction.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface RunBudgetCaps {
  /** Total tokens (all input incl. cache reads/writes, plus output) the run may spend. */
  maxTokens?: number;
  /** Total priced cost in cents the run may spend. */
  maxCostCents?: number;
}

export interface GatewayRunBinding {
  runId: string;
  sessionStateId?: string;
  harness: string;
  budget: RunBudgetCaps;
  /** Redaction namespace. Defaults to the run id: numbering is independent per run. */
  redactionScope?: string;
  /** Replace PII with stable `[[PII_n]]` placeholders before forwarding. */
  redact?: boolean;
}

export type RunTokenResolution =
  | { status: 'active'; binding: GatewayRunBinding }
  | { status: 'finished'; binding: GatewayRunBinding }
  | { status: 'unknown' };

/** Finished entries kept for the 403 answer; the oldest is forgotten past this. */
const MAX_FINISHED = 5000;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class GatewayRunTokenStore {
  private readonly entries = new Map<string, { binding: GatewayRunBinding; finished: boolean }>();
  private finishedCount = 0;

  mint(binding: GatewayRunBinding): string {
    const token = 'zgw_' + randomBytes(32).toString('base64url');
    this.entries.set(digest(token), { binding: { ...binding, budget: { ...binding.budget } }, finished: false });
    return token;
  }

  resolve(token: string | undefined | null): RunTokenResolution {
    if (!token) return { status: 'unknown' };
    const entry = this.entries.get(digest(token));
    if (!entry) return { status: 'unknown' };
    return { status: entry.finished ? 'finished' : 'active', binding: entry.binding };
  }

  /** Mark one token finished (its task ended; the run may go on). Idempotent. */
  finish(token: string): void {
    const entry = this.entries.get(digest(token));
    if (entry && !entry.finished) {
      entry.finished = true;
      this.finishedCount += 1;
      this.prune();
    }
  }

  /** Mark every token of a run finished. Idempotent. */
  finishRun(runId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.binding.runId === runId && !entry.finished) {
        entry.finished = true;
        this.finishedCount += 1;
      }
    }
    this.prune();
  }

  private prune(): void {
    if (this.finishedCount <= MAX_FINISHED) return;
    for (const [key, entry] of this.entries) {
      if (this.finishedCount <= MAX_FINISHED) break;
      if (entry.finished) {
        this.entries.delete(key);
        this.finishedCount -= 1;
      }
    }
  }
}

/**
 * The credential a request presents. Claude Code sends `ANTHROPIC_AUTH_TOKEN` as
 * `Authorization: Bearer`, and `ANTHROPIC_API_KEY` as `x-api-key`; both are accepted.
 * Bearer wins when both are present, because it is the one Zephyr sets.
 */
export function presentedCredential(headers: {
  authorization?: string | undefined;
  'x-api-key'?: string | undefined;
}): string | undefined {
  const auth = headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const raw = auth.slice('Bearer '.length).trim();
    if (raw) return raw;
  }
  const key = headers['x-api-key']?.trim();
  return key || undefined;
}

/** Process-wide store shared by the harness adapters and the gateway routes. */
export const gatewayRunTokens = new GatewayRunTokenStore();
