/**
 * Step 5, lever L2: the Jev-ranked context pack.
 *
 * 1. Deterministic candidates from the repo index (candidates.ts), at most 40.
 * 2. One Jev request scores every candidate (a `score` question per file, state =
 *    task + one-line summary per file). Jev never sees file contents.
 * 3. The top-K by Jev score, ties broken by the deterministic rank, become the
 *    pack. If Jev is unavailable, ineligible or fails, the deterministic rank is
 *    the pack and every pick says `source: 'fallback'`.
 * 4. The prompt is a compact map (path + summary) of the picks plus the full text
 *    of the first few that fit under the token cap.
 *
 * Packs are cached by (task hash, tree hash): the same task over the same tree
 * reuses the pack without a model call.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ControlDecisionRecord, RunEvent } from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import { MAX_CANDIDATES, selectCandidates, type Candidate } from './candidates.js';
import { fileSummary, type RepoIndex } from './repoIndex.js';

export type PackSource = 'jev' | 'fallback';

export interface ContextPackFile {
  path: string;
  /** Jev's relevance (0..1) when source is jev, else the normalized deterministic score. */
  score: number;
  source: PackSource;
  reasons: string[];
}

export interface ContextPack {
  files: ContextPackFile[];
  prompt: string;
  source: PackSource;
  /** Estimated prompt tokens (~4 chars per token). */
  tokens: number;
  cached: boolean;
  reasonCodes: string[];
}

/** Scores candidate files; null scores mean "use the deterministic rank". */
export type FileScorer = (input: {
  task: string;
  files: { path: string; summary: string }[];
}) => Promise<{ scores: Record<string, number> | null; reasonCodes: string[] }>;

export interface ContextPackOptions {
  /** Files in the pack. Default 8. */
  topK?: number;
  /** Candidates offered to the scorer. Default and hard maximum 40. */
  maxCandidates?: number;
  /** Prompt budget in estimated tokens. Default 6000. */
  tokenCap?: number;
  /** At most this many picks are inlined in full. Default 3. */
  fullFiles?: number;
  /** Jev scores below this drop a file from the pack. Default 0.2 ("unrelated" is 0). */
  minScore?: number;
  scorer?: FileScorer;
  /** Run to attribute `control.decided` events to; no events without it. */
  run?: { runId: string; stepId?: string };
  emit?: (runId: string, event: RunEvent) => Promise<unknown> | unknown;
  /** Replaces the module-level cache (tests). */
  cache?: Map<string, CachedPack>;
}

export interface CachedPack {
  files: ContextPackFile[];
  candidateIds: string[];
  prompt: string;
  source: PackSource;
  tokens: number;
  reasonCodes: string[];
}

const DEFAULT_TOP_K = 8;
const DEFAULT_TOKEN_CAP = 6000;
const DEFAULT_FULL_FILES = 3;
const DEFAULT_MIN_SCORE = 0.2;
const CACHE_LIMIT = 64;

const defaultCache = new Map<string, CachedPack>();

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function packCacheKey(task: string, treeHash: string): string {
  return createHash('sha256').update(task).digest('hex').slice(0, 24) + ':' + treeHash;
}

function rankWithScores(candidates: Candidate[], scores: Record<string, number>): ContextPackFile[] {
  const order = new Map(candidates.map((c, i) => [c.path, i]));
  return candidates
    .map((c) => ({ path: c.path, score: scores[c.path] ?? 0, source: 'jev' as const, reasons: c.reasons }))
    .sort((a, b) => b.score - a.score || order.get(a.path)! - order.get(b.path)!);
}

async function renderPrompt(
  repo: RepoIndex,
  files: ContextPackFile[],
  tokenCap: number,
  fullFiles: number,
): Promise<string> {
  if (files.length === 0) return '';
  const byPath = new Map(repo.files.map((f) => [f.path, f]));
  const header = 'Repository context, selected for this task (read other files as needed):';
  const lines: string[] = [header];
  let used = estimateTokens(header);
  for (const file of files) {
    const indexed = byPath.get(file.path);
    const summary = indexed ? fileSummary(indexed) : '';
    const line = '- ' + file.path + (summary ? ' — ' + summary : '');
    const cost = estimateTokens(line) + 1;
    if (used + cost > tokenCap) break;
    lines.push(line);
    used += cost;
  }
  let inlined = 0;
  for (const file of files) {
    if (inlined >= fullFiles) break;
    let text: string;
    try {
      text = await readFile(join(repo.root, file.path), 'utf8');
    } catch {
      continue;
    }
    const block = '\n--- ' + file.path + ' ---\n' + text.replace(/\s+$/, '') + '\n';
    const cost = estimateTokens(block);
    // A file that does not fit is skipped, not truncated: half a file misleads.
    if (used + cost > tokenCap) continue;
    lines.push(block);
    used += cost;
    inlined += 1;
  }
  return lines.join('\n');
}

