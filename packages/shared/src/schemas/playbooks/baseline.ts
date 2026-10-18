/**
 * Input schema for the two baseline playbooks — the comparison points a graph
 * run is measured against:
 *
 *   baseline        B0: one frontier-tier LLM call, no tools, no graph,
 *                   no redaction gate.
 *   baseline_agent  B1: one agent on a frontier route with EVERY eligible
 *                   tool exposed and no Jev routing — the "frontier model,
 *                   all tools" baseline the design spec's evaluation names.
 *
 * Both are handed THE SAME TASK the graph was built for: the server resolves
 * the graph's prompt (the chat request that produced it, plus the run's
 * variables and any source text the graph carries) and snapshots it here at
 * creation, the same way a graph run snapshots its graph. Without that the
 * baseline answered a different, much smaller question and every comparison
 * was meaningless.
 */

import { z } from 'zod';
import { graphAssertionSchema } from '../graph.js';

export const baselineAnswerFieldSchema = z.object({
  /** The result field an assertion reads, e.g. "choice". */
  name: z.string().min(1).max(100),
  /** The allowed values, when the graph node it mirrors has a fixed set. */
  options: z.array(z.string().min(1)).optional(),
});

export type BaselineAnswerField = z.infer<typeof baselineAnswerFieldSchema>;

export const baselineInputSchema = z.object({
  /** Legacy demo target. Used as `variables.target` when no variables are given. */
  target: z.string().min(1).max(200).default('ACME-2026-TERM-FEES'),
  /**
   * The graph this attempt is measured against. Without one the baseline
   * falls back to the original fixed demo case file.
   */
  graphId: z.string().min(1).optional(),
  /** The same `{{input.*}}` variables the paired graph run received. */
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Groups a graph run with the baseline runs launched alongside it. */
  pairId: z.string().min(1).max(100).optional(),

  /* Filled in by the server at creation, not by the caller. ---------------- */

  /** The resolved task prompt, snapshotted so a later chat edit can't change it. */
  prompt: z.string().max(60_000).optional(),
  promptSource: z.enum(['conversation', 'description', 'legacy_case_file']).optional(),
  graphVersion: z.number().int().optional(),
  /** The graph's assertions at creation, so success is judged by the same rules. */
  assertions: z.array(graphAssertionSchema).optional(),
  /** Fields the reply must contain so those assertions can be checked. */
  answerFields: z.array(baselineAnswerFieldSchema).optional(),
  outcomeAssertions: z.array(graphAssertionSchema).optional(),
  /** Server-generated experiment snapshot. Caller values are replaced during run creation. */
  benchmarkExperiment: z.record(z.string(), z.unknown()).optional(),
});

export type BaselineInput = z.infer<typeof baselineInputSchema>;

/** B1 takes exactly the same input as B0; only the execution differs. */
export const baselineAgentInputSchema = baselineInputSchema;
export type BaselineAgentInput = BaselineInput;
