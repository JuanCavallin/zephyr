/**
 * Test impact (step 6): which tests a diff should run.
 *
 * Candidates are tests the diff touches, tests whose covered files the diff
 * touches, and the policy's always-run tests. One Jev request scores every
 * candidate; tests under the threshold drop out, except always-run and changed
 * tests, which always run. When Jev is unavailable, ineligible or fails, every
 * candidate runs (`source: 'fallback'`): an unavailable Jev never shrinks the set.
 */

import { createHash } from 'node:crypto';
import type { SelectedTest, VerifyPolicy } from '@htn/shared';
import { matchesAny } from './glob.js';
import type { TestInventory } from './testInventory.js';

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffSummary {
  files: { path: string; status: DiffFileStatus; insertions: number; deletions: number }[];
  insertions: number;
  deletions: number;
  /** Hex sha256 of the patch text. */
  hash: string;
}

/** Parse a `git diff` patch into a per-file stat. Pure; tolerant of odd hunks. */
export function summarizePatch(patch: string): DiffSummary {
  const files: DiffSummary['files'] = [];
  let current: DiffSummary['files'][number] | undefined;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2]!, status: header[1] === header[2] ? 'modified' : 'renamed', insertions: 0, deletions: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) current.status = 'added';
      else if (line.startsWith('deleted file mode')) current.status = 'deleted';
      else if (line.startsWith('rename to ')) current.path = line.slice('rename to '.length);
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('+')) current.insertions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
  }
  return {
    files,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    hash: createHash('sha256').update(patch).digest('hex'),
  };
}

/** Scores candidate tests; null scores mean "run every candidate". */
export type TestScorer = (input: {
  task: string;
  changed: string[];
  tests: { id: string; summary: string }[];
}) => Promise<{ scores: Record<string, number> | null; reasonCodes: string[] }>;

export interface SelectTestsOptions {
  scorer?: TestScorer;
  task?: string;
  /** Jev scores below this drop a test. Default 0.34 (above "distant"). */
  threshold?: number;
}

export interface TestSelection {
  selected: SelectedTest[];
  source: 'jev' | 'fallback';
  /** Every candidate, before Jev's threshold, for the trace. */
  candidates: string[];
  reasonCodes: string[];
}

export async function selectTests(
  diff: Pick<DiffSummary, 'files'>,
  inventory: TestInventory,
  policy: Pick<VerifyPolicy, 'alwaysRun'>,
  options: SelectTestsOptions = {},
): Promise<TestSelection> {
  const changed = diff.files.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const touched = new Set(diff.files.map((f) => f.path));
  const pinned = new Set<string>();
  const candidates = inventory.tests.filter((test) => {
    const always = matchesAny(test.id, policy.alwaysRun);
    const direct = touched.has(test.id);
    if (always || direct) pinned.add(test.id);
    return always || direct || test.covers.some((c) => touched.has(c.path));
  });
  const ids = candidates.map((t) => t.id);
  const everything = (reasonCodes: string[]): TestSelection => ({
    selected: ids.map((id) => ({ id, fallback: true })),
    source: 'fallback',
    candidates: ids,
    reasonCodes,
  });
  if (candidates.length === 0) return { ...everything(['no-candidate-tests']), source: 'fallback' };
  if (!options.scorer) return everything(['no-test-scorer', 'run-every-candidate']);

  let result: Awaited<ReturnType<TestScorer>>;
  try {
    result = await options.scorer({
      task: options.task ?? '',
      changed,
      tests: candidates.map((t) => ({
        id: t.id,
        summary: `${t.runner}; covers ${t.covers.map((c) => c.path).join(', ') || 'nothing known'}`,
      })),
    });
  } catch {
    return everything(['test-scorer-threw', 'run-every-candidate']);
  }
  if (!result.scores) return everything(result.reasonCodes);

  const threshold = options.threshold ?? 0.34;
  const selected: SelectedTest[] = [];
  for (const id of ids) {
    const score = result.scores[id] ?? 0;
    if (score >= threshold || pinned.has(id)) selected.push({ id, score, fallback: false });
  }
  selected.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));
  return { selected, source: 'jev', candidates: ids, reasonCodes: result.reasonCodes };
}
