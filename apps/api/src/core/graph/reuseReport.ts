/**
 * The Graph Editor's reuse panel: per node, how often recent runs reused a
 * frozen decision or a remembered browser target instead of asking Jev, what
 * is frozen or remembered right now, and which sites look changed or blocked.
 *
 * Pure: the service loads runs, memory and site blocks; this only counts.
 */

import type {
  AgentGraph,
  BrowserSiteBlock,
  BrowserTargetMemory,
  GraphReuseReport,
  NodeReuse,
  ReuseAlert,
  RollupInput,
} from '@htn/shared';
import { runReuse } from '@htn/shared';

const RECENT_BLOCK_MS = 7 * 24 * 60 * 60 * 1000;
/** Two misses in a row: the element was looked for twice and was not there. */
const CHANGED_AFTER_MISSES = 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function buildGraphReuseReport(input: {
  graph: AgentGraph;
  runs: RollupInput[];
  memory: BrowserTargetMemory[];
  siteBlocks: BrowserSiteBlock[];
  now: string;
}): GraphReuseReport {
  const { graph } = input;
  const nodes: Record<string, NodeReuse> = Object.fromEntries(
    graph.nodes.map((node): [string, NodeReuse] => {
      const compiled = graph.compiled?.nodes[node.id];
      return [
        node.id,
        {
          runs: 0,
          frozenDecisions: 0,
          liveDecisions: 0,
          rememberedTargets: 0,
          decidedTargets: 0,
          ...(compiled ? { compiled: { kind: compiled.kind, source: compiled.source } } : {}),
          remembered: { entries: 0, hits: 0, misses: 0, corrected: 0 },
        },
      ];
    }),
  );

  const perRun = input.runs.map(runReuse);
  for (const reuse of perRun) {
    for (const [nodeId, counts] of Object.entries(reuse.byNode)) {
      const node = nodes[nodeId];
      if (!node) continue;
      node.runs += 1;
      node.frozenDecisions += counts.frozenDecisions;
      node.liveDecisions += counts.liveDecisions;
      node.rememberedTargets += counts.rememberedTargets;
      node.decidedTargets += counts.decidedTargets;
    }
  }

  const prefix = graph.id + '|';
  const mine = input.memory.filter((entry) => entry.scope.startsWith(prefix));
  for (const entry of mine) {
    const node = nodes[entry.scope.slice(prefix.length)];
    if (!node) continue;
    node.remembered.entries += 1;
    node.remembered.hits += entry.hits;
    node.remembered.misses += entry.misses;
    if (entry.source === 'human') node.remembered.corrected += 1;
  }

  const alerts: ReuseAlert[] = [];
  const changed = new Map<string, { origin: string; pathTemplate: string; count: number }>();
  for (const entry of mine) {
    if (entry.consecutiveMisses < CHANGED_AFTER_MISSES) continue;
    const key = entry.origin + entry.pathTemplate;
    const current = changed.get(key) ?? {
      origin: entry.origin,
      pathTemplate: entry.pathTemplate,
      count: 0,
    };
    current.count += 1;
    changed.set(key, current);
  }
  for (const page of changed.values())
    alerts.push({
      kind: 'site_changed',
      origin: page.origin,
      pathTemplate: page.pathTemplate,
      detail:
        page.count +
        ' remembered element(s) on this page were missing on the last visits; the page may have changed. Runs fall back to Jev, and the entries are dropped after a third miss.',
    });
  const now = Date.parse(input.now);
  for (const block of input.siteBlocks) {
    if (now - Date.parse(block.lastAt) > RECENT_BLOCK_MS) continue;
    alerts.push({
      kind: 'site_blocked',
      origin: block.origin,
      detail:
        (block.reason === 'browser_challenge'
          ? 'Showed a challenge or sign-in wall to automated reads '
          : 'Returned no readable page to automated reads ') +
        block.count +
        ' time(s), last ' +
        block.lastAt.slice(0, 10) +
        '. Expect a handoff, or use a page you control for demos.',
    });
  }

  const totals = perRun.reduce(
    (sum, reuse) => ({
      frozenDecisions: sum.frozenDecisions + reuse.frozenDecisions,
      liveDecisions: sum.liveDecisions + reuse.liveDecisions,
      rememberedTargets: sum.rememberedTargets + reuse.rememberedTargets,
      decidedTargets: sum.decidedTargets + reuse.decidedTargets,
    }),
    { frozenDecisions: 0, liveDecisions: 0, rememberedTargets: 0, decidedTargets: 0 },
  );
  return {
    graphId: graph.id,
    runs: perRun.length,
    warmRuns: perRun.filter((reuse) => reuse.warm).length,
    medianJevCalls: median(perRun.map((reuse) => reuse.jevCalls)),
    totals,
    nodes,
    alerts,
  };
}
