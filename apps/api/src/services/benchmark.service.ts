/**
 * Loads stored runs and reduces them with the shared benchmark math
 * (@htn/shared benchmark.ts). No numbers are computed here — this file only
 * fetches what buildBenchmarkReport needs.
 */

import {
  BENCHMARK_ARMS,
  benchmarkSample,
  buildBenchmarkReport,
  isTerminal,
  type AgentGraph,
  type BenchmarkReport,
  type BenchmarkWarmth,
  type BenchmarkSample,
  type Run,
} from '@htn/shared';
import { store } from '../store/index.js';

/** Per arm. Enough for a demo's history without scanning an unbounded table. */
const RUNS_PER_ARM = 300;

async function sampleFor(run: Run): Promise<BenchmarkSample | null> {
  const [steps, egress, approvals, scheduleDecisions, events] = await Promise.all([
    store.listSteps(run.id),
    store.listEgress(run.id),
    store.listApprovals(run.id),
    store.listScheduleDecisions(run.id),
    store.eventsSince(run.id, 0),
  ]);
  const toolLifecycle = events.flatMap(({ event }) =>
    event.type === 'tool.lifecycle' ? [event.lifecycle] : [],
  );
  return benchmarkSample({ run, steps, egress, approvals, scheduleDecisions, toolLifecycle });
}

export async function loadBenchmarkSamples(): Promise<{
  samples: BenchmarkSample[];
  graphNames: Record<string, string>;
}> {
  const runsByArm = await Promise.all(
    BENCHMARK_ARMS.map((kind) => store.listRuns({ kind, limit: RUNS_PER_ARM })),
  );
  const terminal = runsByArm.flat().filter((run) => run.graphId && isTerminal(run.status));
  // Only graphs that have at least one baseline run are worth loading.
  const compared = new Set(
    terminal.filter((run) => run.kind !== 'graph').map((run) => run.graphId as string),
  );
  const relevant = terminal.filter((run) => compared.has(run.graphId as string));

  const samples = (await Promise.all(relevant.map(sampleFor))).filter(
    (sample): sample is BenchmarkSample => sample !== null,
  );

  const graphNames: Record<string, string> = {};
  for (const run of relevant) {
    const snapshot = (run.input as { graphSnapshot?: AgentGraph } | null)?.graphSnapshot;
    if (snapshot && run.graphId) graphNames[run.graphId] = snapshot.name;
  }
  await Promise.all(
    [...compared]
      .filter((graphId) => !graphNames[graphId])
      .map(async (graphId) => {
        const graph = await store.getGraph(graphId);
        if (graph) graphNames[graphId] = graph.name;
      }),
  );
  return { samples, graphNames };
}

export async function benchmarkReport(
  includeMocked: boolean,
  warmth: BenchmarkWarmth = 'all',
): Promise<BenchmarkReport> {
  const { samples, graphNames } = await loadBenchmarkSamples();
  return buildBenchmarkReport(samples, graphNames, { includeMocked, warmth });
}
