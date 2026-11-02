/**
 * Conflict graph and waves (spec §10).
 *
 * Two tasks CONFLICT when their write scopes could touch the same file. Tasks that
 * conflict never share a wave; a task never runs in a wave earlier than, or equal to,
 * any task it depends on. Waves are what "Run ready tasks" fans out: the first wave
 * whose predecessors are done.
 *
 * Overlap is decided on the GLOBS, not on files on disk, so it works before a task has
 * written anything. It is conservative: when two wildcard segments might both match
 * some name, they overlap. A false "conflict" costs parallelism; a false "disjoint"
 * would let two agents edit one file, which the lease check would then have to catch.
 */

import { globToRegExp } from '../verify/glob.js';

/** The fields the graph needs; `Task` and `DecomposedTask` both fit. */
export interface ScopedNode {
  id: string;
  writeScope: readonly string[];
  /** Ids this node must wait for. `dependsOn` on a Task, `deps` on a plan. */
  dependsOn?: readonly string[];
  deps?: readonly string[];
}

export class DependencyCycleError extends Error {
  readonly code = 'DEPENDENCY_CYCLE';
  constructor(readonly cycle: string[]) {
    super('Dependency cycle: ' + cycle.join(' -> '));
    this.name = 'DependencyCycleError';
  }
}

const WILDCARD = /[*?{]/;

/** `{a,b}x` -> [`ax`, `bx`]. Nested braces expand recursively. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const parts: string[] = [];
  let start = open + 1;
  for (let i = open; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        parts.push(glob.slice(start, i));
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(glob.slice(start, i));
      start = i + 1;
    }
  }
  if (close === -1) return [glob]; // unbalanced: treat literally
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  return parts.flatMap((p) => expandBraces(head + p + tail));
}

/** A slash-less glob matches a basename anywhere (see `matchesGlob`). */
function segmentsOf(glob: string): string[] {
  const g = glob.includes('/') ? glob : '**/' + glob;
  return g.split('/').filter((s) => s !== '' && s !== '.');
}

function literalPrefix(seg: string): string {
  const m = WILDCARD.exec(seg);
  return m ? seg.slice(0, m.index) : seg;
}

function literalSuffix(seg: string): string {
  let i = seg.length;
  while (i > 0 && !WILDCARD.test(seg[i - 1]!) && seg[i - 1] !== '}') i -= 1;
  return seg.slice(i);
}

/** Could one directory/file name match both segment patterns? */
function segmentsOverlap(a: string, b: string): boolean {
  const aWild = WILDCARD.test(a);
  const bWild = WILDCARD.test(b);
  if (!aWild && !bWild) return a === b;
  if (!aWild) return globToRegExp(b).test(a);
  if (!bWild) return globToRegExp(a).test(b);
  // Both wildcards: compatible literal prefix and suffix is enough to share a name.
  const [pa, pb] = [literalPrefix(a), literalPrefix(b)];
  const [sa, sb] = [literalSuffix(a), literalSuffix(b)];
  const prefixOk = pa.startsWith(pb) || pb.startsWith(pa);
  const suffixOk = sa.endsWith(sb) || sb.endsWith(sa);
  return prefixOk && suffixOk;
}

function segmentListsOverlap(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (i === a.length && j === b.length) out = true;
    else if (a[i] === '**') out = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (b[j] === '**') out = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) out = false;
    else out = segmentsOverlap(a[i]!, b[j]!) && go(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

/** True when some repo path could match both globs. Symmetric. */
export function globsOverlap(a: string, b: string): boolean {
  for (const x of expandBraces(a))
    for (const y of expandBraces(b)) if (segmentListsOverlap(segmentsOf(x), segmentsOf(y))) return true;
  return false;
}

/** True when any glob in `a` overlaps any glob in `b`. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

function depsOf(node: ScopedNode): readonly string[] {
  return node.dependsOn ?? node.deps ?? [];
}

/** Every unordered pair of tasks whose write scopes overlap. */
export function conflictEdges(nodes: readonly ScopedNode[]): [string, string][] {
  const edges: [string, string][] = [];
  for (let i = 0; i < nodes.length; i += 1)
    for (let j = i + 1; j < nodes.length; j += 1)
      if (scopesOverlap(nodes[i]!.writeScope, nodes[j]!.writeScope))
        edges.push([nodes[i]!.id, nodes[j]!.id]);
  return edges;
}

/**
 * The first dependency cycle, as `[a, b, ..., a]`, or null. Dependencies on ids not in
 * `nodes` are ignored here; `validatePlan` reports them separately.
 */
export function findCycle(nodes: readonly ScopedNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of depsOf(byId.get(id)!)) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const n of nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return null;
}

/**
 * Group nodes into waves. Within a wave no two nodes conflict; every dependency of a
 * node sits in an earlier wave. Greedy in input order, so the plan's own ordering (the
 * decomposition review's "reorder") decides who goes first when two tasks conflict.
 *
 * `settled` ids (already done, or outside this board) count as satisfied dependencies.
 * Throws DependencyCycleError on a cycle.
 */
export function planWaves(
  nodes: readonly ScopedNode[],
  settled: Iterable<string> = [],
): string[][] {
  const cycle = findCycle(nodes);
  if (cycle) throw new DependencyCycleError(cycle);
  const known = new Set(nodes.map((n) => n.id));
  const placed = new Set<string>(settled);
  const remaining = [...nodes];
  const waves: string[][] = [];
  while (remaining.length) {
    const wave: ScopedNode[] = [];
    for (const node of remaining) {
      const ready = depsOf(node).every((d) => placed.has(d) || !known.has(d));
      if (!ready) continue;
      if (wave.some((w) => scopesOverlap(w.writeScope, node.writeScope))) continue;
      wave.push(node);
    }
    // Unreachable without a cycle, but a wave of zero would loop forever.
    if (wave.length === 0) throw new DependencyCycleError(remaining.map((n) => n.id));
    for (const node of wave) {
      placed.add(node.id);
      remaining.splice(remaining.indexOf(node), 1);
    }
    waves.push(wave.map((n) => n.id));
  }
  return waves;
}
