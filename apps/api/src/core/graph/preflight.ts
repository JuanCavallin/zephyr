/**
 * Static checks a SAVED graph must pass against the CURRENT code.
 *
 * A graph is validated when it is synthesised or edited, but a saved graph can
 * go stale afterwards: a convention changes (tool outputs moved under
 * `.result`), or a tool leaves the catalog. Without a re-check, a stale graph
 * is discovered only when one of its nodes fails mid-run -- sometimes after a
 * paid browser session is already open. These checks run before a run starts
 * (runs.service.ts) and over every stored graph (scripts/stored-graphs.check.ts).
 *
 * Only issues that are CERTAIN to fail at run time belong here. Anything that
 * merely might fail (an optional text ref in a skipped branch) stays a run-time
 * warning in the interpreter.
 */

import { agentGraphSchema, graphAncestorIds, type AgentGraph } from '@htn/shared';
import { collectRefs } from './refs.js';

export interface GraphPreflightIssue {
  kind: 'schema' | 'tool' | 'ref';
  /** error: certain to break the run, so it must not start. warning: degraded but runnable. */
  severity: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

/** Node types whose run-time value is `{ tool, result }` (interpreter runTool/runSubmit). */
const TOOL_OUTPUT_NODES = new Set(['tool', 'submit']);
const TOOL_OUTPUT_KEYS = new Set(['tool', 'result']);

/** Every catalog tool id a graph names, by node. */
export function referencedGraphTools(graph: AgentGraph): Map<string, string[]> {
  const byNode = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const config = node.config as Record<string, unknown>;
    const tools: string[] = [];
    const add = (value: unknown) => {
      if (typeof value === 'string') tools.push(value);
    };
    if (node.type === 'tool' || node.type === 'submit') add(config.tool);
    if (node.type === 'dispatch') {
      for (const tool of Array.isArray(config.candidateTools) ? config.candidateTools : []) add(tool);
      if (config.args && typeof config.args === 'object' && !Array.isArray(config.args)) {
        for (const tool of Object.keys(config.args as object)) add(tool);
      }
    }
    if (node.type === 'agent_task') {
      for (const tool of Array.isArray(config.availableTools) ? config.availableTools : []) add(tool);
      for (const tool of Array.isArray(config.toolCeiling) ? config.toolCeiling : []) add(tool);
    }
    if (node.type === 'swarm') add(config.workerTool);
    if (tools.length > 0) byNode.set(node.id, [...new Set(tools)]);
  }
  return byNode;
}

/** Tool ids the graph names that the catalog does not contain, sorted. */
export function unknownGraphTools(graph: AgentGraph, catalog: ReadonlySet<string>): string[] {
  const referenced = new Set([...referencedGraphTools(graph).values()].flat());
  return [...referenced].filter((tool) => !catalog.has(tool)).sort();
}

/**
 * Everything wrong with `candidate` under the current schema, catalog and ref
 * rules. Empty means the graph can start. Pass `catalog: null` to skip the
 * tool check (e.g. when the catalog could not be loaded).
 */
export function graphPreflightIssues(
  candidate: unknown,
  catalog: ReadonlySet<string> | null,
): GraphPreflightIssue[] {
  const parsed = agentGraphSchema.safeParse(candidate);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 5).map((issue) => ({
      kind: 'schema' as const,
      severity: 'error' as const,
      message: (issue.path.join('.') || '(graph)') + ': ' + issue.message,
    }));
  }
  const graph = parsed.data;
  const issues: GraphPreflightIssue[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  if (catalog) {
    for (const [nodeId, tools] of referencedGraphTools(graph)) {
      // A tool/submit/swarm node CALLS its tool, so a missing one fails the
      // node. Agent and dispatch nodes only offer a list; the run drops
      // unavailable entries with a warning and carries on.
      const executes = ['tool', 'submit', 'swarm'].includes(byId.get(nodeId)?.type ?? '');
      for (const tool of tools.filter((id) => !catalog.has(id))) {
        issues.push({
          kind: 'tool',
          severity: executes ? 'error' : 'warning',
          nodeId,
          message: 'uses tool "' + tool + '", which is not in the current tool catalog',
        });
      }
    }
  }

  for (const node of graph.nodes) {
    const ancestors = new Set(graphAncestorIds(node.id, graph.edges));
    for (const ref of collectRefs(node.config)) {
      const [root, next] = ref.split('.');
      if (root === 'input' || root === undefined) continue;
      // A swarm worker's {{item}} is bound per worker by the interpreter
      // (workerScope in interpreter.ts), not by a node.
      if (root === 'item' && node.type === 'swarm') continue;
      const source = byId.get(root);
      if (!source) {
        issues.push({ kind: 'ref', severity: 'error', nodeId: node.id, message: '{{' + ref + '}}: no node "' + root + '"' });
        continue;
      }
      if (!ancestors.has(root)) {
        issues.push({
          kind: 'ref',
          severity: 'error',
          nodeId: node.id,
          message: '{{' + ref + '}}: "' + root + '" is not upstream of this node, so it never resolves',
        });
        continue;
      }
      if (TOOL_OUTPUT_NODES.has(source.type) && next !== undefined && !TOOL_OUTPUT_KEYS.has(next)) {
        const fixed = [root, 'result', ...ref.split('.').slice(1)].join('.');
        issues.push({
          kind: 'ref',
          severity: 'error',
          nodeId: node.id,
          message: '{{' + ref + '}}: tool output lives under .result -- use {{' + fixed + '}}',
        });
      }
    }
  }
  return issues;
}

export function formatPreflightIssues(issues: GraphPreflightIssue[]): string {
  return issues
    .map((issue) => (issue.nodeId ? 'node "' + issue.nodeId + '" ' : '') + issue.message)
    .join('; ');
}
