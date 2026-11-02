/**
 * Step 5, lever L2: deterministic candidate selection for the context pack.
 *
 * From the task text and the repo index, score every file by cheap signals
 * (explicit path mention, symbol match, path-segment match, doc-word match),
 * then widen from the strongest "seed" files along imports, recent co-changes
 * and covering tests. The ranking is total (score desc, path asc), so the same
 * task over the same tree always yields the same candidates. This ranking is
 * also the fallback when Jev cannot score.
 */

import { posix } from 'node:path';
import { runGit, type IndexedFile, type RepoIndex } from './repoIndex.js';

export interface Candidate {
  path: string;
  /** Raw additive score from the signals below. */
  raw: number;
  /** raw / max raw over the candidates, in 0..1. */
  score: number;
  reasons: string[];
}

export const WEIGHTS = {
  pathMention: 10,
  symbol: 4,
  segment: 3,
  doc: 1,
  coChange: 2,
  importedBySeed: 2,
  importsSeed: 1,
  coveringTest: 3,
} as const;

export const MAX_CANDIDATES = 40;
/** Seeds for the graph signals need at least this, and at least half the top direct score. */
const SEED_MIN = WEIGHTS.segment;
const MAX_SEEDS = 8;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'make', 'new', 'no', 'not', 'of', 'on', 'or',
  'our', 'so', 'that', 'the', 'their', 'then', 'there', 'this', 'to', 'up', 'use', 'was', 'we',
  'when', 'where', 'which', 'will', 'with', 'you', 'add', 'fix', 'change', 'update', 'should',
  'file', 'files', 'code', 'test', 'tests', 'src', 'lib', 'index', 'ts', 'js', 'py', 'go',
]);

/** Split identifiers into lowercase words: `parseHTTPRequest_v2` -> parse, http, request, v2. */
export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export interface TaskTerms {
  /** Path-like mentions (`src/foo.ts`, `foo.py`). */
  paths: string[];
  /** Identifier-like tokens as written (`buildRepoIndex`, `snake_case`). */
  identifiers: Set<string>;
  /** Content words, lowercase, stopwords removed. */
  words: Set<string>;
}

export function taskTerms(task: string): TaskTerms {
  const paths = [...task.matchAll(/(?:[\w.@-]+\/)*[\w.-]+\.[A-Za-z]{1,5}\b/g)]
    .map((m) => m[0].replace(/^\.\//, ''))
    .filter((p) => /[A-Za-z]/.test(p.split('.').pop() ?? '') && !/^\d+\.\d+/.test(p));
  const identifiers = new Set(
    [...task.matchAll(/[A-Za-z_$][\w$]{2,}/g)].map((m) => m[0]).filter((w) => !STOPWORDS.has(w.toLowerCase())),
  );
  return { paths, identifiers, words: new Set(splitWords(task)) };
}

function pathMatches(file: string, mention: string): boolean {
  return file === mention || file.endsWith('/' + mention);
}

/** Resolve a relative import specifier to an indexed path, trying the usual extensions. */
function resolveImport(from: string, spec: string, paths: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.(m|c)?js$/, '');
  const tries = [
    base,
    ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.py'].map((e) => stem + e),
    ...['/index.ts', '/index.tsx', '/index.js', '/__init__.py'].map((e) => stem + e),
  ];
  return tries.find((p) => paths.has(p)) ?? null;
}

/** Python `from .foo import x` / `from pkg.mod import y` -> an indexed path. */
function resolvePythonImport(from: string, spec: string, paths: Set<string>): string | null {
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots).replace(/\./g, '/');
  let dir = dots > 0 ? posix.dirname(from) : '';
  for (let i = 1; i < dots; i += 1) dir = posix.dirname(dir);
  const base = posix.normalize(posix.join(dir || '.', rest));
  for (const p of [base + '.py', base + '/__init__.py']) if (paths.has(p)) return p;
  // Absolute imports in a src layout: match by suffix.
  if (dots === 0) for (const p of paths) if (p.endsWith('/' + rest + '.py')) return p;
  return null;
}

export function importsOf(file: IndexedFile, paths: Set<string>): string[] {
  const py = file.path.endsWith('.py');
  return file.imports
    .map((spec) => (py ? resolvePythonImport(file.path, spec, paths) : resolveImport(file.path, spec, paths)))
    .filter((p): p is string => p !== null && p !== file.path);
}

export function stemOf(path: string): string {
  return posix
    .basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/\.(test|spec)$/, '')
    .replace(/^test_|_test$/, '')
    .toLowerCase();
}

/** Commits touching more files than this are bulk changes (imports, renames, formatting): no signal. */
const MAX_COCHANGE_COMMIT_FILES = 12;

