/**
 * Run id → worktree path, for executors that act on a coding run's checkout.
 *
 * The broker gives an executor the run id, not the harness's cwd. A coding
 * harness binds its worktree here when the session starts and unbinds it when
 * the run ends; a shaped tool called for a run with no bound worktree fails
 * closed rather than guessing a directory.
 */

export class RunWorktrees {
  private readonly paths = new Map<string, string>();

  bind(runId: string, worktree: string): void {
    this.paths.set(runId, worktree);
  }

  unbind(runId: string, worktree?: string): void {
    if (worktree === undefined || this.paths.get(runId) === worktree) this.paths.delete(runId);
  }

  resolve(runId: string): string | undefined {
    return this.paths.get(runId);
  }
}

/** The process-wide registry the claudecode adapter binds and the shaped tools read. */
export const runWorktrees = new RunWorktrees();
