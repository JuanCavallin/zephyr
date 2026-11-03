/**
 * Step 8 draft step (spec §11): a NORMAL text model turns signals into candidate
 * preferences and skills. This is generative work, so it is not Jev; Jev scores the
 * drafts afterwards (score.ts).
 *
 * It runs in the background after a task finishes, off the critical path, and never
 * throws: a failed draft is an `{ ok: false }` the caller logs, never a failed task.
 *
 * Private-route signals go only to `completeLocal`, a local model. With no local model
 * configured they are left unprocessed for later, never sent to the remote one.
 */

import type { LearningScope, PreferenceSignal, ProviderCallContext, TextModelAdapter } from '@htn/shared';
import { checkLearnedContent, type GuardrailVerdict } from './guardrails.js';
import { describeSignal, LEARNING_RUN_ID } from './signalLog.js';
import type { StoredSignal } from './profileStore.js';

export const LEARNING_DRAFT_POLICY_RULE = 'learning-draft';
export const MAX_DRAFT_CANDIDATES = 6;
/** Diff detail is long; the drafter gets a bounded excerpt per signal. */
export const MAX_DETAIL_IN_PROMPT = 2_000;

const SIGNALS_START = '<<<SIGNALS';
const SIGNALS_END = 'SIGNALS>>>';

type Complete = TextModelAdapter['complete'];

export interface DraftCandidate {
  kind: 'pref' | 'skill';
  scope: LearningScope;
  /** The statement, or the skill's description. */
  text: string;
  skill?: { name: string; description: string; body: string };
  /** Signal ids, a subset of the ones offered. */
  evidence: string[];
  /** Drafted from private signals: only a local model may ever see it. */
  private: boolean;
}

export interface RejectedDraft {
  candidate: DraftCandidate;
  verdict: GuardrailVerdict;
}

export type DraftResult =
  | {
      ok: true;
      candidates: DraftCandidate[];
      rejected: RejectedDraft[];
      /** Signals handed to a model; mark these processed. */
      processed: string[];
      /** Private signals with no local model to read them; left for later. */
      deferred: string[];
    }
  | { ok: false; error: string; processed: string[]; deferred: string[] };

export interface DraftDeps {
  /** The remote text model, for non-private signals. */
  complete: Complete;
  /** A local model, the only one allowed to read private signals. */
  completeLocal?: Complete;
  signal?: AbortSignal;
}

/** The JSON block the prompt carries; the mock text model reads it back. */
interface PromptSignal {
  id: string;
  kind: PreferenceSignal['kind'];
  scope: LearningScope;
  summary: string;
  detail?: string;
}

export function buildDraftPrompt(signals: StoredSignal[]): string {
  const block: PromptSignal[] = signals.map((s) => ({
    id: s.signal.id,
    kind: s.signal.kind,
    scope: s.signal.scope,
    summary: describeSignal(s.signal),
    ...(s.detail ? { detail: s.detail.slice(0, MAX_DETAIL_IN_PROMPT) } : {}),
  }));
  return [
    'Signals from how the user reviewed agent work, strongest kinds first:',
    SIGNALS_START,
    JSON.stringify(block, null, 2),
    SIGNALS_END,
    'Propose at most ' + MAX_DRAFT_CANDIDATES + ' candidates that generalise beyond this one task.',
  ].join('\n');
}

export const DRAFT_SYSTEM_PROMPT = [
  'You turn evidence about a user\'s coding taste into short, reusable guidance for a coding agent.',
  'Reply with JSON only: {"candidates":[...]}. Each candidate is one of',
  '  {"kind":"pref","scope":"personal"|"project","text":"<one sentence>","evidence":["<signal id>",...]}',
  '  {"kind":"skill","scope":"personal"|"project","name":"<kebab-case>","description":"<one line>","body":"<steps>","evidence":[...]}',
  'Cite only signal ids you were given. Prefer "personal" unless the signal is about this repo\'s conventions.',
  'Never propose anything about tests, lint, CI, approvals, permissions, policy or protected files:',
  'learned guidance may change how code is written, never what checks it must pass or what the agent may do.',
  'Return {"candidates":[]} when nothing generalises.',
].join('\n');

/** Recover the signals from a draft prompt; used by the mock text model. */
export function signalsFromPrompt(prompt: string): PromptSignal[] {
  const start = prompt.indexOf(SIGNALS_START);
  const end = prompt.indexOf(SIGNALS_END);
  if (start < 0 || end < start) return [];
  try {
    const parsed = JSON.parse(prompt.slice(start + SIGNALS_START.length, end)) as unknown;
    return Array.isArray(parsed) ? (parsed as PromptSignal[]) : [];
  } catch {
    return [];
  }
}

/**
 * The mock text model's draft: deterministic, so the offline check and a no-keys demo
 * learn the same thing every time. Reads the diff for well-known taste shifts and turns
 * comments into statements.
 */
