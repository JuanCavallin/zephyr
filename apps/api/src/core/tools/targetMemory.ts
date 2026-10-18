/**
 * CROSS-RUN BROWSER TARGET MEMORY.
 *
 * The run-level resolution cache (browserDecision.ts) already replays a
 * target by IDENTITY — role + label — with no model call. It lives for one
 * run and one browser session. This layer keeps the same identity per graph
 * node across runs, so the second run of a graph on the same page asks Jev
 * nothing.
 *
 * What is remembered, and what never is:
 *   - Key: scope (graph|node) + operations + origin and path TEMPLATE
 *     (`/product/123` -> `/product/*`) + normalized goal. No query, fragment
 *     or credentials.
 *   - Value: role, label, which of several equal matches, who chose it.
 *   - Public pages only. A label on a private page can itself be personal
 *     ("Message Jane Doe"), so localOnly requests are never stored or served.
 *   - Which element, never permission. Approval is decided afresh each time
 *     by the deterministic floor and Jev's action policy.
 *
 * Every hit is re-resolved against the live table; the executor's freshness,
 * visibility, occlusion and identity checks still run before acting. Three
 * misses in a row evict an entry, so a redesigned page heals in one run.
 */

import type { BrowserOperation, BrowserTargetMemory, ElementRow, ElementTable } from '@htn/shared';
import { needsTarget } from '@htn/shared';
import type { BrowserDecider, BrowserDecision, BrowserDecisionRequest } from './browserDecision.js';
import { LOW_CONFIDENCE_THRESHOLD } from './browserDecision.js';

export interface TargetMemoryStore {
  getTargetMemory(key: string): Promise<BrowserTargetMemory | null>;
  putTargetMemory(entry: BrowserTargetMemory): Promise<void>;
  deleteTargetMemory(key: string): Promise<void>;
  listTargetMemory(scope?: string): Promise<BrowserTargetMemory[]>;
}

export interface TargetMemoryOptions {
  now?: () => string;
  /** Entries per scope; the least recently seen are dropped first. */
  maxPerScope?: number;
  /** Entries not seen for this long are ignored and removed. */
  ttlMs?: number;
}

const MAX_PER_SCOPE = 500;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EVICT_AFTER_MISSES = 3;

/** Words a goal can gain or lose between runs without changing what it asks for. */
const FILLER = new Set([
  'a',
  'an',
  'the',
  'to',
  'on',
  'of',
  'for',
  'in',
  'into',
  'please',
  'click',
  'press',
  'tap',
  'hit',
  'select',
  'choose',
  'button',
  'link',
  'field',
  'box',
  'then',
  'now',
]);

export function normalizedGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !FILLER.has(word))
    .join(' ');
}

/** Segments that are ids, not structure: numbers, uuids, long hex or mixed tokens. */
function templateSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return '*';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '*';
  if (/^[0-9a-f]{12,}$/i.test(segment)) return '*';
  if (segment.length >= 16 && /\d/.test(segment) && /[a-z]/i.test(segment)) return '*';
  return segment;
}

/** Origin and path template, or undefined for anything that is not a public web page. */
export function pageTemplate(url: string): { origin: string; pathTemplate: string } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const path = parsed.pathname.split('/').map(templateSegment).join('/');
    return { origin: parsed.origin, pathTemplate: path || '/' };
  } catch {
    return undefined;
  }
}

export function targetMemoryKey(input: {
  scope: string;
  url: string;
  goal: string;
  operations?: readonly BrowserOperation[];
}): string | undefined {
  const page = pageTemplate(input.url);
  const goal = normalizedGoal(input.goal);
  if (!page || !goal) return undefined;
  const operations = [...(input.operations ?? [])].sort().join(',');
  return [input.scope, operations, page.origin + page.pathTemplate, goal].join('|');
}

function sameIdentity(row: ElementRow, entry: { role: string; label: string }): boolean {
  return row.role === entry.role && row.label.toLowerCase() === entry.label.toLowerCase();
}

/** The row an entry names in this table: the ordinal-th match, or the only one. */
export function resolveRemembered(
  table: ElementTable,
  entry: Pick<BrowserTargetMemory, 'role' | 'label' | 'ordinal'>,
): ElementRow | undefined {
  const matches = table.rows.filter((row) => sameIdentity(row, entry));
  return matches[entry.ordinal] ?? (matches.length === 1 ? matches[0] : undefined);
}

