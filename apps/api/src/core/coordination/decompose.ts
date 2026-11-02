/**
 * Request -> reviewable task plan (spec §10 Decomposition).
 *
 * The planner is the same frontier text model the graph synthesiser uses, reached
 * through the `text.model` capability so it works in mock mode with no keys. It is
 * READ-ONLY by construction: it gets a prompt and a repo file list, no tools, and its
 * only output is a JSON plan that is validated here before anything sees it.
 *
 * A plan is never run by this module. `POST /api/tasks` stores it as `pending` tasks
 * for the decomposition review; only "Run ready tasks" starts agents.
 */

import { z } from 'zod';
import { repoPathSchema, type TextModelAdapter } from '@htn/shared';
import { findCycle } from './conflictGraph.js';

export const DECOMPOSE_POLICY_RULE = 'task-decomposition';
export const MAX_PLAN_TASKS = 12;

export const decomposedTaskSchema = z.object({
  /** Plan-local id; the service assigns the stored task id. */
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  acceptance: z.string().min(1).max(2000),
  writeScope: z.array(repoPathSchema).min(1).max(20),
  deps: z.array(z.string().min(1)).default([]),
});
export type DecomposedTask = z.infer<typeof decomposedTaskSchema>;

export const decompositionSchema = z.object({
  tasks: z.array(decomposedTaskSchema).min(1).max(MAX_PLAN_TASKS),
});

export class DecomposeError extends Error {
  readonly code = 'DECOMPOSE_FAILED';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DecomposeError';
  }
}

/**
 * Structural checks zod cannot express: unique ids, deps that exist, no self-dependency,
 * no cycle. Returns the first problem, or null.
 */
export function planProblem(tasks: readonly DecomposedTask[]): string | null {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) return 'duplicate task id ' + t.id;
    ids.add(t.id);
  }
  for (const t of tasks)
    for (const d of t.deps) {
      if (d === t.id) return 'task ' + t.id + ' depends on itself';
      if (!ids.has(d)) return 'task ' + t.id + ' depends on unknown task ' + d;
    }
  const cycle = findCycle(tasks);
  if (cycle) return 'dependency cycle ' + cycle.join(' -> ');
  return null;
}

/** Parse and validate a plan. Throws DecomposeError with the reason. */
export function parsePlan(candidate: unknown): DecomposedTask[] {
  const parsed = decompositionSchema.safeParse(candidate);
  if (!parsed.success)
    throw new DecomposeError('Plan failed validation: ' + parsed.error.issues[0]?.message, parsed.error.issues);
  const problem = planProblem(parsed.data.tasks);
  if (problem) throw new DecomposeError('Plan rejected: ' + problem);
  return parsed.data.tasks;
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start === -1 || end < start ? body.trim() : body.slice(start, end + 1);
}

export function buildDecomposeSystemPrompt(): string {
  return [
    'You split a software change request into a small set of tasks that separate coding agents can do in parallel.',
    'Return ONLY a JSON object: {"tasks":[{"id","title","acceptance","writeScope","deps"}]}.',
    '- id: short kebab-case, unique.',
    '- acceptance: how a reviewer checks the task is done (tests, observable behaviour).',
    '- writeScope: repo-relative POSIX globs the task will WRITE, as narrow as possible (e.g. "apps/web/src/board/**").',
    '- deps: ids of tasks that must finish first. No cycles.',
    'Prefer disjoint write scopes so tasks can run at once.',
    'Never put package.json, lockfiles, route registries, barrel index.ts files or shared schemas in a writeScope:',
    'those are hot files; agents request changes to them as intents.',
    'At most ' + MAX_PLAN_TASKS + ' tasks. No prose outside the JSON.',
  ].join('\n');
}

export const REQUEST_MARKER = '<<<REQUEST>>>';

