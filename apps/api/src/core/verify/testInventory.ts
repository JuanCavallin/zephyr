/**
 * Test inventory (step 6): which tests exist, which runner owns each, and which source
 * files each one exercises.
 *
 * Discovery is by file pattern per runner. Coverage comes from the policy's coverage
 * map when it names a source; otherwise from the import graph (transitive, bounded)
 * plus a name heuristic (`foo.test.ts` / `test_foo.py` cover `foo.*`).
 *
 * Pure over a RepoIndex, so it runs offline against a fixture; `buildTestInventory`
 * is the filesystem entry point.
 */

import { posix } from 'node:path';
import type { VerifyPolicy } from '@htn/shared';
import { importsOf, stemOf } from '../context/candidates.js';
import { buildRepoIndex, type IndexedFile, type RepoIndex } from '../context/repoIndex.js';

export interface TestRunnerSpec {
  id: string;
  /** Matches a repo path that is a test file for this runner. */
  pattern: RegExp;
}

export const DEFAULT_RUNNERS: readonly TestRunnerSpec[] = Object.freeze([
  { id: 'js', pattern: /\.(test|spec)\.[cm]?[jt]sx?$/ },
  { id: 'pytest', pattern: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/ },
  { id: 'go', pattern: /_test\.go$/ },
]);

export type CoverageSource = 'coverage' | 'import' | 'heuristic';

export interface InventoryTest {
  /** The test file's repo path; also its id in selection and evidence. */
  id: string;
  runner: string;
  covers: { path: string; via: CoverageSource }[];
}

export interface TestInventory {
  runners: string[];
  tests: InventoryTest[];
  /** Whether a coverage map contributed. */
  coverageMap: boolean;
}

/** How many import hops a test may reach through. Deep enough for helper layers. */
const IMPORT_DEPTH = 4;

export function runnerFor(path: string, runners: readonly TestRunnerSpec[] = DEFAULT_RUNNERS): string | null {
  return runners.find((r) => r.pattern.test(path))?.id ?? null;
}

export function inventoryFromIndex(
  repo: Pick<RepoIndex, 'files'>,
  policy: Pick<VerifyPolicy, 'coverageMap'>,
  runners: readonly TestRunnerSpec[] = DEFAULT_RUNNERS,
): TestInventory {
  const paths = new Set(repo.files.map((f) => f.path));
  const byPath = new Map(repo.files.map((f) => [f.path, f] as const));
  const edges = new Map<string, string[]>();
  const edgesOf = (file: IndexedFile): string[] => {
    let e = edges.get(file.path);
    if (!e) edges.set(file.path, (e = importsOf(file, paths)));
    return e;
  };
  const sourcesByStem = new Map<string, string[]>();
  for (const f of repo.files) {
    if (runnerFor(f.path, runners) || f.isTest) continue;
    const s = stemOf(f.path);
    sourcesByStem.set(s, [...(sourcesByStem.get(s) ?? []), f.path]);
  }

  const map = policy.coverageMap;
  const mapped = new Set(Object.keys(map ?? {}));
  const tests: InventoryTest[] = [];

  for (const file of repo.files) {
    const runner = runnerFor(file.path, runners);
    if (!runner) continue;
    const covers = new Map<string, CoverageSource>();
    const add = (path: string, via: CoverageSource) => {
      // A source the coverage map names is covered only per the map.
      if (via !== 'coverage' && mapped.has(path)) return;
      if (path !== file.path && !covers.has(path)) covers.set(path, via);
    };

    for (const [source, ids] of Object.entries(map ?? {})) if (ids.includes(file.path)) add(source, 'coverage');

    // Import graph, breadth first, bounded.
    let frontier = [file.path];
    const seen = new Set(frontier);
    for (let depth = 0; depth < IMPORT_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const p of frontier) {
        const f = byPath.get(p);
        if (!f) continue;
        for (const dep of edgesOf(f)) {
          if (seen.has(dep)) continue;
          seen.add(dep);
          if (!runnerFor(dep, runners)) add(dep, 'import');
          next.push(dep);
        }
      }
      frontier = next;
    }

    // Name heuristic: same stem, preferring the nearest directory.
    const stem = stemOf(file.path);
    const same = (sourcesByStem.get(stem) ?? []).sort(
      (a, b) => distance(file.path, a) - distance(file.path, b) || a.localeCompare(b),
    );
    if (same[0]) add(same[0], 'heuristic');

    tests.push({
      id: file.path,
      runner,
      covers: [...covers].map(([path, via]) => ({ path, via })).sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  tests.sort((a, b) => a.id.localeCompare(b.id));
  return {
    runners: [...new Set(tests.map((t) => t.runner))].sort(),
    tests,
    coverageMap: mapped.size > 0,
  };
}

/** Directory hops between two repo paths' parent directories. */
function distance(a: string, b: string): number {
  const da = posix.dirname(a).split('/');
  const db = posix.dirname(b).split('/');
  let common = 0;
  while (common < da.length && common < db.length && da[common] === db[common]) common += 1;
  return da.length - common + (db.length - common);
}

export async function buildTestInventory(
  root: string,
  policy: Pick<VerifyPolicy, 'coverageMap'>,
  runners?: readonly TestRunnerSpec[],
): Promise<TestInventory> {
  return inventoryFromIndex(await buildRepoIndex(root), policy, runners);
}
