/**
 * Step 8 lifecycle (spec §11): confidence rises with evidence, an entry activates above a
 * threshold, a contradiction retires it, and every change is a new version with
 * one-click revert.
 *
 * Rules that keep the fallback and the user in charge:
 *   - only a Jev score can push an entry across the threshold (`autoActivate`);
 *     fallback-scored entries wait as candidates until a person accepts them;
 *   - a reverted entry is never re-activated automatically, whatever new evidence says;
 *   - the guardrails run again before any entry is written, so nothing that weakens a
 *     check or widens a grant becomes active by any path.
 */

import type { RunEvent } from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { DraftCandidate } from './draft.js';
import { checkLearnedContent, learnedText } from './guardrails.js';
import type { LearnedEntry, ProfileStore } from './profileStore.js';
import { toPreference } from './profileStore.js';
import type { CandidateScore } from './score.js';
import { LEARNING_RUN_ID } from './signalLog.js';

export const ACTIVATION_THRESHOLD = 0.7;
/** A contradiction at least this well supported retires the old entry outright. */
export const RETIRE_ON_CONTRADICTION = 0.5;

export type LifecycleChange = 'created' | 'reinforced' | 'activated' | 'weakened' | 'retired' | 'rejected';

export interface LifecycleOutcome {
  /** The entry this candidate created or reinforced; absent when rejected. */
  entry?: LearnedEntry;
  changes: { id: string; change: LifecycleChange; reason: string }[];
}

export interface LifecycleDeps {
  store: ProfileStore;
  emit?(runId: string, event: RunEvent): unknown;
  now?: () => string;
}

/** Evidence compounds: each supporting signal closes part of the remaining gap. */
export function reinforce(confidence: number, support: number): number {
  return Math.min(0.99, 1 - (1 - confidence) * (1 - support * 0.5));
}

function shouldActivate(e: LearnedEntry): boolean {
  return e.status === 'candidate' && e.autoActivate && !e.reverted && e.confidence >= ACTIVATION_THRESHOLD;
}

