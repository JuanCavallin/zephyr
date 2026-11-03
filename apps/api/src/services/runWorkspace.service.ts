/**
 * The run page's Workspace panel (docs/cacp-09-benchmark-cli-demo.md, "UI and demo"):
 * the live diff of a run's worktree and rewinding it to a per-turn checkpoint.
 *
 * Both act only on refs the run itself announced in `workspace.checkpoint` events, so a
 * client can never point git at an arbitrary ref. Rewind is the user's action on their
 * own run's worktree (the local-control cookie guards the route); it is refused while
 * the run is mid-turn, because the agent would keep editing the tree being restored.
 */

import { isTerminal, type Run, type RunEvent, type StoredEvent } from '@htn/shared';

/** A patch larger than this is cut; the stat line still covers every file. */
export const DIFF_PATCH_LIMIT = 200_000;

export interface RunWorkspaceDeps {
  getRun(id: string): Promise<Run | null>;
  events(id: string): Promise<StoredEvent[]>;
  /** The run's worktree directory, or undefined once it has been disposed. */
  pathOf(runId: string): string | undefined;
  diff(runId: string, since?: string): Promise<{ stat: string; hash: string; patch: string }>;
  rewind(runId: string, ref: string): Promise<void>;
  emit(runId: string, event: RunEvent): Promise<unknown>;
  now?: () => string;
}

export interface RunCheckpoint {
  turn: number;
  turnId: string;
  ref: string;
  treeHash?: string;
  at: string;
}

export interface RunDiff {
  stat: string;
  hash: string;
  patch: string;
  truncated: boolean;
  since?: string;
}

export class RunWorkspaceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function checkpointsOf(events: StoredEvent[]): RunCheckpoint[] {
  const out: RunCheckpoint[] = [];
  for (const { event } of events) {
    if (event.type !== 'workspace.checkpoint') continue;
    out.push({
      turn: out.length + 1,
      turnId: event.turnId,
      ref: event.ref,
      ...(event.treeHash ? { treeHash: event.treeHash } : {}),
      at: event.at,
    });
  }
  return out;
}

export function createRunWorkspace(deps: RunWorkspaceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function load(runId: string) {
    const run = await deps.getRun(runId);
    if (!run) throw new RunWorkspaceError(404, 'NOT_FOUND', 'Run not found');
    return { run, checkpoints: checkpointsOf(await deps.events(runId)) };
  }

  function known(checkpoints: RunCheckpoint[], ref: string): RunCheckpoint {
    const hit = checkpoints.find((c) => c.ref === ref);
    if (!hit) throw new RunWorkspaceError(400, 'UNKNOWN_CHECKPOINT', 'Not a checkpoint of this run: ' + ref);
    return hit;
  }

  return {
    async checkpoints(runId: string): Promise<{ checkpoints: RunCheckpoint[]; live: boolean }> {
      const { checkpoints } = await load(runId);
      return { checkpoints, live: deps.pathOf(runId) !== undefined };
    },

    async diff(runId: string, since?: string): Promise<RunDiff> {
      const { checkpoints } = await load(runId);
      if (since !== undefined) known(checkpoints, since);
      if (deps.pathOf(runId) === undefined) {
        throw new RunWorkspaceError(409, 'NO_WORKSPACE', 'This run has no worktree on disk (finished or never opened).');
      }
      const d = await deps.diff(runId, since);
      const truncated = d.patch.length > DIFF_PATCH_LIMIT;
      return {
        stat: d.stat,
        hash: d.hash,
        patch: truncated ? d.patch.slice(0, DIFF_PATCH_LIMIT) : d.patch,
        truncated,
        ...(since !== undefined ? { since } : {}),
      };
    },

    async rewind(runId: string, ref: string): Promise<RunCheckpoint> {
      const { run, checkpoints } = await load(runId);
      const target = known(checkpoints, ref);
      if (isTerminal(run.status)) {
        throw new RunWorkspaceError(409, 'RUN_FINISHED', 'The run has finished; its worktree is gone.');
      }
      if (run.status === 'running' || run.status === 'pending') {
        throw new RunWorkspaceError(409, 'RUN_ACTIVE', 'Pause the run before rewinding: the agent is still editing.');
      }
      if (deps.pathOf(runId) === undefined) {
        throw new RunWorkspaceError(409, 'NO_WORKSPACE', 'This run has no worktree on disk.');
      }
      await deps.rewind(runId, ref);
      await deps.emit(runId, {
        type: 'log',
        runId,
        level: 'info',
        message: `Workspace rewound by the user to turn ${target.turn} (${ref}).`,
        at: now(),
      });
      return target;
    },
  };
}

export type RunWorkspace = ReturnType<typeof createRunWorkspace>;

let shared: RunWorkspace | undefined;

/** The process-wide instance, bound to the store, the bus and the `workspace` provider. */
export async function runWorkspace(): Promise<RunWorkspace> {
  if (!shared) {
    // Lazy: runtime.ts pulls in the whole control plane.
    const [{ bus, providers, store }, { workspaces }] = await Promise.all([
      import('./runtime.js'),
      import('./workspaces.service.js'),
    ]);
    const ws = await workspaces();
    shared = createRunWorkspace({
      getRun: (id) => store.getRun(id),
      events: (id) => store.eventsSince(id, 0),
      pathOf: (runId) => providers.provider('workspace').pathOf(runId),
      diff: (runId, since) => ws.diff(runId, since),
      rewind: (runId, ref) => ws.rewind(runId, ref),
      emit: (runId, event) => bus.emit(runId, event),
    });
  }
  return shared;
}
