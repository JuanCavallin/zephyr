/**
 * Graph use-cases.
 *
 * ONE RULE GOVERNS THIS FILE: every mutation, however granular, goes through
 * `mutateGraph`, which re-validates the WHOLE document with agentGraphSchema
 * before saving.
 *
 * That is what stops "add a node" and "save the graph" from drifting into two
 * different levels of strictness. A node-level endpoint that skipped the
 * whole-graph parse would be a second way to introduce a cycle, and a cycle
 * hangs the interpreter rather than failing it.
 */

import { agentGraphSchema, type AgentGraph, type GraphEdge, type GraphNode } from '@htn/shared';
import { newId, nowIso } from '../lib/ids.js';
import { store } from '../store/index.js';
import { buildDemoGraph, DEMO_GRAPH_ID } from '../core/graph/demo.graph.js';
import {
  saveGraphOwned,
  saveGraphOwnedUnlocked,
  withGraphWriteLock,
} from './graphCompile.service.js';

export class GraphValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export class GraphConflictError extends Error {
  readonly code = 'VERSION_CONFLICT';
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      'Graph was modified by someone else (you have v' + expected + ', current is v' + actual + ')',
    );
    this.name = 'GraphConflictError';
  }
}

export class GraphNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super('No graph with id "' + id + '"');
    this.name = 'GraphNotFoundError';
  }
}

function parseOrThrow(candidate: unknown): AgentGraph {
  const parsed = agentGraphSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new GraphValidationError('Invalid graph', { issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function listGraphs(): Promise<AgentGraph[]> {
  return store.listGraphs();
}

export async function getGraph(id: string): Promise<AgentGraph | null> {
  return store.getGraph(id);
}

export async function createGraph(input: {
  name?: string;
  description?: string;
  nodes?: unknown[];
  edges?: unknown[];
  assertions?: unknown[];
}): Promise<AgentGraph> {
  const at = nowIso();
  return saveGraphOwned(
    parseOrThrow({
      id: newId('graph'),
      name: input.name ?? 'Untitled graph',
      description: input.description,
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
      ...(input.assertions ? { assertions: input.assertions } : {}),
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
  );
}

export async function deleteGraph(id: string): Promise<boolean> {
  return store.deleteGraph(id);
}

/**
 * THE mutation path. Load, apply, re-validate the whole document, bump the
 * version, save.
 *
 * `expectedVersion` is optimistic concurrency: the chat (which rewrites whole
 * graphs) and the canvas (which nudges single nodes) will both write to the
 * same document, and without this the later write silently wins. That bug is
 * almost invisible in a demo and very annoying in practice.
 */
export async function mutateGraph(
  id: string,
  expectedVersion: number | undefined,
  apply: (graph: AgentGraph) => AgentGraph,
): Promise<AgentGraph> {
  // Serialised with the compile step's writes, so the version check and the
  // save are one step and a late compile can never overwrite this edit.
  return withGraphWriteLock(id, async () => {
    const current = await store.getGraph(id);
    if (!current) throw new GraphNotFoundError(id);

    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new GraphConflictError(expectedVersion, current.version);
    }

    const next = parseOrThrow({
      ...apply(structuredClone(current)),
      id: current.id,
      createdAt: current.createdAt,
      version: current.version + 1,
      updatedAt: nowIso(),
    });

    return saveGraphOwnedUnlocked(next);
  });
}

/* -------------------------------------------------------------------------- */
/* Node and edge operations, all built on mutateGraph                         */
/* -------------------------------------------------------------------------- */

export function addNode(graph: AgentGraph, node: GraphNode): AgentGraph {
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function patchNode(
  graph: AgentGraph,
  nodeId: string,
  patch: Partial<GraphNode>,
): AgentGraph {
  const index = graph.nodes.findIndex((n) => n.id === nodeId);
  if (index === -1) throw new GraphValidationError('No node "' + nodeId + '" in this graph');

  const existing = graph.nodes[index] as GraphNode;
  const merged = {
    ...existing,
    ...patch,
    id: existing.id,
    // A type change means a different config shape, so merging configs across
    // types would produce a document that cannot parse. Replace wholesale.
    config:
      patch.type && patch.type !== existing.type
        ? patch.config
        : { ...existing.config, ...(patch.config ?? {}) },
  } as GraphNode;

  const nodes = [...graph.nodes];
  nodes[index] = merged;
  return { ...graph, nodes };
}

/**
 * Removing a node CASCADES to its edges. Without this the caller would have to
 * clean up first, and forgetting would surface as a confusing "edge references
 * a node that does not exist" from the validator.
 */
export function removeNode(graph: AgentGraph, nodeId: string): AgentGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
  };
}

export function addEdge(graph: AgentGraph, edge: GraphEdge): AgentGraph {
  return { ...graph, edges: [...graph.edges, edge] };
}

export function removeEdge(graph: AgentGraph, edgeId: string): AgentGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Put the demo graph in the store at boot if it is not already there, so the
 * canvas is never empty on a cold start. Never overwrites: an edited demo graph
 * stays edited across restarts when PERSIST_TO_DISK is on.
 */
export async function seedGraphs(): Promise<void> {
  const existing = await store.getGraph(DEMO_GRAPH_ID);
  if (existing) return;
  await saveGraphOwned(parseOrThrow(buildDemoGraph(nowIso())));
  console.log('[graphs] seeded "' + DEMO_GRAPH_ID + '"');
}