export class Lifecycle {
  private readonly now: () => string;

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? nowIso;
  }

  /** Apply one scored candidate. */
  apply(candidate: DraftCandidate, score: CandidateScore): LifecycleOutcome {
    const changes: LifecycleOutcome['changes'] = [];
    const verdict = checkLearnedContent(learnedText({ text: candidate.text, ...(candidate.skill ? { skill: candidate.skill } : {}) }));
    if (!verdict.ok) {
      return { changes: [{ id: '-', change: 'rejected', reason: 'guardrail: ' + verdict.reasons.join(', ') }] };
    }
    const existing = score.entryId ? this.deps.store.entry(score.entryId) : undefined;

    if (score.relation === 'duplicate' && existing && existing.status !== 'retired') {
      const next: LearnedEntry = {
        ...existing,
        evidence: [...new Set([...existing.evidence, ...candidate.evidence])],
        confidence: reinforce(existing.confidence, score.support),
        autoActivate: existing.autoActivate || score.autoActivate,
        source: score.source,
        private: Boolean(existing.private || candidate.private),
        version: existing.version + 1,
        updatedAt: this.now(),
      };
      const activated = shouldActivate(next);
      if (activated) next.status = 'active';
      this.put(next, activated ? 'reinforced and activated' : 'reinforced by new evidence');
      changes.push({ id: next.id, change: activated ? 'activated' : 'reinforced', reason: 'duplicate evidence' });
      return { entry: next, changes };
    }

    if (score.relation === 'contradicts' && existing && existing.status !== 'retired') {
      if (score.support >= RETIRE_ON_CONTRADICTION) {
        this.retire(existing, 'contradicted by newer evidence');
        changes.push({ id: existing.id, change: 'retired', reason: 'contradicted' });
      } else {
        const weakened: LearnedEntry = {
          ...existing,
          confidence: existing.confidence * (1 - score.support),
          version: existing.version + 1,
          updatedAt: this.now(),
        };
        if (weakened.status === 'active' && weakened.confidence < ACTIVATION_THRESHOLD) weakened.status = 'candidate';
        this.put(weakened, 'weakened by contradicting evidence');
        changes.push({ id: existing.id, change: 'weakened', reason: 'contradicted, weakly' });
      }
    }

    // New, a contradiction (the newer view is stored too), or a stale entry id.
    const at = this.now();
    const entry: LearnedEntry = {
      id: newId(candidate.kind === 'skill' ? 'skill' : 'pref'),
      kind: candidate.kind,
      scope: candidate.scope,
      status: 'candidate',
      confidence: score.source === 'jev' ? score.support : Math.min(score.support, ACTIVATION_THRESHOLD - 0.01),
      version: 1,
      evidence: candidate.evidence,
      text: candidate.text,
      ...(candidate.skill ? { skill: candidate.skill } : {}),
      autoActivate: score.autoActivate,
      source: score.source,
      ...(candidate.private ? { private: true } : {}),
      createdAt: at,
      updatedAt: at,
    };
    const activated = shouldActivate(entry);
    if (activated) entry.status = 'active';
    this.put(entry, activated ? 'drafted and activated' : 'drafted');
    this.emitCandidate(entry, score);
    changes.push({ id: entry.id, change: activated ? 'activated' : 'created', reason: score.relation });
    return { entry, changes };
  }

  /** One-click revert: off now, and never back on unless the user restores it. */
  revert(id: string): LearnedEntry {
    const e = this.must(id);
    return this.retire(e, 'reverted by the user', true);
  }

  /** Roll an entry back to an earlier version's content, as a new version. */
  restore(id: string, version: number): LearnedEntry {
    const current = this.must(id);
    const old = this.deps.store.versions(id).find((v) => v.version === version);
    if (!old) throw new Error(`${id} has no version ${version}`);
    const next: LearnedEntry = { ...old.entry, version: current.version + 1, updatedAt: this.now() };
    delete next.reverted;
    delete next.retiredReason;
    this.put(next, 'restored version ' + version);
    if (next.status === 'active') this.emitActivated(next);
    return next;
  }

  /** A person accepts a candidate: active regardless of the threshold. */
  accept(id: string): LearnedEntry {
    const e = this.must(id);
    const next: LearnedEntry = { ...e, status: 'active', version: e.version + 1, updatedAt: this.now() };
    delete next.reverted;
    delete next.retiredReason;
    this.put(next, 'accepted by the user');
    return next;
  }

  /**
   * Personal → project: the only way personal taste reaches the repo. Private entries
   * cannot be promoted; their evidence must stay on this machine.
   */
  promote(id: string): LearnedEntry {
    const e = this.must(id);
    if (e.private) throw new Error(id + ' was learned from private signals and cannot be promoted');
    if (e.scope === 'project') return e;
    const next: LearnedEntry = { ...e, scope: 'project', version: e.version + 1, updatedAt: this.now() };
    this.put(next, 'promoted to project');
    return next;
  }

  /** Step 9's demotion: a skill whose runs pass less often goes back to candidate. */
  demote(id: string, reason: string): LearnedEntry {
    const e = this.must(id);
    const next: LearnedEntry = { ...e, status: 'candidate', autoActivate: false, version: e.version + 1, updatedAt: this.now() };
    this.put(next, 'demoted: ' + reason);
    return next;
  }

  private retire(e: LearnedEntry, reason: string, reverted = false): LearnedEntry {
    const next: LearnedEntry = {
      ...e,
      status: 'retired',
      retiredReason: reason,
      ...(reverted ? { reverted: true } : {}),
      version: e.version + 1,
      updatedAt: this.now(),
    };
    this.deps.store.putEntry(next, reason);
    this.emit({ type: 'learning.retired', entry: entryKind(next), id: next.id, reason, at: next.updatedAt });
    return next;
  }

  private put(e: LearnedEntry, reason: string): void {
    const verdict = checkLearnedContent(learnedText(e));
    if (!verdict.ok) throw new Error(`${e.id}: guardrail ${verdict.reasons.join(', ')}`);
    const prev = this.deps.store.entry(e.id);
    this.deps.store.putEntry(e, reason);
    if (e.status === 'active' && prev?.status !== 'active') this.emitActivated(e);
  }

  private must(id: string): LearnedEntry {
    const e = this.deps.store.entry(id);
    if (!e) throw new Error('no learned entry ' + id);
    return e;
  }

  private emitActivated(e: LearnedEntry): void {
    this.emit({ type: 'learning.activated', entry: entryKind(e), id: e.id, version: e.version, at: e.updatedAt });
  }

  private emitCandidate(e: LearnedEntry, score: CandidateScore): void {
    if (e.kind === 'pref') {
      this.emit({ type: 'learning.candidate', candidate: { kind: 'preference', preference: toPreference(e) } });
      return;
    }
    const skill = e.skill!;
    this.emit({
      type: 'learning.candidate',
      candidate: {
        kind: 'skill',
        proposal: {
          id: e.id,
          scope: e.scope,
          action: 'create',
          name: skill.name,
          description: skill.description,
          body: skill.body,
          evidence: e.evidence,
          support: score.support,
          relation: score.entryId && score.relation !== 'new' ? { kind: score.relation, of: score.entryId } : { kind: 'new' },
          createdAt: e.createdAt,
        },
      },
    });
  }

  private emit(event: RunEvent): void {
    try {
      void this.deps.emit?.(LEARNING_RUN_ID, event);
    } catch {
      // The feed is best effort; the profile is the record.
    }
  }
}

function entryKind(e: LearnedEntry): 'preference' | 'skill' {
  return e.kind === 'skill' ? 'skill' : 'preference';
}
