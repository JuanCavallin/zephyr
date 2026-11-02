/**
 * Step 5, lever L2 entry point: build a context pack for a coding task in a
 * worktree, scoring candidates with Jev through the DecisionService.
 *
 * What reaches Jev is decided here, not in the pack: the task text sent remotely
 * is the session's sanitized objective, and eligibility comes from the session's
 * data labels. A task with no session state is treated as unsanitized, so a live
 * Jev is not called and the deterministic rank is used instead.
 */

import type { AgentSessionState, DecisionState, ProviderCallContext, RunEvent } from '@htn/shared';
import type { DecisionService } from '../decisions/service.js';
import { decisionStateFromSession } from '../sessions/decisionState.js';
import { buildContextPack, type ContextPack, type ContextPackOptions } from './pack.js';
import { buildRepoIndex } from './repoIndex.js';

export { buildContextPack, type ContextPack, type ContextPackOptions } from './pack.js';
export { buildRepoIndex, type RepoIndex } from './repoIndex.js';
export { selectCandidates } from './candidates.js';

export type ContextPackBuilder = (
  input: { task: string; worktree: string },
  ctx: ProviderCallContext,
) => Promise<ContextPack>;

export interface ContextPackBuilderDeps {
  decisions: Pick<DecisionService, 'scoreFiles'>;
  sessions?: { get(id: string): Promise<AgentSessionState | null> };
  emit?: (runId: string, event: RunEvent) => Promise<unknown> | unknown;
  options?: Omit<ContextPackOptions, 'scorer' | 'run' | 'emit'>;
}

const UNSANITIZED: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'> = {
  sanitizedForRemote: false,
  dataLabels: [],
};

export function createContextPackBuilder(deps: ContextPackBuilderDeps): ContextPackBuilder {
  return async ({ task, worktree }, ctx) => {
    const repo = await buildRepoIndex(worktree);
    let eligibility = UNSANITIZED;
    let remoteTask = task;
    if (ctx.sessionStateId && deps.sessions) {
      const session = await deps.sessions.get(ctx.sessionStateId);
      if (session) {
        const state = decisionStateFromSession(session);
        eligibility = state;
        remoteTask = state.taskSummary;
      }
    }
    return buildContextPack(task, repo, {
      ...deps.options,
      scorer: (input) => deps.decisions.scoreFiles(eligibility, { ...input, task: remoteTask }, ctx),
      run: { runId: ctx.runId, ...(ctx.stepId ? { stepId: ctx.stepId } : {}) },
      ...(deps.emit ? { emit: deps.emit } : {}),
    });
  };
}

/** The goal Claude Code receives: the pack first, then the task. */
export function goalWithContextPack(goal: string, pack: Pick<ContextPack, 'prompt'> | null): string {
  if (!pack || !pack.prompt) return goal;
  return pack.prompt + '\n\nTask:\n' + goal;
}
