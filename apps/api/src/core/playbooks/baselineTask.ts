/**
 * What a baseline run is asked to do: THE SAME TASK as the graph it is
 * measured against.
 *
 * Pure. runs.service resolves the inputs (the graph and the chat requests
 * that produced it) and snapshots the result into the baseline run's input;
 * the baseline playbooks only read that snapshot.
 *
 * The prompt is built from what the graph itself was given:
 *   1. the request — the user turns of the chat that authored the graph, or
 *      the graph's description when it was not authored by chat (the seeded
 *      demo graph);
 *   2. the run's `{{input.*}}` variables;
 *   3. any source text the graph carries inline (fetch nodes with `text`) —
 *      the document the graph processes, raw, exactly as the graph's own
 *      first node sees it.
 */

import { createHash } from 'node:crypto';
import {
  BENCHMARK_PROTOCOL,
  outcomeAssertionsForGraph,
  type BenchmarkExperiment,
  type AgentGraph,
  type BaselineAnswerField,
  type BaselineInput,
  type GraphAssertion,
} from '@htn/shared';

export interface BaselineTask {
  prompt: string;
  promptSource: NonNullable<BaselineInput['promptSource']>;
  answerFields: BaselineAnswerField[];
}

/**
 * Only assertions on nodes that PRODUCE AN ANSWER become fields the baseline
 * is asked to fill. An assertion on a pipeline property (e.g. "the redact node
 * pinned N spans") is something one call cannot do; asking the model to type
 * a number into it would turn a real gap into a guess, so it is left to fail.
 */
export function answerFieldsFor(
  graph: AgentGraph,
  assertions: GraphAssertion[] = graph.assertions ?? [],
): BaselineAnswerField[] {
  const fields = new Map<string, BaselineAnswerField>();
  const outcomeIds = new Set(
    outcomeAssertionsForGraph({ ...graph, assertions }).map((item) => item.id),
  );
  for (const assertion of assertions) {
    const [root, nodeId, ...rest] = assertion.path.split('.');
    const name = rest.at(-1);
    if (
      !outcomeIds.has(assertion.id) ||
      root !== 'nodes' ||
      !nodeId ||
      !name ||
      fields.has(assertion.id)
    )
      continue;
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) continue;
    fields.set(assertion.id, {
      name: assertion.id,
      ...(node.type === 'judge' ? { options: [...node.config.options] } : {}),
    });
  }
  return [...fields.values()];
}

/** Substitute `{{input.x}}` from the run variables; leave every other ref alone. */
function withInputs(text: string, variables: Record<string, unknown>): string {
  return text.replace(/\{\{\s*input\.([\w-]+)\s*\}\}/g, (match, key: string) =>
    key in variables ? String(variables[key]) : match,
  );
}

export function buildBaselineTask(args: {
  graph: AgentGraph;
  /** User turns of the chat(s) that authored this graph, oldest first. */
  requests: string[];
  variables: Record<string, unknown>;
}): BaselineTask {
  const { graph, requests, variables } = args;
  const sections: string[] = [];

  const promptSource: BaselineTask['promptSource'] =
    requests.length > 0 ? 'conversation' : 'description';
  if (requests.length === 1) {
    sections.push(requests[0]!);
  } else if (requests.length > 1) {
    sections.push(
      'Original request: ' +
        requests[0] +
        requests
          .slice(1)
          .map((text) => '\n\nRefinement: ' + text)
          .join(''),
    );
  } else {
    sections.push('Task: ' + (graph.description?.trim() || graph.name));
  }

  if (Object.keys(variables).length > 0) {
    sections.push('Inputs:\n' + JSON.stringify(variables, null, 2));
  }

  for (const node of graph.nodes) {
    if (node.type !== 'fetch' || !node.config.text) continue;
    sections.push(
      'Source material (' +
        (node.label ?? node.id) +
        '):\n' +
        withInputs(node.config.text, variables),
    );
  }

  // Keep manually edited task requirements in scope without handing the baseline a graph plan.
  const requirements = graph.nodes.flatMap((node) => {
    const config = node.config as Record<string, unknown>;
    const items = ['goal', 'prompt', 'question', 'instruction', 'workerPrompt'].flatMap((key) =>
      typeof config[key] === 'string' ? [withInputs(config[key] as string, variables)] : [],
    );
    return items;
  });
  if (requirements.length)
    sections.push('Task requirements:\n' + [...new Set(requirements)].join('\n\n'));

  return { prompt: sections.join('\n\n'), promptSource, answerFields: answerFieldsFor(graph) };
}

/**
 * The reply contract both baselines are held to. The answer field names (and
 * any fixed option set) are given; the expected VALUES never are.
 */
export function answerContract(fields: BaselineAnswerField[]): string {
  const extra = fields
    .map(
      (field) =>
        '"' +
        field.name +
        '": ' +
        (field.options
          ? field.options.map((option) => '"' + option + '"').join(' | ')
          : '<string>'),
    )
    .join(', ');
  return (
    'Reply with a single JSON object and nothing else: {"answer": <string, your complete ' +
    'result>, "outcomes": {' +
    extra +
    '}' +
    ', "confidence": <0-1, your own self-reported confidence>, "rationale": <string>}.'
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * The graph as its author wrote it. `compiled` is a server-owned cache a run may
 * rewrite (learned decisions) without a version bump, and timestamps change with
 * it; hashing either would give every warm run a new experiment, so it could no
 * longer pair with the baselines launched for the same task.
 */
function authoredGraph(
  graph: AgentGraph,
): Omit<AgentGraph, 'compiled' | 'createdAt' | 'updatedAt'> {
  const { compiled: _compiled, createdAt: _createdAt, updatedAt: _updatedAt, ...authored } = graph;
  return authored;
}

/** configuration must contain non-secret effective modes/models/tool versions/budgets only. */
export function buildBenchmarkExperiment(args: {
  graph: AgentGraph;
  requests: string[];
  variables: Record<string, unknown>;
  configuration: unknown;
  toolIds: string[];
}): { task: BaselineTask; experiment: BenchmarkExperiment } {
  const task = buildBaselineTask(args);
  const outcomeAssertions = outcomeAssertionsForGraph(args.graph);
  const components = {
    protocol: BENCHMARK_PROTOCOL,
    taskHash: hash(task.prompt),
    graphHash: hash(authoredGraph(args.graph)),
    configHash: hash(args.configuration),
    inputsHash: hash(args.variables),
    assertionsHash: hash(outcomeAssertions),
    graphVersion: args.graph.version,
    toolIds: [...new Set(args.toolIds)].sort(),
  };
  return {
    task,
    experiment: {
      ...components,
      source: 'server',
      fingerprint: hash(components),
      outcomeAssertions,
    },
  };
}

/** Pull the reply object out of model text, tolerating prose around the JSON. */
export function parseBaselineReply(reply: unknown): Record<string, unknown> | null {
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    return reply as Record<string, unknown>;
  }
  if (typeof reply !== 'string') return null;
  const candidates = [reply.trim()];
  const first = reply.indexOf('{');
  const last = reply.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(reply.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
