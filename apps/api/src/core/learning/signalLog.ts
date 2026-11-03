/**
 * Step 8 signal capture and the signal log (spec §11 "Signals, strongest first").
 *
 *   1. user_edit         the diff between the agent's output and what got merged;
 *   2. variant_pick      which of several variants the user kept;
 *   3. approval          a rejected or revised merge approval, with its reason;
 *   4. revert            the user reverted an agent commit;
 *   5. explicit_feedback thumbs up/down on a card;
 *   6. request_wording   how the user phrased the request.
 *
 * The builders here are pure. `SignalLog` persists a signal to the profile, announces it
 * as `learning.signal`, and wakes the learning pipeline, never blocking the caller on it.
 */

import { createHash } from 'node:crypto';
import {
  preferenceSignalSchema,
  toRepoPath,
  type LearningScope,
  type PreferenceSignal,
  type RunEvent,
  type SignalSeam,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { ProfileStore } from './profileStore.js';

/** Diff text kept as evidence is cut to this many characters. */
export const MAX_DIFF_DETAIL = 12_000;

/** Run id that learning events are emitted under when a signal has no run. */
export const LEARNING_RUN_ID = 'learning';

export interface EditDiff {
  /** Files whose content differs, normalized repo paths, sorted. */
  files: string[];
  /** A compact unified-style diff, CRLF normalized. */
  diff: string;
  /** `sha256:<hex>` of `diff`. */
  diffHash: string;
}

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

/** A repo-relative path, or the slash-normalized input when it is not one. */
const repoPath = (p: string): string => toRepoPath(p) ?? p.replace(/\\/g, '/');

function lines(text: string): string[] {
  const out = normalize(text).split('\n');
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Above this many cells the line diff is skipped and the file shown as replaced. */
const LCS_CELL_LIMIT = 4_000_000;

/** `-`/`+`/` ` lines between two texts (LCS), with one line of context around changes. */
function lineDiff(before: string[], after: string[]): string[] {
  const n = before.length;
  const m = after.length;
  if (n * m > LCS_CELL_LIMIT) return [...before.map((l) => '-' + l), ...after.map((l) => '+' + l)];
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push(' ' + before[i]);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push('+' + after[j]);
      j++;
    } else {
      ops.push('-' + before[i]);
      i++;
    }
  }
  const keep = ops.map((op, k) => op[0] !== ' ' || ops[k - 1]?.[0] === '-' || ops[k - 1]?.[0] === '+' || ops[k + 1]?.[0] === '-' || ops[k + 1]?.[0] === '+');
  const out: string[] = [];
  ops.forEach((op, k) => {
    if (keep[k]) out.push(op);
    else if (keep[k - 1]) out.push('@@');
  });
  return out;
}

function hashOf(diff: string): string {
  return 'sha256:' + createHash('sha256').update(diff).digest('hex');
}

/**
 * The edit between the agent's output and the merged result, file by file. Paths are
 * normalized; line endings are ignored, so a Windows checkout is not an "edit". `null`
 * when nothing differs.
 */
export function editDiff(agent: Record<string, string>, merged: Record<string, string>): EditDiff | null {
  const norm = (files: Record<string, string>) =>
    new Map(Object.entries(files).map(([p, text]) => [repoPath(p), normalize(text)]));
  const a = norm(agent);
  const b = norm(merged);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const files: string[] = [];
  const parts: string[] = [];
  for (const path of paths) {
    const before = a.get(path);
    const after = b.get(path);
    if (before === after) continue;
    files.push(path);
    parts.push(
      `--- ${before === undefined ? '/dev/null' : 'a/' + path}\n+++ ${after === undefined ? '/dev/null' : 'b/' + path}`,
      ...lineDiff(before === undefined ? [] : lines(before), after === undefined ? [] : lines(after)),
    );
  }
  if (files.length === 0) return null;
  const diff = parts.join('\n') + '\n';
  return { files, diff, diffHash: hashOf(diff) };
}

/** The same, from `git diff <agent> <merged>` output. `null` for an empty diff. */
export function editDiffFromGit(gitDiff: string): EditDiff | null {
  const diff = normalize(gitDiff);
  if (!diff.trim()) return null;
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) files.add(repoPath(header[2]!));
  }
  if (files.size === 0) return null;
  // The `index <sha>..<sha>` lines name blobs, not content; drop them so equal edits hash equal.
  const stable = diff
    .split('\n')
    .filter((l) => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l))
    .join('\n');
  return { files: [...files].sort(), diff: stable, diffHash: hashOf(stable) };
}

