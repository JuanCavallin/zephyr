/**
 * Step 8 scoring (spec §11): Jev, never a prompt. One request per drafted candidate asks
 * a `probability` that the evidence supports it and a `choice` against the existing
 * entries (new / duplicate of #k / contradicts #k). The decision service owns the
 * fallback: new, low support, never auto-activated.
 *
 * Privacy: a private candidate is scored with remote-ineligible state, so a live Jev
 * falls back instead of seeing it; a non-private candidate is only ever compared with
 * non-private entries, so no private entry text reaches a remote model either.
 */

import type { LearningCandidateInput, LearningCandidateScore, LearningEntryInput, ProviderCallContext } from '@htn/shared';
import type { DecisionService } from '../decisions/service.js';
import type { DraftCandidate } from './draft.js';
import type { LearnedEntry, ProfileStore } from './profileStore.js';
import { describeSignal, LEARNING_RUN_ID } from './signalLog.js';

export const LEARNING_SCORE_POLICY_RULE = 'learning-score';
/** Existing entries offered to Jev per candidate. */
export const MAX_ENTRIES_PER_SCORE = 12;

export type LearningDecisions = Pick<DecisionService, 'scoreLearningCandidate' | 'scoreKnowledge'>;

export type CandidateScore = LearningCandidateScore & { autoActivate: boolean; source: 'jev' | 'fallback' };

/** Eligibility for a remote decision model: private data never is. */
export function learningEligibility(isPrivate: boolean) {
  return isPrivate
    ? { sanitizedForRemote: false, dataLabels: ['private' as const] }
    : { sanitizedForRemote: true, dataLabels: ['public' as const] };
}

export function entryInput(e: LearnedEntry): LearningEntryInput {
  return { id: e.id, kind: e.kind, scope: e.scope, text: e.skill ? e.skill.name + ': ' + e.skill.description : e.text };
}

/** Entries a candidate may be compared with: same kind, live, and privacy-compatible. */
export function comparableEntries(store: ProfileStore, candidate: DraftCandidate): LearnedEntry[] {
  return store
    .entries({ status: ['candidate', 'active'], kind: candidate.kind })
    .filter((e) => candidate.private || !e.private)
    .slice(0, MAX_ENTRIES_PER_SCORE);
}

export async function scoreCandidate(
  decisions: LearningDecisions,
  store: ProfileStore,
  candidate: DraftCandidate,
  ctx: Partial<ProviderCallContext> = {},
): Promise<CandidateScore> {
  const evidence = candidate.evidence
    .map((id) => store.signal(id))
    .filter((s) => s !== undefined)
    .map((s) => describeSignal(s.signal));
  const input: LearningCandidateInput = {
    candidate: { kind: candidate.kind, text: candidate.skill ? candidate.skill.name + ': ' + candidate.text : candidate.text },
    evidence,
    entries: comparableEntries(store, candidate).map(entryInput),
  };
  return decisions.scoreLearningCandidate(learningEligibility(candidate.private), input, {
    runId: LEARNING_RUN_ID,
    policyRule: LEARNING_SCORE_POLICY_RULE,
    ...ctx,
  });
}