export function heuristicDraft(prompt: string): { candidates: unknown[] } {
  const candidates: unknown[] = [];
  for (const s of signalsFromPrompt(prompt)) {
    const detail = (s.detail ?? '').replace(/\r\n/g, '\n');
    const removed = detail.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).join('\n');
    const added = detail.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    if (s.kind === 'user_edit') {
      const nestedIfs = (removed.match(/\bif\s*\(/g) ?? []).length >= 2;
      const earlyReturn = /\bif\s*\([^)]*\)\s*(?:\{\s*)?return\b/.test(added) || /^\+\s*return\b/m.test(detail);
      if (nestedIfs && earlyReturn) {
        candidates.push({ kind: 'pref', scope: s.scope, text: 'Prefer early returns over nested if blocks.', evidence: [s.id] });
      } else if (/\bvar\b/.test(removed) && /\b(?:const|let)\b/.test(added)) {
        candidates.push({ kind: 'pref', scope: s.scope, text: 'Use const or let, never var.', evidence: [s.id] });
      } else if (/console\.log/.test(removed) && !/console\.log/.test(added)) {
        candidates.push({ kind: 'pref', scope: s.scope, text: 'Do not leave console.log calls in committed code.', evidence: [s.id] });
      }
    }
    const quoted = /"([^"]{6,200})"/.exec(s.summary)?.[1];
    if (quoted && (s.kind === 'explicit_feedback' || s.kind === 'approval')) {
      const sentence = quoted.trim().replace(/[.!]*$/, '.');
      candidates.push({ kind: 'pref', scope: s.scope, text: sentence[0]!.toUpperCase() + sentence.slice(1), evidence: [s.id] });
    }
  }
  return { candidates: candidates.slice(0, MAX_DRAFT_CANDIDATES) };
}

/** First `{` to last `}`, fences stripped: models wrap JSON in prose and fences. */
function extractJson(text: string): string {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Validate one model candidate; anything malformed is dropped, not repaired. */
function parseCandidate(raw: unknown, offered: Set<string>, isPrivate: boolean): DraftCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const scope: LearningScope = c.scope === 'project' ? 'project' : 'personal';
  const evidence = Array.isArray(c.evidence)
    ? [...new Set(c.evidence.filter((e): e is string => typeof e === 'string' && offered.has(e)))]
    : [];
  if (evidence.length === 0) return null;
  if (c.kind === 'skill') {
    const name = str(c.name, 64)?.toLowerCase();
    const description = str(c.description, 300);
    const body = str(c.body, 4_000);
    if (!name || !KEBAB.test(name) || !description || !body) return null;
    return { kind: 'skill', scope, text: description, skill: { name, description, body }, evidence, private: isPrivate };
  }
  const text = str(c.text, 300);
  if (!text) return null;
  return { kind: 'pref', scope, text, evidence, private: isPrivate };
}

async function draftBatch(
  complete: Complete,
  signals: StoredSignal[],
  isPrivate: boolean,
  signal: AbortSignal | undefined,
): Promise<{ candidates: DraftCandidate[] } | { error: string }> {
  const ctx: ProviderCallContext = {
    runId: LEARNING_RUN_ID,
    policyRule: LEARNING_DRAFT_POLICY_RULE,
    ...(signal ? { signal } : {}),
  };
  let completion;
  try {
    completion = await complete(
      {
        system: DRAFT_SYSTEM_PROMPT,
        prompt: buildDraftPrompt(signals),
        json: true,
        maxTokens: 1_500,
        tier: isPrivate ? 'local' : 'standard',
      },
      ctx,
    );
  } catch (error) {
    return { error: 'draft model threw: ' + (error as Error).message };
  }
  if (!completion.ok) return { error: 'draft model failed: ' + completion.error.message };
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(completion.data.text));
  } catch {
    return { error: 'draft model returned no JSON' };
  }
  const list = (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return { error: 'draft model returned no candidates array' };
  const offered = new Set(signals.map((s) => s.signal.id));
  const candidates = list
    .map((c) => parseCandidate(c, offered, isPrivate))
    .filter((c): c is DraftCandidate => c !== null)
    .slice(0, MAX_DRAFT_CANDIDATES);
  return { candidates };
}

/**
 * Draft candidates from stored signals. Private and non-private signals are drafted
 * separately so a private one never shares a prompt with a remote model. Never throws.
 */
export async function draftCandidates(signals: StoredSignal[], deps: DraftDeps): Promise<DraftResult> {
  const priv = signals.filter((s) => s.signal.private);
  const open = signals.filter((s) => !s.signal.private);
  const deferred = deps.completeLocal ? [] : priv.map((s) => s.signal.id);
  const batches: { complete: Complete; signals: StoredSignal[]; isPrivate: boolean }[] = [];
  if (open.length) batches.push({ complete: deps.complete, signals: open, isPrivate: false });
  if (priv.length && deps.completeLocal) batches.push({ complete: deps.completeLocal, signals: priv, isPrivate: true });

  const candidates: DraftCandidate[] = [];
  const rejected: RejectedDraft[] = [];
  const processed: string[] = [];
  const errors: string[] = [];
  for (const b of batches) {
    const r = await draftBatch(b.complete, b.signals, b.isPrivate, deps.signal);
    if ('error' in r) {
      errors.push(r.error);
      continue;
    }
    processed.push(...b.signals.map((s) => s.signal.id));
    for (const c of r.candidates) {
      const verdict = checkLearnedContent(c.skill ? [c.skill.name, c.skill.description, c.skill.body].join('\n') : c.text);
      if (verdict.ok) candidates.push(c);
      else rejected.push({ candidate: c, verdict });
    }
  }
  if (errors.length && processed.length === 0) return { ok: false, error: errors.join('; '), processed, deferred };
  return { ok: true, candidates, rejected, processed, deferred };
}
