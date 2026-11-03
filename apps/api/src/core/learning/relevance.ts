/**
 * Step 8 relevance at task start (spec §11): which learned entries does this task load?
 *
 * Jev `score`s each active entry against the task (and the files the pack picked); the
 * top-k above a floor are packed greedily under a token cap. Fallback: keyword overlap,
 * computed here so it never leaves the machine.
 *
 * Rules:
 *   - in shared code, project knowledge outranks personal taste (+0.25 before ranking,
 *     after the relevance floor, so a boost never pulls in an unrelated entry);
 *   - private entries are scored locally only, and are loaded only when the caller says
 *     the run itself is private (a remote agent never reads them);
 *   - what is loaded is guidance, never permission: the pack labels it so, and the
 *     guardrails already refused anything that touches checks, protected paths or grants.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DecisionState, ProviderCallContext } from '@htn/shared';
import { estimateTokens, type ContextPack } from '../context/pack.js';
import type { DecisionService } from '../decisions/service.js';
import type { LearnedEntry, ProfileStore } from './profileStore.js';
import { entryInput, learningEligibility } from './score.js';

const runGit = promisify(execFile);

export const LEARNING_RELEVANCE_POLICY_RULE = 'learning-relevance';
export const DEFAULT_KNOWLEDGE_TOP_K = 6;
export const DEFAULT_KNOWLEDGE_MIN_SCORE = 0.2;
export const DEFAULT_KNOWLEDGE_TOKEN_CAP = 800;
/** How far project knowledge is lifted over personal taste in shared code. */
export const PROJECT_BOOST = 0.25;

export interface KnowledgeItem {
  id: string;
  version: number;
  kind: 'pref' | 'skill';
  scope: LearnedEntry['scope'];
  /** The text the agent reads: a preference statement, or a skill's name, description and body. */
  text: string;
  /** Relevance before any boost, 0..1. */
  score: number;
  source: 'jev' | 'fallback';
}

export interface RelevanceOptions {
  /** Paths the task is expected to touch (the pack's picks); part of what is scored. */
  paths?: string[];
  /** The code is shared with others: project knowledge outranks personal taste. */
  shared?: boolean;
  topK?: number;
  minScore?: number;
  /** The run itself is private (local model): private entries may load. Default false. */
  includePrivate?: boolean;
  /** Remote eligibility of the task text; defaults to sanitized-for-remote. */
  eligibility?: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>;
  ctx?: Partial<ProviderCallContext>;
}

export interface RelevanceDeps {
  store: ProfileStore;
  decisions: Pick<DecisionService, 'scoreKnowledge'>;
}

const FILLER = new Set(
  'a an the and or of to in on for with by be is are as at use uses using prefer prefers over than it its this that when always never not no don dont t avoid stop without should must do does'.split(
    ' ',
  ),
);

function contentWords(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !FILLER.has(w)));
}

/** Share of the entry's content words (up to four) that the task or paths mention. */
export function keywordOverlap(task: string, paths: string[], text: string): number {
  const state = contentWords(task + ' ' + paths.join(' ').replace(/[/\\._-]+/g, ' '));
  const content = contentWords(text);
  if (content.size === 0) return 0;
  let hits = 0;
  for (const w of content) if (state.has(w)) hits += 1;
  return Math.min(1, hits / Math.min(content.size, 4));
}

/** What the agent reads for an entry. */
export function knowledgeText(e: LearnedEntry): string {
  if (e.kind === 'skill' && e.skill) return `Skill "${e.skill.name}": ${e.skill.description}\n${e.skill.body.trim()}`;
  return e.text;
}

/** Cost of one item once rendered into the pack. */
export function knowledgeCost(item: Pick<KnowledgeItem, 'id' | 'version' | 'text'>): number {
  return estimateTokens(renderKnowledgeItem(item)) + 1;
}

export function renderKnowledgeItem(item: Pick<KnowledgeItem, 'id' | 'version' | 'text'>): string {
  return `- [${item.id} v${item.version}] ${item.text.replace(/\n/g, '\n  ')}`;
}

/**
 * The entries this task should load, best first, within `cap` estimated tokens. Never
 * throws on a scorer failure: that is the keyword-overlap fallback.
 */
