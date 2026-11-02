/**
 * Short-lived, run-scoped credentials for harness hook and OTel callbacks.
 *
 * The token sits in the callback URL (`/api/hooks/claudecode/<token>`), because
 * Claude Code's HTTP hooks and OTel exporter cannot be given a custom auth scheme we
 * control end to end. So it is treated like a bearer secret: 32 random bytes, stored
 * only as a SHA-256 digest, compared by digest lookup, expiring on a sliding TTL and
 * revoked when the run ends. A token names exactly one (harness, run, step) and the
 * bridge that run's actions go through; nothing in a hook request body can widen it.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { HarnessId } from '@htn/shared';
import type { PermissionBridge } from '../tools/permissionBridge.js';

export interface HookBinding {
  harness: HarnessId;
  runId: string;
  stepId: string;
  sessionStateId?: string;
  /** managed: Zephyr launched the harness. observed: an unmodified session reports in. */
  mode: 'managed' | 'observed';
  bridge: PermissionBridge;
}

export interface ResolvedHookBinding extends HookBinding {
  expiresAt: number;
}

/** Managed runs refresh on every callback; this is the idle allowance. */
export const MANAGED_HOOK_TTL_MS = 15 * 60_000;
/** An observed session is a human's working day. */
export const OBSERVED_HOOK_TTL_MS = 12 * 60 * 60_000;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class HookTokenStore {
  private readonly entries = new Map<string, ResolvedHookBinding & { ttlMs: number }>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  mint(binding: HookBinding, ttlMs: number): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    this.entries.set(digest(token), { ...binding, ttlMs, expiresAt: this.now() + ttlMs });
    return token;
  }

  /** The binding, or null when the token is unknown or expired. Slides the expiry. */
  resolve(token: string): ResolvedHookBinding | null {
    if (!token) return null;
    const key = digest(token);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    entry.expiresAt = now + entry.ttlMs;
    const { ttlMs: _ttl, ...binding } = entry;
    return binding;
  }

  revoke(token: string): void {
    this.entries.delete(digest(token));
  }

  revokeRun(runId: string): void {
    for (const [key, entry] of this.entries) if (entry.runId === runId) this.entries.delete(key);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

/** Process-wide store shared by the Claude Code adapter and the hooks routes. */
export const hookTokens = new HookTokenStore();
