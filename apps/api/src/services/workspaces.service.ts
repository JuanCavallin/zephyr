/**
 * Run-level workspace lifecycle over the `workspace` capability.
 *
 *   open           create the run's worktree (branch zephyr/<runId>)
 *   checkpointTurn snapshot after each harness turn; turns are numbered 1, 2, ...
 *   rewind / diff  pass-through, kept here so callers never hold the adapter
 *   finish         on a TERMINAL run status, dispose the worktree. The branch is
 *                  kept by default only on success (it is the deliverable the merge
 *                  queue picks up); callers can override either way.
 *   reapOrphans    at startup, dispose every workspace whose run is not active.
 *                  A crashed process leaves its worktree on disk; the branch is
 *                  kept only if the harness committed something on it.
 */

import { isTerminal, type RunStatus, type WorkspaceAdapter } from '@htn/shared';

export interface WorkspacesService {
  open(runId: string, base?: string): Promise<{ path: string; branch: string }>;
  checkpointTurn(runId: string): Promise<{ turn: number; ref: string; treeHash: string }>;
  rewind(runId: string, ref: string): Promise<void>;
  diff(runId: string, since?: string): Promise<{ stat: string; hash: string; patch: string }>;
  /** Returns true when the workspace was disposed (status was terminal). */
  finish(runId: string, status: RunStatus, opts?: { keepBranch?: boolean }): Promise<boolean>;
  reapOrphans(activeRunIds?: Iterable<string>): Promise<{ runId: string; keptBranch: boolean }[]>;
}

export function createWorkspacesService(adapter: () => WorkspaceAdapter): WorkspacesService {
  const turns = new Map<string, number>();

  return {
    async open(runId, base = 'HEAD') {
      const created = await adapter().create(runId, base);
      turns.set(runId, 0);
      return created;
    },

    async checkpointTurn(runId) {
      const turn = (turns.get(runId) ?? 0) + 1;
      const result = await adapter().checkpoint(runId, turn);
      turns.set(runId, turn);
      return { turn, ...result };
    },

    rewind: (runId, ref) => adapter().rewind(runId, ref),
    diff: (runId, since) => adapter().diff(runId, since),

    async finish(runId, status, opts = {}) {
      if (!isTerminal(status)) return false;
      await adapter().dispose(runId, opts.keepBranch ?? status === 'succeeded');
      turns.delete(runId);
      return true;
    },

    async reapOrphans(activeRunIds = []) {
      const active = new Set(activeRunIds);
      const reaped: { runId: string; keptBranch: boolean }[] = [];
      const ws = adapter();
      for (const runId of await ws.list()) {
        if (active.has(runId)) continue;
        const keptBranch = (await ws.commitsAhead(runId)) > 0;
        await ws.dispose(runId, keptBranch);
        turns.delete(runId);
        reaped.push({ runId, keptBranch });
      }
      return reaped;
    },
  };
}

let shared: WorkspacesService | undefined;

/** The process-wide service, bound to the registry's `workspace` provider. */
export async function workspaces(): Promise<WorkspacesService> {
  if (!shared) {
    // Lazy: runtime.ts builds the registry and pulls in the whole control plane.
    const { providers } = await import('./runtime.js');
    shared = createWorkspacesService(() => providers.provider('workspace'));
  }
  return shared;
}

/**
 * Startup hook. Runs after recoverInterruptedRuns, so no run is active yet:
 * every workspace on disk was left by a previous process.
 */
export async function reapOrphanWorkspaces(): Promise<void> {
  try {
    const reaped = await (await workspaces()).reapOrphans();
    if (reaped.length) {
      const kept = reaped.filter((r) => r.keptBranch).length;
      console.log(
        `[workspaces] reaped ${reaped.length} orphaned workspace(s)` +
          (kept ? `; kept ${kept} branch(es) with commits` : ''),
      );
    }
  } catch (error) {
    // Never block boot on cleanup; the next start tries again.
    console.warn('[workspaces] orphan reaping failed:', (error as Error).message);
  }
}
