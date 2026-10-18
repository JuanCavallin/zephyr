/**
 * Input schema for the `graph` playbook.
 *
 * A graph run is launched by ID, not by value: the run then SNAPSHOTS the graph
 * it loaded into its own input, so editing the graph afterwards never rewrites
 * what an earlier run shows on its page.
 */

import { z } from 'zod';
import { agentGraphSchema } from '../graph.js';

export const graphRunInputSchema = z.object({
  /** The graph to execute. Loaded from the store at run start. */
  graphId: z.string().min(1),
  /** Reachable inside the graph as {{input.*}}. */
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Groups this run with the baseline runs launched alongside it. */
  pairId: z.string().min(1).max(100).optional(),
  /** Server-generated immutable experiment metadata; never trusted from the caller. */
  benchmarkExperiment: z.record(z.string(), z.unknown()).optional(),
  /**
   * Filled in by the orchestrator at run start, not by the caller. This is the
   * snapshot that makes an old run page stable across later edits.
   */
  graphSnapshot: agentGraphSchema.optional(),
});

export type GraphRunInput = z.infer<typeof graphRunInputSchema>;
