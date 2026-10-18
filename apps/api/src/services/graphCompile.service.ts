/**
 * Owns the graph's `compiled` field: every graph save goes through here so a
 * client can never supply frozen decisions, and so the compile step and a
 * run's learned decisions never overwrite a newer save.
 *
 * Saves are serialised per graph id. A compile runs AFTER its save, outside
 * the lock (it makes Jev calls), then merges into whatever is newest — keeping
 * only entries whose node hash still matches that newest document.
 */

import type {
  AgentGraph,
  CompiledNodeDecision,
  DecisionAdapter,
  ToolDescriptor,
} from '@htn/shared';
import { compileGraph, nodeHash, prunedCompiled, COMPILE_PROTOCOL } from '../core/graph/compile.js';
import { KeyedLock } from '../core/locks.js';
import { nowIso } from '../lib/ids.js';
import { store } from '../store/index.js';

interface GraphCompileDeps {
  decider(): DecisionAdapter;
  resolveTools(ids: string[]): Promise<ToolDescriptor[]>;
  localToolCandidates?: () => Promise<string[]>;
}

const writes = new KeyedLock();
let deps: GraphCompileDeps | null = null;
let enabled = true;
const pending = new Set<Promise<void>>();

/** Wired by runtime.ts; until then saves work and nothing is compiled. */
export function configureGraphCompile(next: GraphCompileDeps, options: { enabled: boolean }): void {
  deps = next;
  enabled = options.enabled;
}

export async function withGraphWriteLock<T>(graphId: string, fn: () => Promise<T>): Promise<T> {
  const release = await writes.acquire(graphId);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Save with the server's compiled entries (still-matching nodes only), never the caller's. */
export async function saveGraphOwnedUnlocked(next: AgentGraph): Promise<AgentGraph> {
  const existing = await store.getGraph(next.id);
  const { compiled: _ignored, ...rest } = next;
  const compiled = prunedCompiled(existing?.compiled, next);
  const saved = await store.saveGraph({ ...rest, ...(compiled ? { compiled } : {}) });
  scheduleCompile(saved.id);
  return saved;
}

export function saveGraphOwned(next: AgentGraph): Promise<AgentGraph> {
  return withGraphWriteLock(next.id, () => saveGraphOwnedUnlocked(next));
}

function scheduleCompile(graphId: string): void {
  if (!enabled || !deps) return;
  const job = compileStored(graphId)
    .catch((error: unknown) => {
      console.warn('[graph-compile] ' + graphId + ' left uncompiled: ' + String(error));
    })
    .finally(() => pending.delete(job));
  pending.add(job);
}

async function compileStored(graphId: string): Promise<void> {
  const current = deps;
  if (!current) return;
  const graph = await store.getGraph(graphId);
  if (!graph) return;
  const compiled = await compileGraph(graph, {
    decider: current.decider(),
    resolveTools: current.resolveTools,
    localToolCandidates: current.localToolCandidates,
    now: nowIso,
  });
  if (!compiled) return;
  const before = graph.compiled?.nodes ?? {};
  await withGraphWriteLock(graphId, async () => {
    const latest = await store.getGraph(graphId);
    if (!latest) return;
    const kept = prunedCompiled(latest.compiled, latest)?.nodes ?? {};
    const fresh = prunedCompiled(compiled, latest)?.nodes ?? {};
    const nodes = { ...kept };
    for (const [id, entry] of Object.entries(fresh)) {
      // A run may have recorded a newer entry while this compile was out; the
      // compile only wins where the stored entry is the one it started from.
      if (JSON.stringify(kept[id]) === JSON.stringify(before[id])) nodes[id] = entry;
    }
    if (sameEntries(nodes, latest.compiled?.nodes ?? {})) return;
    await store.saveGraph({ ...latest, compiled: { protocol: COMPILE_PROTOCOL, nodes } });
  });
}

function sameEntries(
  a: Record<string, CompiledNodeDecision>,
  b: Record<string, CompiledNodeDecision>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
  );
}

/**
 * A run asked Jev because no usable entry existed; keep its answer for the
 * next run. Ignored when the node changed since the run's snapshot.
 */
export async function recordCompiledDecision(
  graphId: string,
  nodeId: string,
  entry: CompiledNodeDecision,
): Promise<void> {
  if (!enabled) return;
  await withGraphWriteLock(graphId, async () => {
    const latest = await store.getGraph(graphId);
    const node = latest?.nodes.find((candidate) => candidate.id === nodeId);
    if (!latest || !node || nodeHash(node) !== entry.nodeHash) return;
    const nodes = { ...(prunedCompiled(latest.compiled, latest)?.nodes ?? {}), [nodeId]: entry };
    await store.saveGraph({ ...latest, compiled: { protocol: COMPILE_PROTOCOL, nodes } });
  });
}

/** For checks: wait until every scheduled compile has settled. */
export async function settleGraphCompiles(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
