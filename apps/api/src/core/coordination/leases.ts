/**
 * Write leases (spec §10 Leases).
 *
 * A running task holds ONE write lease over its write-scope globs. Before the broker
 * authorizes a native write it asks `checkLease(taskId, path, 'write')`:
 *
 *   - the path is inside this task's live lease          -> allowed
 *   - a hot file (package.json, lockfiles, ...)          -> denied, `hot_file`: submit an intent
 *   - another task's live lease covers it                 -> denied, `held_by_other`
 *   - this task has no live lease (never granted/expired) -> denied, `no_lease`
 *   - otherwise                                           -> denied, `outside_lease`
 *
 * Reads are unrestricted inside the repo (step 3's containment rules still apply to
 * reads outside it; that check runs before this one).
 *
 * Write scopes are guesses, so a denial must be cheap to recover from: `requestExtension`
 * grants at once when the new globs overlap no other live lease, and otherwise QUEUES the
 * request; the queue drains as the blocking leases are released, and a person can see
 * and decide queued requests in the inbox. Two live leases never overlap.
 *
 * Leases expire. A running task renews its lease as it makes progress; a task that is
 * resumed after its lease lapsed re-requests it with `acquire`.
 */

import {
  repoPathSchema,
  type CodingEvent,
  type Lease,
  type LeaseDecision,
  type LeaseMode,
  type PermissionBridgeSeam,
} from '@htn/shared';
import { newId } from '../../lib/ids.js';
import { matchesAny } from '../verify/glob.js';
import { scopesOverlap } from './conflictGraph.js';

/**
 * Files no task ever leases. Every task may need to change them, so they are edited
 * only through `HotFileIntent`s applied one at a time by the integrator.
 */
export const HOT_FILE_GLOBS: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  // Barrel files and route registries.
  'index.ts',
  'index.tsx',
  'index.js',
  'apps/api/src/app.ts',
  // Shared contracts.
  'packages/shared/src/**',
];

export function isHotFile(path: string, extra: readonly string[] = []): boolean {
  return matchesAny(path, HOT_FILE_GLOBS) || matchesAny(path, extra);
}

export type LeaseEvent = Extract<
  CodingEvent,
  { type: 'lease.granted' | 'lease.denied' | 'lease.extended' | 'lease.expired' }
>;

export interface ExtensionRequest {
  id: string;
  taskId: string;
  globs: string[];
  /** Tasks whose live leases overlap the requested globs. */
  blockedBy: string[];
  requestedAt: string;
}

export type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: 'held_by_other' | 'hot_file' | 'invalid_path'; heldBy?: string[]; message: string };

export type ExtensionResult =
  | { status: 'granted'; lease: Lease; addedGlobs: string[] }
  | { status: 'queued'; request: ExtensionRequest }
  | { status: 'rejected'; reason: 'hot_file' | 'invalid_path' | 'no_lease' | 'reviewer'; message: string };

export interface LeaseTableOptions {
  /** How long a lease lives without renewal. */
  ttlMs?: number;
  now?: () => number;
  /** Extra hot-file globs from repo policy. */
  hotGlobs?: readonly string[];
  /** Every lease event, for the run's event stream. */
  onEvent?: (event: LeaseEvent) => void;
}

