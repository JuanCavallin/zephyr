/**
 * The browser decision seam — `3B-5`.
 *
 * ONE ROUND TRIP PER STEP is the design goal, and this file is where it is
 * either won or lost. Three implementations sit behind one interface:
 *
 *   createDeterministicDecider  string-matches the goal against row labels.
 *                               Zero network, zero keys. Built FIRST on purpose:
 *                               TYPESAFE_API_KEY is empty, the design spec
 *                               requires a deterministic Jev fallback anyway,
 *                               and it keeps the whole demo runnable with no
 *                               credentials at all.
 *   createJevDecider            one batched System One request. Lives in
 *                               providers/, because only providers may do I/O.
 *   withResolutionCache         wraps either. A HIT MAKES NO MODEL CALL. After
 *                               one warm-up run the demo path is deterministic,
 *                               fast, free, and has no live nondeterminism on
 *                               stage.
 *
 * Pure: no fetch, no SDK, no store. The Jev-backed implementation is injected.
 */

import type { BrowserOperation, ElementTable } from '@htn/shared';
import { needsTarget } from '@htn/shared';
import { eligibleRows, findByIdentity, rowIdentity } from './elementTable.js';

export interface BrowserDecisionRequest {
  /** What the step is trying to achieve. Free text from the plan, not from Jev. */
  goal: string;
  table: ElementTable;
  /** Operations the caller will accept. Narrows the speculative fan-out. */
  allowedOperations?: readonly BrowserOperation[];
  /**
   * The value that would be typed if the operation turns out to be TYPE_TEXT.
   *
   * Supplied so a decider can tell "this field still needs filling" from "this
   * field already holds exactly that". Without it a stateless decider will
   * happily choose TYPE_TEXT on an already-filled box forever, which is what a
   * loop driven by the deterministic fallback actually did.
   *
   * It is NOT sent to Jev as a question — Jev picks the field, never the text.
   */
  typeText?: string;
  signal?: AbortSignal;
  /** Trusted server context only; never sourced from page content or model arguments. */
  credentialRunId?: string;
  /** Trusted run/provider/session/control generation, for isolated target resolutions. */
  cacheScope?: string;
  /** Trusted privacy policy: even the numbered table must stay on the machine. */
  localOnly?: boolean;
  /**
   * Trusted `graphId|nodeId` (or `adhoc:<kind>`) for cross-run target memory.
   * Absent means nothing is remembered beyond this run.
   */
  memoryScope?: string;
}

export interface BrowserDecision {
  operation: BrowserOperation;
  /** Index into the table. Absent for SCROLL / WAIT / DONE / BLOCKED. */
  index?: number;
  /** Calibrated when it came from Jev; a fixed heuristic value otherwise. */
  confidence: number;
  /** Full distribution over the offered targets, when the source provides one. */
  probabilities?: Record<string, number>;
  /** Truthful labeling — the UI must not present a fallback as a model decision. */
  source: 'jev' | 'deterministic' | 'cache' | 'memory';
  /** For a `memory` hit: who originally chose this element. */
  remembered?: 'jev' | 'deterministic' | 'human';
  /** Why, in one line. For the trace, not for the model. */
  rationale: string;
  /**
   * Whether this resolution is worth replaying.
   *
   * SEPARATE FROM `confidence` ON PURPOSE. "I matched this label well enough to
   * find it again" and "I am confident this is the right action for the goal"
   * are different claims, and collapsing them breaks one of the two: the
   * deterministic decider reports LOW confidence so that a `verify` action
   * escalates to a human, and if that same number also gated the cache, the
   * no-credentials path could never replay anything — which is exactly the
   * path the demo runs on today.
   *
   * Defaults to `confidence >= LOW_CONFIDENCE_THRESHOLD` when omitted.
   */
  cacheable?: boolean;
  /**
   * What the model call cost, for the egress ledger. Only a decision that
   * actually asked a model carries it; cache, memory, single-target and
   * deterministic answers made no call and leave it out.
   */
  usage?: BrowserDecisionUsage;
}

export interface BrowserDecisionUsage {
  destination: string;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Undefined when the call could not be priced, never 0 for "unknown". */
  estimatedCostCents?: number;
}

export type BrowserDecider = (request: BrowserDecisionRequest) => Promise<BrowserDecision>;

/* -------------------------------------------------------------------------- */
/* Deterministic fallback                                                     */
/* -------------------------------------------------------------------------- */