export function buildDecomposeUserPrompt(args: {
  request: string;
  repoFiles?: readonly string[];
  repairHint?: string;
}): string {
  const files = (args.repoFiles ?? []).slice(0, 400);
  return [
    'Request:',
    REQUEST_MARKER,
    args.request,
    REQUEST_MARKER,
    files.length ? 'Repository files (truncated):\n' + files.join('\n') : 'Repository file list unavailable.',
    args.repairHint ? 'Your previous reply was rejected: ' + args.repairHint + '\nReturn a corrected plan.' : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface DecomposeDependencies {
  complete: TextModelAdapter['complete'];
}

export interface DecomposeRequest {
  /** Ledger key for the planner call (the board run id). */
  runId: string;
  request: string;
  repoFiles?: readonly string[];
}

export interface DecomposeResult {
  tasks: DecomposedTask[];
  attempts: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Ask the planner for a plan; one repair attempt against the real validation error.
 * Throws DecomposeError when both attempts fail or the model call fails.
 */
export async function decompose(
  args: DecomposeRequest,
  deps: DecomposeDependencies,
): Promise<DecomposeResult> {
  let repairHint: string | undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await deps.complete(
      {
        system: buildDecomposeSystemPrompt(),
        prompt: buildDecomposeUserPrompt({ request: args.request, repoFiles: args.repoFiles, repairHint }),
        tier: 'frontier',
        maxTokens: 4096,
        json: true,
      },
      { runId: args.runId, policyRule: DECOMPOSE_POLICY_RULE },
    );
    if (!completion.ok) throw new DecomposeError('Planner call failed: ' + completion.error.message);
    tokensIn += completion.data.tokensIn;
    tokensOut += completion.data.tokensOut;
    let candidate: unknown;
    try {
      candidate = JSON.parse(extractJson(completion.data.text));
    } catch {
      repairHint = 'not valid JSON';
      continue;
    }
    try {
      return { tasks: parsePlan(candidate), attempts: attempt, tokensIn, tokensOut };
    } catch (error) {
      repairHint = (error as Error).message;
    }
  }
  throw new DecomposeError('Planner did not produce a valid plan: ' + repairHint);
}

/* -------------------------------------------------------------------------- */
/* Deterministic planner for mock mode                                         */
/* -------------------------------------------------------------------------- */

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'task'
  );
}

/**
 * The mock text model's plan. One task per bullet/numbered line (or per `;`), each with
 * a disjoint `src/<slug>/**` scope, so the same request always yields the same board.
 * A line containing "after <n>" depends on the n-th task (1-based).
 */
export function heuristicPlan(request: string): { tasks: DecomposedTask[] } {
  const lines = request
    .split(/\r?\n|;/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0);
  const items = (lines.length > 1 ? lines : [request.trim() || 'Do the request']).slice(0, MAX_PLAN_TASKS);
  const seen = new Set<string>();
  const tasks = items.map((line, i) => {
    let id = slug(line);
    while (seen.has(id)) id = id + '-' + (i + 1);
    seen.add(id);
    return { line, id };
  });
  return {
    tasks: tasks.map(({ line, id }, i) => {
      const after = /\bafter (\d+)\b/i.exec(line);
      const depIndex = after ? Number(after[1]) - 1 : -1;
      const deps = depIndex >= 0 && depIndex < i ? [tasks[depIndex]!.id] : [];
      return {
        id,
        title: line.slice(0, 200),
        acceptance: 'Tests covering "' + line.slice(0, 120) + '" pass.',
        writeScope: ['src/' + id + '/**'],
        deps,
      };
    }),
  };
}

/** Pull the request back out of a prompt built by `buildDecomposeUserPrompt`. */
export function requestFromPrompt(prompt: string): string {
  const start = prompt.indexOf(REQUEST_MARKER);
  const end = prompt.indexOf(REQUEST_MARKER, start + REQUEST_MARKER.length);
  if (start === -1 || end === -1) return prompt;
  return prompt.slice(start + REQUEST_MARKER.length, end).trim();
}
