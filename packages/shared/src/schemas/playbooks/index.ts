/**
 * Registry of playbook INPUT schemas, shared by the API (to validate) and the web
 * app (to build the launch form).
 *
 * TO ADD A PLAYBOOK: write `<kind>.ts` next to this file, then add one line below.
 * That is the entire client-side cost of a product pivot.
 */

import type { ZodType } from 'zod';
import { agentInputSchema } from './agent.js';
import { baselineAgentInputSchema, baselineInputSchema } from './baseline.js';
import { demoInputSchema } from './demo.js';
import { graphRunInputSchema } from './graph.js';

export * from './agent.js';
export * from './baseline.js';
export * from './demo.js';
export * from './graph.js';

export const PLAYBOOK_INPUT_SCHEMAS = {
  agent: agentInputSchema,
  baseline: baselineInputSchema,
  baseline_agent: baselineAgentInputSchema,
  demo: demoInputSchema,
  graph: graphRunInputSchema,
} as const satisfies Record<string, ZodType>;

export type PlaybookKind = keyof typeof PLAYBOOK_INPUT_SCHEMAS;

export const PLAYBOOK_KINDS = Object.keys(PLAYBOOK_INPUT_SCHEMAS) as PlaybookKind[];

export function getPlaybookInputSchema(kind: string): ZodType | undefined {
  return (PLAYBOOK_INPUT_SCHEMAS as Record<string, ZodType>)[kind];
}
