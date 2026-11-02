/**
 * Raw output behind a digest handle.
 *
 * A shaped tool keeps the full (capped) log and every failure's full detail here,
 * and returns only a handle in the digest. `zephyr_test_output(handle, testId)`
 * brings back one failure, or a page of the raw log, when the model needs it.
 *
 * Handles are scoped to the run that made them, expire after a TTL and are
 * evicted oldest-first past a count cap, so a long run cannot grow memory without
 * bound. Every miss is a clear, distinct error the model can act on.
 */

import { randomBytes } from 'node:crypto';

export interface StoredOutput {
  handle: string;
  runId: string;
  kind: 'test' | 'build' | 'lint';
  command: string;
  raw: string;
  /** Failure or diagnostic id → full detail. */
  details: Map<string, string>;
  createdAt: number;
}

export type OutputLookup =
  | { ok: true; text: string; id?: string; offset?: number; nextOffset?: number; totalChars?: number }
  | { ok: false; code: 'UNKNOWN_HANDLE' | 'EXPIRED_HANDLE' | 'WRONG_RUN' | 'UNKNOWN_TEST'; message: string };

export interface OutputStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Characters per page when the raw log is requested. */
  pageChars?: number;
  now?: () => number;
}

export const DEFAULT_OUTPUT_TTL_MS = 30 * 60_000;

export class OutputStore {
  private readonly entries = new Map<string, StoredOutput>();
  /** Handles that existed and expired or were evicted, so the error can say so. */
  private readonly gone = new Map<string, 'expired' | 'evicted'>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly pageChars: number;
  private readonly now: () => number;

  constructor(opts: OutputStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_OUTPUT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? 64;
    this.pageChars = opts.pageChars ?? 12_000;
    this.now = opts.now ?? Date.now;
  }

  put(entry: Omit<StoredOutput, 'handle' | 'createdAt'>): string {
    this.sweep();
    const handle = 'out_' + entry.kind + '_' + randomBytes(6).toString('hex');
    this.entries.set(handle, { ...entry, handle, createdAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.remember(oldest, 'evicted');
    }
    return handle;
  }

  /**
   * One failure by id (exact, else a unique case-insensitive substring), or a page of
   * the raw log when `id` is absent.
   */
  get(handle: string, runId: string, id?: string, offset = 0): OutputLookup {
    this.sweep();
    const entry = this.entries.get(handle);
    if (!entry) {
      const why = this.gone.get(handle);
      if (why === 'expired') {
        return {
          ok: false,
          code: 'EXPIRED_HANDLE',
          message: `Output handle "${handle}" expired after ${Math.round(this.ttlMs / 60_000)} min. Run the tool again for a fresh handle.`,
        };
      }
      if (why === 'evicted') {
        return {
          ok: false,
          code: 'EXPIRED_HANDLE',
          message: `Output handle "${handle}" was evicted by newer runs. Run the tool again for a fresh handle.`,
        };
      }
      return {
        ok: false,
        code: 'UNKNOWN_HANDLE',
        message: `Unknown output handle "${handle}". Handles come from the "handle" field of zephyr_run_tests, zephyr_build or zephyr_lint results.`,
      };
    }
    if (entry.runId !== runId) {
      return { ok: false, code: 'WRONG_RUN', message: `Output handle "${handle}" belongs to another run.` };
    }

    if (id !== undefined && id !== '') {
      const exact = entry.details.get(id);
      if (exact !== undefined) return { ok: true, id, text: exact };
      const needle = id.toLowerCase();
      const matches = [...entry.details.keys()].filter((k) => k.toLowerCase().includes(needle));
      if (matches.length === 1) return { ok: true, id: matches[0]!, text: entry.details.get(matches[0]!)! };
      const known = [...entry.details.keys()];
      const listed = known.slice(0, 20).map((k) => '  ' + k).join('\n');
      return {
        ok: false,
        code: 'UNKNOWN_TEST',
        message:
          (matches.length > 1 ? `"${id}" matches ${matches.length} ids; use the exact id.` : `No failure "${id}" under handle "${handle}".`) +
          (known.length ? '\nIds under this handle:\n' + listed + (known.length > 20 ? `\n  … ${known.length - 20} more` : '') : ' This run had no failures.'),
      };
    }

    const start = Math.max(0, Math.min(offset, entry.raw.length));
    const end = Math.min(entry.raw.length, start + this.pageChars);
    return {
      ok: true,
      text: entry.raw.slice(start, end),
      offset: start,
      totalChars: entry.raw.length,
      ...(end < entry.raw.length ? { nextOffset: end } : {}),
    };
  }

  /** Drop every handle of a run (run finished). */
  forgetRun(runId: string): void {
    for (const [handle, entry] of this.entries) {
      if (entry.runId === runId) {
        this.entries.delete(handle);
        this.remember(handle, 'expired');
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [handle, entry] of this.entries) {
      if (entry.createdAt > cutoff) break; // insertion order = age order
      this.entries.delete(handle);
      this.remember(handle, 'expired');
    }
  }

  private remember(handle: string, why: 'expired' | 'evicted'): void {
    this.gone.set(handle, why);
    if (this.gone.size > this.maxEntries * 8) this.gone.delete(this.gone.keys().next().value as string);
  }
}