function ordinalOf(table: ElementTable, row: ElementRow): number {
  return Math.max(
    0,
    table.rows
      .filter((candidate) => sameIdentity(candidate, row))
      .findIndex((candidate) => candidate.index === row.index),
  );
}

export interface TargetMemory {
  readonly decider: (inner: BrowserDecider) => BrowserDecider;
  /** A person picked this row for the request that produced `key`. */
  remember(input: {
    key: string;
    scope: string;
    table: ElementTable;
    row: ElementRow;
    operation: BrowserOperation;
    source: BrowserTargetMemory['source'];
  }): Promise<void>;
}

export function createTargetMemory(
  store: TargetMemoryStore,
  options: TargetMemoryOptions = {},
): TargetMemory {
  const now = options.now ?? (() => new Date().toISOString());
  const maxPerScope = options.maxPerScope ?? MAX_PER_SCOPE;
  const ttlMs = options.ttlMs ?? TTL_MS;
  let writes = 0;

  async function prune(scope: string): Promise<void> {
    const entries = await store.listTargetMemory(scope);
    for (const stale of entries.slice(maxPerScope)) await store.deleteTargetMemory(stale.key);
  }

  async function put(entry: BrowserTargetMemory): Promise<void> {
    await store.putTargetMemory(entry);
    writes += 1;
    if (writes % 50 === 0) await prune(entry.scope);
  }

  async function remember(input: Parameters<TargetMemory['remember']>[0]): Promise<void> {
    const page = pageTemplate(input.table.url);
    if (!page) return;
    const at = now();
    const existing = await store.getTargetMemory(input.key);
    await put({
      key: input.key,
      scope: input.scope,
      origin: page.origin,
      pathTemplate: page.pathTemplate,
      operation: input.operation,
      role: input.row.role,
      label: input.row.label,
      ordinal: ordinalOf(input.table, input.row),
      source: input.source,
      hits: existing?.hits ?? 0,
      misses: existing?.misses ?? 0,
      consecutiveMisses: 0,
      createdAt: existing?.createdAt ?? at,
      lastSeen: at,
    });
  }

  function decider(inner: BrowserDecider): BrowserDecider {
    return async (request: BrowserDecisionRequest): Promise<BrowserDecision> => {
      const scope = request.memoryScope;
      const key =
        scope && !request.localOnly
          ? targetMemoryKey({
              scope,
              url: request.table.url,
              goal: request.goal,
              operations: request.allowedOperations,
            })
          : undefined;
      if (!key || !scope) return inner(request);

      const entry = await store.getTargetMemory(key).catch(() => null);
      if (entry && Date.parse(now()) - Date.parse(entry.lastSeen) > ttlMs) {
        await store.deleteTargetMemory(key).catch(() => undefined);
      } else if (entry) {
        const allowed =
          !request.allowedOperations || request.allowedOperations.includes(entry.operation);
        const row =
          allowed && needsTarget(entry.operation)
            ? resolveRemembered(request.table, entry)
            : undefined;
        if (row) {
          await put({
            ...entry,
            hits: entry.hits + 1,
            consecutiveMisses: 0,
            lastSeen: now(),
          }).catch(() => undefined);
          return {
            operation: entry.operation,
            index: row.index,
            // A replay of a known element, not a model's guess about one.
            confidence: 1,
            cacheable: true,
            source: 'memory',
            remembered: entry.source,
            rationale:
              (entry.source === 'human'
                ? 'Your earlier choice'
                : 'Remembered from an earlier run') +
              ': "' +
              row.label +
              '", no model call.',
          };
        }
        const missed = {
          ...entry,
          misses: entry.misses + 1,
          consecutiveMisses: entry.consecutiveMisses + 1,
        };
        await (
          missed.consecutiveMisses >= EVICT_AFTER_MISSES
            ? store.deleteTargetMemory(key)
            : put({ ...missed, lastSeen: entry.lastSeen })
        ).catch(() => undefined);
      }

      const decision = await inner(request);
      const cacheable = decision.cacheable ?? decision.confidence >= LOW_CONFIDENCE_THRESHOLD;
      const row =
        decision.index === undefined
          ? undefined
          : request.table.rows.find((r) => r.index === decision.index);
      if (cacheable && row && needsTarget(decision.operation) && decision.source !== 'memory') {
        await remember({
          key,
          scope,
          table: request.table,
          row,
          operation: decision.operation,
          source: decision.source === 'deterministic' ? 'deterministic' : 'jev',
        }).catch(() => undefined);
      }
      return decision;
    };
  }

  return { decider, remember };
}