export interface SignalOrigin {
  taskId?: string;
  runId?: string;
  scope?: LearningScope;
  private?: boolean;
  at?: string;
}

function base(o: SignalOrigin) {
  return {
    id: newId('sig'),
    ...(o.taskId ? { taskId: o.taskId } : {}),
    ...(o.runId ? { runId: o.runId } : {}),
    scope: o.scope ?? 'personal',
    private: o.private ?? false,
    at: o.at ?? nowIso(),
  };
}

export function userEditSignal(edit: EditDiff, o: SignalOrigin = {}): PreferenceSignal {
  return preferenceSignalSchema.parse({ ...base(o), kind: 'user_edit', diffHash: edit.diffHash, files: edit.files });
}

export function variantPickSignal(chosen: string, rejected: string[], o: SignalOrigin = {}): PreferenceSignal {
  return preferenceSignalSchema.parse({ ...base(o), kind: 'variant_pick', chosen, rejected });
}

export function feedbackSignal(rating: 'up' | 'down', comment: string | undefined, o: SignalOrigin = {}): PreferenceSignal {
  return preferenceSignalSchema.parse({
    ...base(o),
    kind: 'explicit_feedback',
    rating,
    ...(comment?.trim() ? { comment: comment.trim() } : {}),
  });
}

export function requestWordingSignal(text: string, o: SignalOrigin = {}): PreferenceSignal {
  return preferenceSignalSchema.parse({ ...base(o), kind: 'request_wording', text: text.trim() });
}

/** Strength of a signal kind, strongest first (spec §11): 6 for an edit down to 1. */
export const SIGNAL_STRENGTH: Record<PreferenceSignal['kind'], number> = {
  user_edit: 6,
  variant_pick: 5,
  approval: 4,
  revert: 3,
  explicit_feedback: 2,
  request_wording: 1,
};

/** One-line, human-readable summary of a signal, for the drafter and the feed. */
export function describeSignal(s: PreferenceSignal): string {
  switch (s.kind) {
    case 'user_edit':
      return `The user edited the agent's diff in ${s.files.join(', ')} before merging.`;
    case 'variant_pick':
      return `The user picked variant ${s.chosen} over ${s.rejected.join(', ')}.`;
    case 'approval':
      return `The user ${s.outcome} a merge${s.comment ? ': "' + s.comment + '"' : '.'}`;
    case 'revert':
      return `The user reverted agent commit ${s.commit.slice(0, 12)}.`;
    case 'explicit_feedback':
      return `The user gave a thumbs ${s.rating}${s.comment ? ': "' + s.comment + '"' : '.'}`;
    case 'request_wording':
      return `The user asked: "${s.text}"`;
  }
}

export interface SignalLogDeps {
  store: ProfileStore;
  emit?(runId: string, event: RunEvent): unknown;
  /** Called after a signal is stored; its errors and promise are not the caller's problem. */
  onSignal?(s: PreferenceSignal): unknown;
  onError?(error: unknown): void;
}

/** The step 1 `SignalSeam`, backed by the profile. */
export class SignalLog implements SignalSeam {
  constructor(private readonly deps: SignalLogDeps) {}

  async recordSignal(s: PreferenceSignal, evidence: { detail?: string } = {}): Promise<void> {
    const signal = preferenceSignalSchema.parse(s);
    const detail = evidence.detail && evidence.detail.length > MAX_DIFF_DETAIL
      ? evidence.detail.slice(0, MAX_DIFF_DETAIL) + '\n... (truncated)\n'
      : evidence.detail;
    await this.deps.store.recordSignal(signal, detail ? { detail } : {});
    try {
      await this.deps.emit?.(signal.runId ?? LEARNING_RUN_ID, { type: 'learning.signal', signal } as RunEvent);
    } catch (error) {
      this.deps.onError?.(error);
    }
    // Off the critical path: the pipeline runs later and its failures stay its own.
    if (this.deps.onSignal) {
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => this.deps.onSignal!(signal))
          .catch((error) => this.deps.onError?.(error));
      });
    }
  }
}