/** Verbs that hint at an operation when the goal does not name an element. */
const TYPE_HINTS = ['type', 'enter', 'fill', 'input', 'write', 'search for'];
const SELECT_HINTS = ['select', 'choose', 'pick'];
const SCROLL_HINTS = ['scroll', 'further down', 'more results'];

function scoreLabel(goal: string, label: string): number {
  const g = goal.toLowerCase();
  const l = label.toLowerCase().trim();
  if (!l) return 0;
  if (g.includes(l)) return l.length * 2;

  // Token overlap, so "click the sign in button" still matches "Sign in".
  const tokens = l.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => g.includes(t)).length;
  return hits === 0 ? 0 : (hits / tokens.length) * l.length;
}

/**
 * The no-credentials path. Picks an operation from the goal's verbs, then the
 * best label match among the rows eligible for it.
 *
 * It reports LOW confidence deliberately (0.4 on a match, 0.2 without one).
 * That is honest — this is string matching, not a calibrated probability — and
 * it means a `verify` action decided this way escalates to a human rather than
 * proceeding, which is the correct direction for an uncertain decision.
 */
export function createDeterministicDecider(): BrowserDecider {
  return async ({ goal, table, allowedOperations, typeText }) => {
    const allow = (op: BrowserOperation): boolean =>
      !allowedOperations || allowedOperations.includes(op);

    const g = goal.toLowerCase();
    const wantsType = TYPE_HINTS.some((h) => g.includes(h));
    const wantsSelect = SELECT_HINTS.some((h) => g.includes(h));
    const wantsScroll = SCROLL_HINTS.some((h) => g.includes(h));

    const order: BrowserOperation[] = wantsType
      ? ['TYPE_TEXT', 'CLICK', 'SELECT']
      : wantsSelect
        ? ['SELECT', 'CLICK', 'TYPE_TEXT']
        : ['CLICK', 'TYPE_TEXT', 'SELECT'];

    /** A box already holding the value we would type is not a typing target. */
    const stillNeedsTyping = (row: { value?: string }): boolean => {
      if (!typeText) return true;
      const current = (row.value ?? '').trim().toLowerCase();
      return current !== typeText.trim().toLowerCase();
    };

    for (const operation of order) {
      if (!allow(operation)) continue;
      let rows = eligibleRows(table, operation);
      if (operation === 'TYPE_TEXT') rows = rows.filter(stillNeedsTyping);
      if (rows.length === 0) continue;

      let best = rows[0]!;
      let bestScore = 0;
      for (const row of rows) {
        const score = scoreLabel(goal, row.label);
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }

      if (bestScore === 0 && operation !== order[0]) continue;

      return {
        operation,
        index: best.index,
        confidence: bestScore > 0 ? 0.4 : 0.2,
        // A real label match is replayable even though the confidence is low.
        // Taking "the first eligible target" because nothing matched is not.
        cacheable: bestScore > 0,
        source: 'deterministic',
        rationale:
          bestScore > 0
            ? 'Deterministic fallback: "' + best.label + '" best matched the goal.'
            : 'Deterministic fallback: no label matched; took the first eligible ' +
              operation +
              ' target.',
      };
    }

    if (wantsScroll && allow('SCROLL_DOWN')) {
      return {
        operation: 'SCROLL_DOWN',
        confidence: 0.3,
        source: 'deterministic',
        rationale: 'Deterministic fallback: the goal asked to scroll.',
      };
    }

    // Nothing actionable. BLOCKED, not DONE — claiming completion we cannot
    // verify is the one failure mode the completion judge exists to prevent.
    return {
      operation: 'BLOCKED',
      confidence: 0.2,
      source: 'deterministic',
      rationale: 'Deterministic fallback: no eligible target on this page.',
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Fallback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run `primary`, and fall back to `fallback` if it throws.
 *
 * A BROWSER DECISION MUST NOT BE ABLE TO KILL A RUN. Jev is reached over the
 * network, so it can fail for reasons that have nothing to do with the page:
 * an expired key, a rate limit, a 403 because the account needs a card on
 * file, a timeout. All of those are "we did not get a recommendation", and the
 * design spec's answer to that is the deterministic fallback — which exists
 * and is already correct.
 *
 * NOTE THE DIRECTION. This is NOT a fail-open: a failed decision degrades to a
 * weaker decision, and the weaker decision reports LOW confidence, which makes
 * the risk gate stricter rather than laxer. Authorization is a separate
 * concern and still fails closed.
 *
 * The returned decision is labelled `deterministic`, never `jev`, so the trace
 * does not claim a model call that did not happen.
 */
export function withFallback(
  primary: BrowserDecider,
  fallback: BrowserDecider,
  onFallback?: (error: unknown) => void,
): BrowserDecider {
  return async (request) => {
    try {
      return await primary(request);
    } catch (error) {
      onFallback?.(error);
      const decision = await fallback(request);
      return {
        ...decision,
        rationale:
          'Jev was unreachable (' +
          (error instanceof Error ? error.message.split('\n')[0] : String(error)).slice(0, 120) +
          '); ' +
          decision.rationale,
      };
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Resolution cache                                                           */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  operation: BrowserOperation;
  /** Role + label, NOT an index — see rowIdentity(). */
  identity?: string;
}

export interface ResolutionCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  readonly size: number;
}

export function createResolutionCache(): ResolutionCache {
  const map = new Map<string, CacheEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    delete: (key) => void map.delete(key),
    get size() {
      return map.size;
    },
  };
}

/**
 * Page identity for the cache key. The origin and path, without the query —
 * `?q=chairs` and `?q=lamps` are the same page with the same buttons, and
 * keying on the full URL would miss every time and make the cache useless.
 */
export function pageKey(url: string, goal: string): string {
  let page = url;
  try {
    const parsed = new URL(url);
    page = parsed.origin + parsed.pathname;
  } catch {
    // Not a URL (about:blank, a file path). Use it whole.
  }
  return page + '\u0000' + goal.trim().toLowerCase();
}

/**
 * Wrap a decider so a repeated (page, goal) pair costs ZERO model calls.
 *
 * The entry stores the element's IDENTITY and re-resolves the index against the
 * current table, so a page that shifted by one row still hits. A genuine miss
 * (the element is gone) falls through to the inner decider and rewrites the
 * entry — Stagehand calls this self-healing.
 */
export function withResolutionCache(inner: BrowserDecider, cache: ResolutionCache): BrowserDecider {
  return async (request) => {
    const key =
      (request.cacheScope ?? request.credentialRunId ?? 'legacy') + ':' + (request.localOnly ? 'local' : 'public') +
      '\u0000' +
      pageKey(request.table.url, request.goal);
    const hit = cache.get(key);

    if (hit) {
      if (!needsTarget(hit.operation)) {
        return {
          operation: hit.operation,
          confidence: 1,
          source: 'cache',
          rationale: 'Cache hit: no model call.',
        };
      }
      const row = hit.identity ? findByIdentity(request.table, hit.identity) : undefined;
      if (row) {
        return {
          operation: hit.operation,
          index: row.index,
          // 1, not the original confidence: this is now a deterministic replay
          // of a previously resolved target, which is a stronger claim than the
          // model's original guess, not a weaker one.
          confidence: 1,
          cacheable: true,
          source: 'cache',
          rationale: 'Cache hit: resolved "' + row.label + '" with no model call.',
        };
      }
      // The element moved or vanished. Drop the entry and decide again.
      cache.delete(key);
    }

    const decision = await inner(request);

    // Only cache decisions worth replaying. A BLOCKED answer, or one the
    // decider itself would not stand behind, is exactly what should be
    // re-asked next time.
    const cacheable = decision.cacheable ?? decision.confidence >= LOW_CONFIDENCE_THRESHOLD;
    if (cacheable && decision.operation !== 'BLOCKED') {
      const row =
        decision.index === undefined
          ? undefined
          : request.table.rows.find((r) => r.index === decision.index);
      cache.set(key, {
        operation: decision.operation,
        ...(row ? { identity: rowIdentity(row) } : {}),
      });
    }

    return decision;
  };
}

/* -------------------------------------------------------------------------- */
/* Confidence -> risk                                                         */
/* -------------------------------------------------------------------------- */

/** Below this, a `verify` action is escalated to a human. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Low confidence ESCALATES. Never the reverse.
 *
 * A 0.5/0.5 split between two buttons is exactly when a person should look, and
 * an `auto` action stays `auto` because reversibility — not confidence — is
 * what put it there. Confidence may only make the gate stricter.
 */
export function escalateForConfidence(
  riskClass: 'auto' | 'verify' | 'ask_human',
  confidence: number,
): { riskClass: 'auto' | 'verify' | 'ask_human'; escalated: boolean } {
  if (riskClass === 'verify' && confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { riskClass: 'ask_human', escalated: true };
  }
  return { riskClass, escalated: false };
}