/**
 * Files changed in the same recent commits as a seed. Empty outside git.
 * `--full-diff` lists every file of a matching commit, not only the seeds. Root
 * commits and bulk commits are skipped: "added in the initial import" relates
 * every file to every other.
 */
async function coChanged(repo: RepoIndex, seeds: string[], limit = 30): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!repo.git || seeds.length === 0) return counts;
  const out = await runGit(repo.root, [
    'log', '-n', String(limit), '--no-merges', '--full-diff', '--name-only', '--format=%x00%P', '--', ...seeds,
  ]);
  if (!out) return counts;
  const seedSet = new Set(seeds);
  for (const commit of out.split('\0')) {
    const [parents = '', ...rest] = commit.split('\n');
    if (!parents.trim()) continue; // root commit (or the empty chunk before the first)
    const files = rest.map((l) => l.trim()).filter(Boolean);
    if (files.length > MAX_COCHANGE_COMMIT_FILES) continue;
    if (!files.some((f) => seedSet.has(f))) continue;
    for (const f of files) if (!seedSet.has(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

/**
 * Up to `max` candidates for `task`, ranked deterministically. Files with no
 * signal at all are never candidates: an empty list means "no pack".
 */
export async function selectCandidates(task: string, repo: RepoIndex, max = MAX_CANDIDATES): Promise<Candidate[]> {
  const terms = taskTerms(task);
  const lowerIds = new Set([...terms.identifiers].map((i) => i.toLowerCase()));
  const paths = new Set(repo.files.map((f) => f.path));
  const raw = new Map<string, number>();
  const reasons = new Map<string, string[]>();
  const add = (path: string, weight: number, reason: string) => {
    raw.set(path, (raw.get(path) ?? 0) + weight);
    const list = reasons.get(path) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(path, list);
  };

  for (const file of repo.files) {
    if (terms.paths.some((m) => pathMatches(file.path, m))) add(file.path, WEIGHTS.pathMention, 'path-mention');
    const syms = new Set([...file.exports, ...file.symbols].map((s) => s.toLowerCase()));
    const symHits = [...lowerIds].filter((id) => syms.has(id));
    if (symHits.length > 0) add(file.path, WEIGHTS.symbol * Math.min(symHits.length, 3), 'symbol:' + symHits.slice(0, 3).join(','));
    const segs = new Set(splitWords(file.path.replace(/\.[^./]+$/, '')));
    const segHits = [...terms.words].filter((w) => segs.has(w));
    if (segHits.length > 0) add(file.path, WEIGHTS.segment * Math.min(segHits.length, 3), 'segment:' + segHits.slice(0, 3).join(','));
    if (file.doc) {
      const docWords = new Set(splitWords(file.doc));
      const docHits = [...terms.words].filter((w) => docWords.has(w));
      if (docHits.length > 0) add(file.path, WEIGHTS.doc * Math.min(docHits.length, 3), 'doc');
    }
  }

  // Seeds are the strongest direct hits, not everything sharing a directory
  // word: a sibling that only matched `auth` should be reached through the
  // graph (imported-by, co-changed), not stand in for the file the task names.
  const topDirect = Math.max(0, ...raw.values());
  const seedMin = Math.max(SEED_MIN, topDirect / 2);
  const seeds = [...raw.entries()]
    .filter(([, s]) => s >= seedMin)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEEDS)
    .map(([p]) => p);
  const seedSet = new Set(seeds);

  if (seeds.length > 0) {
    const byPath = new Map(repo.files.map((f) => [f.path, f]));
    const seedStems = new Set(seeds.filter((s) => !byPath.get(s)?.isTest).map(stemOf));
    for (const seed of seeds) {
      for (const dep of importsOf(byPath.get(seed)!, paths)) {
        if (!seedSet.has(dep)) add(dep, WEIGHTS.importedBySeed, 'imported-by:' + seed);
      }
    }
    for (const file of repo.files) {
      if (seedSet.has(file.path)) continue;
      const deps = importsOf(file, paths);
      const importsASeed = deps.some((d) => seedSet.has(d));
      if (importsASeed) add(file.path, WEIGHTS.importsSeed, 'imports-seed');
      if (file.isTest && (seedStems.has(stemOf(file.path)) || importsASeed)) add(file.path, WEIGHTS.coveringTest, 'covering-test');
    }
    for (const [path, n] of await coChanged(repo, seeds)) {
      if (paths.has(path) && !seedSet.has(path)) add(path, WEIGHTS.coChange * Math.min(n, 2), 'co-changed');
    }
  }

  const ranked = [...raw.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
  const top = ranked[0]?.[1] ?? 0;
  return ranked.map(([path, r]) => ({ path, raw: r, score: top > 0 ? r / top : 0, reasons: reasons.get(path) ?? [] }));
}