export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** A glob that names only hot files (e.g. `package.json`) can never be leased. */
function hotGlob(glob: string, extra: readonly string[]): boolean {
  if (/[*?{[]/.test(glob)) return false;
  return isHotFile(glob, extra);
}

export class LeaseTable implements PermissionBridgeSeam {
  private readonly leases = new Map<string, Lease>(); // by taskId
  private readonly queue: ExtensionRequest[] = [];
  private readonly ttl: number;
  private readonly clock: () => number;
  private readonly hotGlobs: readonly string[];
  private readonly onEvent: (event: LeaseEvent) => void;

  constructor(opts: LeaseTableOptions = {}) {
    this.ttl = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.clock = opts.now ?? Date.now;
    this.hotGlobs = opts.hotGlobs ?? [];
    this.onEvent = opts.onEvent ?? (() => {});
  }

  private iso(ms = this.clock()): string {
    return new Date(ms).toISOString();
  }

  private validate(globs: readonly string[]): { reason: 'hot_file' | 'invalid_path'; message: string } | null {
    for (const g of globs) {
      if (!repoPathSchema.safeParse(g).success)
        return { reason: 'invalid_path', message: 'not a repo-relative POSIX glob: ' + g };
      if (hotGlob(g, this.hotGlobs))
        return { reason: 'hot_file', message: g + ' is a hot file: submit a HotFileIntent instead' };
    }
    return null;
  }

  /** Other tasks' live leases overlapping `globs`. */
  private overlapping(taskId: string, globs: readonly string[]): string[] {
    const out: string[] = [];
    for (const lease of this.live())
      if (lease.taskId !== taskId && scopesOverlap(lease.globs, globs)) out.push(lease.taskId);
    return out;
  }

  /** Drop lapsed leases, emitting `lease.expired`. Called before every read of the table. */
  sweep(): Lease[] {
    const now = this.clock();
    const expired: Lease[] = [];
    for (const [taskId, lease] of this.leases)
      if (Date.parse(lease.expiresAt) <= now) {
        this.leases.delete(taskId);
        expired.push(lease);
        this.onEvent({ type: 'lease.expired', leaseId: lease.id, taskId, at: this.iso(now) });
      }
    if (expired.length) this.drain();
    return expired;
  }

  live(): Lease[] {
    const now = this.clock();
    return [...this.leases.values()].filter((l) => Date.parse(l.expiresAt) > now);
  }

  leaseOf(taskId: string): Lease | undefined {
    this.sweep();
    return this.leases.get(taskId);
  }

  /** Queued extension requests, oldest first (the inbox reads these). */
  pending(): ExtensionRequest[] {
    this.sweep();
    return [...this.queue];
  }

  /**
   * Grant `taskId` a write lease over `globs`, or report who holds an overlap. Replaces
   * the task's existing lease (used on start and on resume after expiry).
   */
  acquire(taskId: string, globs: readonly string[]): AcquireResult {
    this.sweep();
    const bad = this.validate(globs);
    if (bad) return { ok: false, ...bad };
    const heldBy = this.overlapping(taskId, globs);
    if (heldBy.length)
      return {
        ok: false,
        reason: 'held_by_other',
        heldBy,
        message: 'write scope overlaps the live lease of ' + heldBy.join(', '),
      };
    const now = this.clock();
    const lease: Lease = {
      id: newId('lease'),
      taskId,
      mode: 'write',
      globs: [...new Set(globs)],
      grantedAt: this.iso(now),
      expiresAt: this.iso(now + this.ttl),
    };
    this.leases.set(taskId, lease);
    this.onEvent({ type: 'lease.granted', lease });
    return { ok: true, lease };
  }

  /** Push a live lease's expiry forward. False when the task has no live lease. */
  renew(taskId: string): boolean {
    this.sweep();
    const lease = this.leases.get(taskId);
    if (!lease) return false;
    lease.expiresAt = this.iso(this.clock() + this.ttl);
    return true;
  }

  /**
   * Add globs to a task's live lease. Granted at once when they overlap no other live
   * lease; otherwise queued until the blocking leases are released (or a person
   * decides it).
   */
  requestExtension(taskId: string, globs: readonly string[]): ExtensionResult {
    this.sweep();
    const bad = this.validate(globs);
    if (bad) return { status: 'rejected', ...bad };
    const lease = this.leases.get(taskId);
    if (!lease) return { status: 'rejected', reason: 'no_lease', message: taskId + ' has no live lease' };
    const added = globs.filter((g) => !lease.globs.includes(g));
    if (added.length === 0) return { status: 'granted', lease, addedGlobs: [] };
    const blockedBy = this.overlapping(taskId, added);
    if (blockedBy.length === 0) return this.extend(lease, added);
    const request: ExtensionRequest = {
      id: newId('lext'),
      taskId,
      globs: added,
      blockedBy,
      requestedAt: this.iso(),
    };
    this.queue.push(request);
    return { status: 'queued', request };
  }

  private extend(lease: Lease, added: string[]): ExtensionResult {
    lease.globs = [...lease.globs, ...added];
    lease.expiresAt = this.iso(this.clock() + this.ttl);
    this.onEvent({ type: 'lease.extended', lease: { ...lease, globs: [...lease.globs] }, addedGlobs: added });
    return { status: 'granted', lease, addedGlobs: added };
  }

  /**
   * A person's decision on a queued request. `reject` drops it. `approve` grants only
   * once the overlap is gone: two live leases never overlap, so an approval of a still
   * blocked request stays queued and reports who blocks it.
   */
  decideExtension(requestId: string, outcome: 'approve' | 'reject'): ExtensionResult | null {
    this.sweep();
    const i = this.queue.findIndex((r) => r.id === requestId);
    if (i === -1) return null;
    const request = this.queue[i]!;
    if (outcome === 'reject') {
      this.queue.splice(i, 1);
      return { status: 'rejected', reason: 'reviewer', message: 'extension rejected by reviewer' };
    }
    const lease = this.leases.get(request.taskId);
    if (!lease) {
      this.queue.splice(i, 1);
      return { status: 'rejected', reason: 'no_lease', message: request.taskId + ' has no live lease' };
    }
    request.blockedBy = this.overlapping(request.taskId, request.globs);
    if (request.blockedBy.length) return { status: 'queued', request };
    this.queue.splice(i, 1);
    return this.extend(lease, request.globs);
  }

  /** Release a task's lease (done, blocked, failed, cancelled) and drain the queue. */
  release(taskId: string): Lease | undefined {
    const lease = this.leases.get(taskId);
    this.leases.delete(taskId);
    for (let i = this.queue.length - 1; i >= 0; i -= 1) if (this.queue[i]!.taskId === taskId) this.queue.splice(i, 1);
    this.drain();
    return lease;
  }

  /** Grant every queued request whose blockers are gone, in queue order. */
  private drain(): ExtensionResult[] {
    const granted: ExtensionResult[] = [];
    for (let i = 0; i < this.queue.length; ) {
      const request = this.queue[i]!;
      const lease = this.leases.get(request.taskId);
      if (!lease) {
        this.queue.splice(i, 1);
        continue;
      }
      request.blockedBy = this.overlapping(request.taskId, request.globs);
      if (request.blockedBy.length) {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      granted.push(this.extend(lease, request.globs));
    }
    return granted;
  }

  /** The permission-bridge seam. Synchronous: it runs on every native tool call. */
  checkLease(taskId: string, path: string, mode: LeaseMode): LeaseDecision {
    const decision = this.decide(taskId, path, mode);
    if (!decision.allowed)
      this.onEvent({
        type: 'lease.denied',
        taskId,
        path: repoPathSchema.safeParse(path).success ? path : 'invalid',
        mode,
        reason: decision.reason,
        ...(decision.heldBy ? { heldBy: decision.heldBy } : {}),
        at: this.iso(),
      });
    return decision;
  }

  private decide(taskId: string, path: string, mode: LeaseMode): LeaseDecision {
    if (!repoPathSchema.safeParse(path).success)
      return { allowed: false, reason: 'invalid_path', message: 'not a repo-relative POSIX path: ' + path };
    if (mode === 'read') return { allowed: true, reason: 'reads are unrestricted inside the repo' };
    if (isHotFile(path, this.hotGlobs))
      return {
        allowed: false,
        reason: 'hot_file',
        message: path + ' is a hot file and is never leased; submit a HotFileIntent (e.g. add_dependency) instead',
      };
    this.sweep();
    const own = this.leases.get(taskId);
    if (own && matchesAny(path, own.globs))
      return { allowed: true, leaseId: own.id, reason: 'inside lease ' + own.globs.join(', ') };
    for (const lease of this.leases.values())
      if (lease.taskId !== taskId && matchesAny(path, lease.globs))
        return {
          allowed: false,
          reason: 'held_by_other',
          heldBy: lease.taskId,
          message: path + ' is inside the lease of task ' + lease.taskId,
        };
    if (!own)
      return {
        allowed: false,
        reason: 'no_lease',
        message: taskId + ' holds no live write lease (never granted, or expired); resume re-requests it',
      };
    return {
      allowed: false,
      reason: 'outside_lease',
      message: path + ' is outside this task\'s lease (' + own.globs.join(', ') + '); request an extension',
    };
  }
}
