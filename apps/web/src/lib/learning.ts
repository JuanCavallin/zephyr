/**
 * "What Zephyr learned" (docs/cacp-08-learning-loop.md). Pure: the page feeds it the
 * GET /api/learning feed and renders what these helpers say. The shapes mirror the API's
 * profile store; they are not in @htn/shared because nothing else reads them.
 */

import type { Task } from '@htn/shared';

export type EntryKind = 'pref' | 'skill';
export type EntryStatus = 'candidate' | 'active' | 'retired';
export type LearningScope = 'personal' | 'project';

export interface LearnedEntry {
  id: string;
  kind: EntryKind;
  scope: LearningScope;
  status: EntryStatus;
  /** 0..1, how well the evidence supports the entry. */
  confidence: number;
  version: number;
  evidence: string[];
  /** The preference statement, or the skill's one-line description. */
  text: string;
  skill?: { name: string; description: string; body: string };
  autoActivate: boolean;
  /** Who decided the latest score. */
  source: 'jev' | 'fallback';
  private?: boolean;
  retiredReason?: string;
  reverted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FeedEvidence {
  id: string;
  kind: string;
  summary: string;
  at: string;
  taskId?: string;
  private: boolean;
}

export interface SkillArm {
  skillId: string;
  version: number;
  passed: number;
  failed: number;
  passRate: number | null;
}

export interface FeedItem {
  entry: LearnedEntry;
  evidence: FeedEvidence[];
  versions: { version: number; at: string; reason: string }[];
  arms?: SkillArm[];
}

export interface LearningPassResult {
  ok: boolean;
  error?: string;
  signals: number;
  outcomes: unknown[];
  rejected: unknown[];
  deferred: string[];
}

export interface ProjectProposal {
  branch: string;
  commit: string;
  files: { path: string }[];
  refused: { id: string; reason: string }[];
}

/** What a person can do to an entry right now. Mirrors the API's lifecycle rules. */
export interface EntryActions {
  revert: boolean;
  accept: boolean;
  /** Personal to project. Never for entries learned from private signals. */
  promote: boolean;
  /** Write project knowledge to a local branch. Active, project, non-private only. */
  propose: boolean;
  /** Versions that can be restored: every one except the current. */
  restorable: number[];
}

export function entryActions(item: FeedItem): EntryActions {
  const e = item.entry;
  return {
    revert: e.status !== 'retired',
    accept: e.status !== 'active',
    promote: e.scope === 'personal' && !e.private,
    propose: e.scope === 'project' && e.status === 'active' && !e.private,
    restorable: item.versions.map((v) => v.version).filter((v) => v !== e.version),
  };
}

export function confidenceLabel(confidence: number): 'strong' | 'moderate' | 'weak' {
  if (confidence >= 0.8) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

export function percent(n: number): string {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) + '%';
}

export interface FeedGroups {
  active: FeedItem[];
  candidate: FeedItem[];
  retired: FeedItem[];
}

/** Active first, then candidates waiting on a person, then retired; newest change first in each. */
export function groupFeed(items: FeedItem[]): FeedGroups {
  const groups: FeedGroups = { active: [], candidate: [], retired: [] };
  for (const item of items) groups[item.entry.status].push(item);
  const newest = (a: FeedItem, b: FeedItem) => b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  groups.active.sort(newest);
  groups.candidate.sort(newest);
  groups.retired.sort(newest);
  return groups;
}

/** "v2: 3 of 4 runs passed (75%)", newest version first; versions with no finished run say so. */
export function armSummary(arms: SkillArm[] | undefined): string[] {
  if (!arms?.length) return [];
  return [...arms]
    .sort((a, b) => b.version - a.version)
    .map((a) => {
      const total = a.passed + a.failed;
      if (a.passRate === null || total === 0) return `v${a.version}: no finished runs yet`;
      return `v${a.version}: ${a.passed} of ${total} runs passed (${percent(a.passRate)})`;
    });
}

/** Only finished tasks are rated: a thumbs-up on a running task says nothing yet. */
export function canRate(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done' || task.status === 'failed';
}

/**
 * Where a rating came from. The client says private when it knows; the server decides
 * anyway, so a missing flag cannot leak a private board's feedback.
 */
export function feedbackOrigin(task: Pick<Task, 'id' | 'runId'>, boardPrivate: boolean) {
  return {
    taskId: task.id,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(boardPrivate ? { private: true } : {}),
  };
}

export interface Variant {
  id: string;
  /** What the variant is, in a few words: this is what the learner reads. */
  label: string;
  /** Optional preview shown to the person; never sent. */
  preview?: string;
}

const LABEL_MAX = 200;
const clip = (s: string) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + '…' : s);

/**
 * The variant-pick signal body for choosing `chosenId` out of `variants`, or null when
 * there is nothing to learn: no such variant, or nothing rejected.
 */
export function variantPickBody(
  variants: Variant[],
  chosenId: string,
  origin: { taskId?: string; runId?: string; private?: boolean } = {},
) {
  const chosen = variants.find((v) => v.id === chosenId);
  const rejected = variants.filter((v) => v.id !== chosenId).map((v) => clip(v.label.trim())).filter(Boolean);
  if (!chosen || !chosen.label.trim() || rejected.length === 0) return null;
  return { chosen: clip(chosen.label.trim()), rejected: rejected.slice(0, 20), ...origin };
}

/** A board run is private when it was created with `private: true` (its input says so). */
export function runIsPrivate(run: { input?: unknown } | null | undefined): boolean {
  const input = run?.input;
  return typeof input === 'object' && input !== null && (input as { private?: unknown }).private === true;
}
