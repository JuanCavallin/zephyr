/**
 * The integrator: applies hot-file intents serially (spec §10).
 *
 * One `KeyedLock` key per hot file. `submit` takes its place in that file's queue
 * synchronously, before any await, so intents land in SUBMISSION order even when many
 * are submitted at once. Each apply is read -> typed edit -> write under the lock, so
 * two concurrent `package.json` intents both land and the file is never torn.
 *
 * The integrator writes to the integration worktree (the merge queue's checkout), not
 * to any task's worktree: the result reaches every task through the merge queue's rebase.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hotFileIntentSchema, repoPathSchema, type HotFileIntent, type Json } from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import { KeyedLock } from '../locks.js';
import { applyIntent, IntentRejectedError } from './intents.js';
import { isHotFile } from './leases.js';

export interface IntegratorFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

/** Files under `root`, addressed by repo-relative POSIX path. */
export function worktreeFs(root: string): IntegratorFs {
  return {
    async read(path) {
      try {
        return await readFile(resolve(root, path), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(path, content) {
      await writeFile(resolve(root, path), content, 'utf8');
    },
  };
}

export interface IntentSubmission {
  taskId: string;
  path: string;
  kind: HotFileIntent['kind'];
  description: string;
  payload?: Json;
}

export interface IntegratorOptions {
  fs: IntegratorFs;
  /** Every intent state change, for the event stream (`intent.updated`). */
  onUpdate?: (intent: HotFileIntent, error?: string) => void;
  now?: () => string;
}

export class Integrator {
  private readonly lock = new KeyedLock();
  private readonly intents: HotFileIntent[] = [];
  private readonly errors = new Map<string, string>();
  private readonly now: () => string;

  constructor(private readonly opts: IntegratorOptions) {
    this.now = opts.now ?? nowIso;
  }

  list(filter: { taskId?: string; status?: HotFileIntent['status'] } = {}): HotFileIntent[] {
    return this.intents.filter(
      (i) => (!filter.taskId || i.taskId === filter.taskId) && (!filter.status || i.status === filter.status),
    );
  }

  errorOf(intentId: string): string | undefined {
    return this.errors.get(intentId);
  }

  /**
   * Queue an intent and resolve once it is applied or rejected. A path that is not
   * repo-relative rejects the promise; a non-hot file settles `rejected` at once. Neither
   * touches the file.
   */
  submit(sub: IntentSubmission): Promise<HotFileIntent> {
    if (!repoPathSchema.safeParse(sub.path).success)
      return Promise.reject(new IntentRejectedError(sub.path + ' is not a repo-relative path'));
    const intent = hotFileIntentSchema.parse({
      id: newId('hfi'),
      taskId: sub.taskId,
      path: sub.path,
      kind: sub.kind,
      description: sub.description,
      ...(sub.payload !== undefined ? { payload: sub.payload } : {}),
      status: 'pending',
      createdAt: this.now(),
    });
    this.intents.push(intent);
    this.opts.onUpdate?.({ ...intent });
    if (!isHotFile(intent.path))
      return Promise.resolve(this.settle(intent, 'rejected', intent.path + ' is not a hot file; edit it under a lease'));
    // Acquire synchronously: the lock's FIFO order is the submission order.
    const owned = this.lock.acquire(intent.path);
    return owned.then(async (release) => {
      try {
        const current = await this.opts.fs.read(intent.path);
        const next = applyIntent(current, intent);
        if (next !== current) await this.opts.fs.write(intent.path, next);
        return this.settle(intent, 'applied');
      } catch (error) {
        const reason =
          error instanceof IntentRejectedError ? error.message : 'apply failed: ' + (error as Error).message;
        return this.settle(intent, 'rejected', reason);
      } finally {
        release();
      }
    });
  }

  private settle(intent: HotFileIntent, status: 'applied' | 'rejected', error?: string): HotFileIntent {
    intent.status = status;
    if (error) this.errors.set(intent.id, error);
    this.opts.onUpdate?.({ ...intent }, error);
    return intent;
  }
}