async function emitPicks(
  opts: ContextPackOptions,
  candidates: string[],
  files: ContextPackFile[],
  reasonCodes: string[],
): Promise<void> {
  if (!opts.emit || !opts.run) return;
  const { runId, stepId } = opts.run;
  for (const file of files) {
    const decision: ControlDecisionRecord = {
      id: newId('ctl'),
      runId,
      ...(stepId ? { stepId } : {}),
      operation: 'select_context_files',
      candidateIds: candidates,
      selectedIds: [file.path],
      confidence: Math.max(0, Math.min(1, file.score)),
      reasonCodes: [...reasonCodes, ...file.reasons.slice(0, 4)],
      source: file.source,
      at: nowIso(),
    };
    try {
      await opts.emit(runId, { type: 'control.decided', decision });
    } catch {
      // Telemetry must never fail the task it describes.
    }
  }
}

/** Build (or reuse) the context pack for `task` over `repo`. Never throws on scorer failure. */
export async function buildContextPack(
  task: string,
  repo: RepoIndex,
  opts: ContextPackOptions = {},
): Promise<ContextPack> {
  const topK = Math.max(0, opts.topK ?? DEFAULT_TOP_K);
  const maxCandidates = Math.max(1, Math.min(opts.maxCandidates ?? MAX_CANDIDATES, MAX_CANDIDATES));
  const tokenCap = Math.max(0, opts.tokenCap ?? DEFAULT_TOKEN_CAP);
  const fullFiles = Math.max(0, opts.fullFiles ?? DEFAULT_FULL_FILES);
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const cache = opts.cache ?? defaultCache;
  const key = packCacheKey(task, repo.treeHash) + `:${topK}:${maxCandidates}:${tokenCap}:${fullFiles}`;

  const hit = cache.get(key);
  if (hit) {
    const reasonCodes = [...hit.reasonCodes.filter((c) => c !== 'context-pack-cache-hit'), 'context-pack-cache-hit'];
    await emitPicks(opts, hit.candidateIds, hit.files, reasonCodes);
    const { candidateIds: _ids, ...pack } = hit;
    return { ...pack, reasonCodes, cached: true };
  }

  const candidates = await selectCandidates(task, repo, maxCandidates);
  const candidateIds = candidates.map((c) => c.path);
  let files: ContextPackFile[];
  let source: PackSource;
  let reasonCodes: string[];

  if (candidates.length === 0) {
    files = [];
    source = 'fallback';
    reasonCodes = ['no-candidate-files'];
  } else {
    const byPath = new Map(repo.files.map((f) => [f.path, f]));
    const scored = opts.scorer
      ? await opts
          .scorer({
            task,
            files: candidates.map((c) => ({ path: c.path, summary: byPath.get(c.path) ? fileSummary(byPath.get(c.path)!) : '' })),
          })
          .catch((error: unknown) => ({
            scores: null,
            reasonCodes: ['context-scorer-threw:' + ((error as Error)?.message ?? 'unknown').slice(0, 80)],
          }))
      : { scores: null, reasonCodes: ['no-context-scorer'] };
    if (scored.scores) {
      source = 'jev';
      files = rankWithScores(candidates, scored.scores).filter((f) => f.score >= minScore).slice(0, topK);
      reasonCodes = scored.reasonCodes;
    } else {
      source = 'fallback';
      files = candidates
        .slice(0, topK)
        .map((c) => ({ path: c.path, score: c.score, source: 'fallback' as const, reasons: c.reasons }));
      reasonCodes = [...scored.reasonCodes.filter((c) => c !== 'deterministic-rank-fallback'), 'deterministic-rank-fallback'];
    }
  }

  const prompt = await renderPrompt(repo, files, tokenCap, fullFiles);
  const entry: CachedPack = { files, candidateIds, prompt, source, tokens: estimateTokens(prompt), reasonCodes };
  // A fallback pack is not cached: the next attempt may reach Jev.
  if (source === 'jev') {
    cache.set(key, entry);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  await emitPicks(opts, candidateIds, files, reasonCodes);
  const { candidateIds: _ids, ...pack } = entry;
  return { ...pack, cached: false };
}
