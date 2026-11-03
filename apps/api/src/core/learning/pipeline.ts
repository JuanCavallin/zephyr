/**
 * One learning pass: unprocessed signals → draft (normal model) → score (Jev) →
 * lifecycle. Runs in the background after a task finishes; it reports, it never throws,
 * so a failure here can never fail a task.
 */

import { draftCandidates, type DraftDeps, type RejectedDraft } from './draft.js';
import type { Lifecycle, LifecycleOutcome } from './lifecycle.js';
import type { ProfileStore } from './profileStore.js';
import { scoreCandidate, type LearningDecisions } from './score.js';

export interface LearningPassDeps extends DraftDeps {
  store: ProfileStore;
  decisions: LearningDecisions;
  lifecycle: Lifecycle;
}

export interface LearningPassResult {
  ok: boolean;
  error?: string;
  signals: number;
  outcomes: LifecycleOutcome[];
  rejected: RejectedDraft[];
  deferred: string[];
}

export async function runLearningPass(deps: LearningPassDeps): Promise<LearningPassResult> {
  let pending: ReturnType<LearningPassDeps['store']['signals']>;
  try {
    pending = deps.store.signals({ unprocessed: true });
  } catch (error) {
    return { ok: false, signals: 0, outcomes: [], rejected: [], deferred: [], error: (error as Error).message };
  }
  const empty = { signals: pending.length, outcomes: [], rejected: [], deferred: [] };
  if (pending.length === 0) return { ok: true, ...empty };
  try {
    const draft = await draftCandidates(pending, deps);
    if (!draft.ok) {
      deps.store.markProcessed(draft.processed);
      return { ...empty, ok: false, error: draft.error, deferred: draft.deferred };
    }
    const outcomes: LifecycleOutcome[] = [];
    for (const candidate of draft.candidates) {
      const score = await scoreCandidate(deps.decisions, deps.store, candidate, deps.signal ? { signal: deps.signal } : {});
      outcomes.push(deps.lifecycle.apply(candidate, score));
    }
    deps.store.markProcessed(draft.processed);
    return { ok: true, signals: pending.length, outcomes, rejected: draft.rejected, deferred: draft.deferred };
  } catch (error) {
    return { ...empty, ok: false, error: (error as Error).message };
  }
}