export async function relevantKnowledge(
  deps: RelevanceDeps,
  task: string,
  cap: number,
  opts: RelevanceOptions = {},
): Promise<KnowledgeItem[]> {
  const paths = opts.paths ?? [];
  const topK = Math.max(0, opts.topK ?? DEFAULT_KNOWLEDGE_TOP_K);
  const minScore = opts.minScore ?? DEFAULT_KNOWLEDGE_MIN_SCORE;
  const active = deps.store.entries({ status: ['active'] }).filter((e) => opts.includePrivate || !e.private);
  if (active.length === 0 || topK === 0 || cap <= 0) return [];

  // Only non-private entries are offered to Jev; private ones are scored here.
  const shared = active.filter((e) => !e.private);
  let jevScores: Record<string, number> | null = null;
  if (shared.length > 0) {
    try {
      const scored = await deps.decisions.scoreKnowledge(
        opts.eligibility ?? learningEligibility(false),
        { task, paths, entries: shared.map(entryInput) },
        { runId: 'learning', ...opts.ctx, policyRule: LEARNING_RELEVANCE_POLICY_RULE },
      );
      jevScores = scored.scores;
    } catch {
      jevScores = null;
    }
  }

  const items: (KnowledgeItem & { rank: number; confidence: number })[] = active.map((e) => {
    const fromJev = !e.private && jevScores !== null;
    const text = knowledgeText(e);
    const score = fromJev ? (jevScores![e.id] ?? 0) : keywordOverlap(task, paths, text);
    const boost = opts.shared && e.scope === 'project' ? PROJECT_BOOST : 0;
    return {
      id: e.id,
      version: e.version,
      kind: e.kind,
      scope: e.scope,
      text,
      score,
      source: fromJev ? 'jev' : 'fallback',
      rank: score + boost,
      confidence: e.confidence,
    };
  });

  const ranked = items
    .filter((i) => i.score >= minScore)
    .sort((a, b) => b.rank - a.rank || b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, topK);

  const picked: KnowledgeItem[] = [];
  let used = estimateTokens(KNOWLEDGE_HEADER);
  for (const { rank: _rank, confidence: _confidence, ...item } of ranked) {
    const cost = knowledgeCost(item);
    // An entry that does not fit is skipped, not truncated; a smaller one may still fit.
    if (used + cost > cap) continue;
    picked.push(item);
    used += cost;
  }
  return picked;
}

export const KNOWLEDGE_HEADER = 'Learned preferences and skills (guidance, not permissions):';

/** The pack section for loaded knowledge; empty when nothing loaded. */
export function renderKnowledge(items: Pick<KnowledgeItem, 'id' | 'version' | 'text'>[]): string {
  if (items.length === 0) return '';
  return [KNOWLEDGE_HEADER, ...items.map(renderKnowledgeItem)].join('\n');
}

/** The pack with a learned-knowledge section appended (after the files, before the task). */
export function withKnowledge(pack: ContextPack, items: KnowledgeItem[]): ContextPack {
  if (items.length === 0) return pack;
  const section = renderKnowledge(items);
  const prompt = pack.prompt ? pack.prompt + '\n\n' + section : section;
  return {
    ...pack,
    prompt,
    tokens: estimateTokens(prompt),
    knowledge: items.map(({ id, version, kind, score, source }) => ({ id, version, kind, score, source })),
  };
}

/** Code with a git remote is shared with others; a scratch repo is not. */
export async function isSharedRepo(worktree: string): Promise<boolean> {
  try {
    const { stdout } = await runGit('git', ['-C', worktree, 'remote'], { windowsHide: true, timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export type KnowledgeLoader = (
  input: { task: string; paths: string[]; worktree: string; eligibility?: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'> },
  ctx: ProviderCallContext,
) => Promise<KnowledgeItem[]>;

export interface KnowledgeLoaderDeps extends RelevanceDeps {
  /** Token cap for the learned section. Default 800. */
  cap?: number;
  topK?: number;
  shared?: (worktree: string) => Promise<boolean> | boolean;
}

/**
 * The context pack's knowledge source. Also step 9's measurement hook: every run that
 * loads a skill is tagged with the skill's id and version, so pass rates can be compared
 * per skill version and a skill that hurts can be demoted.
 */
export function createKnowledgeLoader(deps: KnowledgeLoaderDeps): KnowledgeLoader {
  return async (input, ctx) => {
    const shared = await (deps.shared ?? isSharedRepo)(input.worktree);
    const items = await relevantKnowledge(deps, input.task, deps.cap ?? DEFAULT_KNOWLEDGE_TOKEN_CAP, {
      paths: input.paths,
      shared,
      ...(deps.topK !== undefined ? { topK: deps.topK } : {}),
      ...(input.eligibility ? { eligibility: input.eligibility } : {}),
      ctx,
    });
    const skills = items.filter((i) => i.kind === 'skill').map(({ id, version }) => ({ id, version }));
    if (skills.length > 0) {
      try {
        deps.store.tagRun(ctx.runId, skills);
      } catch {
        // Measurement is best effort; the task goes on.
      }
    }
    return items;
  };
}
