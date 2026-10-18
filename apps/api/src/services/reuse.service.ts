/** Loads what the Graph Editor's reuse panel counts; see core/graph/reuseReport.ts. */

import { isTerminal, type GraphReuseReport, type RollupInput } from '@htn/shared';
import { buildGraphReuseReport } from '../core/graph/reuseReport.js';
import { nowIso } from '../lib/ids.js';
import { store } from '../store/index.js';

/** Enough runs to show a trend without reading a graph's whole history. */
const RECENT_RUNS = 20;

export async function graphReuseReport(graphId: string): Promise<GraphReuseReport | null> {
  const graph = await store.getGraph(graphId);
  if (!graph) return null;
  // Newest first: a promotion needs an unbroken streak of recent verified runs.
  const runs = (await store.listRuns({ graphId, kind: 'graph', limit: RECENT_RUNS }))
    .filter((run) => run.graphId === graphId && isTerminal(run.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const inputs = await Promise.all(
    runs.map(async (run): Promise<RollupInput> => {
      const [steps, egress, scheduleDecisions, events] = await Promise.all([
        store.listSteps(run.id),
        store.listEgress(run.id),
        store.listScheduleDecisions(run.id),
        store.eventsSince(run.id, 0),
      ]);
      const toolLifecycle = events.flatMap(({ event }) =>
        event.type === 'tool.lifecycle' ? [event.lifecycle] : [],
      );
      return { run, steps, egress, scheduleDecisions, toolLifecycle };
    }),
  );
  const [memory, siteBlocks] = await Promise.all([
    store.listTargetMemory(),
    store.listSiteBlocks(),
  ]);
  return buildGraphReuseReport({ graph, runs: inputs, memory, siteBlocks, now: nowIso() });
}
