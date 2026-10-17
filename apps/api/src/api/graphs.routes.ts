/**
 * Graph CRUD, including node- and edge-level operations.
 *
 * Every granular route below delegates to graphs.service's `mutateGraph`, which
 * re-validates the whole document. No route may write to the store directly —
 * that is what keeps "add one node" and "save the whole graph" honest about the
 * same invariants (unique ids, resolvable edges, no cycles).
 */

import { Router } from 'express';
import { graphEdgeSchema, graphNodeSchema } from '@htn/shared';
import { z } from 'zod';
import {
  addEdge,
  addNode,
  createGraph,
  deleteGraph,
  getGraph,
  listGraphs,
  mutateGraph,
  patchNode,
  removeEdge,
  removeNode,
} from '../services/graphs.service.js';
import { optimizeGraph } from '../services/optimization.service.js';
import { graphReuseReport } from '../services/reuse.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

export const graphsRouter: Router = Router();

const createGraphSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  nodes: z.array(z.unknown()).optional(),
  edges: z.array(z.unknown()).optional(),
});

/** Optimistic concurrency. Omit to force the write through. */
const versionSchema = z.object({ version: z.number().int().min(1).optional() });

const putGraphSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  version: z.number().int().min(1).optional(),
});

const patchNodeSchema = z
  .object({
    label: z.string().min(1).max(160).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    background: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .merge(versionSchema);

/* ------------------------------------------------------------------ Graphs */

graphsRouter.get('/graphs', async (_req, res) => {
  res.json({ graphs: await listGraphs() });
});

graphsRouter.post('/graphs', validate(createGraphSchema), async (req, res) => {
  const body = valid<z.infer<typeof createGraphSchema>>(req, 'body');
  res.status(201).json({ graph: await createGraph(body) });
});

/** Reuse across recent runs: frozen decisions, remembered targets, site alerts. */
graphsRouter.get('/graphs/:id/reuse', async (req, res) => {
  const report = await graphReuseReport(param(req, 'id'));
  if (!report) throw new HttpError(404, 'NOT_FOUND', 'Graph not found');
  res.json(report);
});

graphsRouter.get('/graphs/:id', async (req, res) => {
  const graph = await getGraph(param(req, 'id'));
  if (!graph) throw new HttpError(404, 'NOT_FOUND', 'Graph not found');
  res.json({ graph });
});

graphsRouter.put('/graphs/:id', validate(putGraphSchema), async (req, res) => {
  const body = valid<z.infer<typeof putGraphSchema>>(req, 'body');
  const graph = await mutateGraph(param(req, 'id'), body.version, (current) => ({
    ...current,
    name: body.name ?? current.name,
    description: body.description ?? current.description,
    nodes: body.nodes as typeof current.nodes,
    edges: body.edges as typeof current.edges,
  }));
  res.json({ graph });
});

graphsRouter.delete('/graphs/:id', async (req, res) => {
  const removed = await deleteGraph(param(req, 'id'));
  if (!removed) throw new HttpError(404, 'NOT_FOUND', 'Graph not found');
  res.status(204).end();
});

/**
 * Self-improving graph generation. Critiques this graph's own run history,
 * asks the existing synthesiser for an improvement, and lands the result as a
 * NEW forked graph -- this graph itself is never mutated, never auto-applied.
 */
graphsRouter.post('/graphs/:id/optimize', async (req, res) => {
  const result = await optimizeGraph(param(req, 'id'));
  res.status(201).json(result);
});

/* ------------------------------------------------------------------- Nodes */

graphsRouter.post(
  '/graphs/:id/nodes',
  validate(z.object({ node: z.unknown(), version: z.number().int().min(1).optional() })),
  async (req, res) => {
    const body = valid<{ node: unknown; version?: number }>(req, 'body');
    const parsed = graphNodeSchema.safeParse(body.node);
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid node', { issues: parsed.error.issues });
    }
    const graph = await mutateGraph(param(req, 'id'), body.version, (current) =>
      addNode(current, parsed.data),
    );
    res.status(201).json({ graph });
  },
);

graphsRouter.patch('/graphs/:id/nodes/:nodeId', validate(patchNodeSchema), async (req, res) => {
  const body = valid<z.infer<typeof patchNodeSchema>>(req, 'body');
  const { version, ...patch } = body;
  const graph = await mutateGraph(param(req, 'id'), version, (current) =>
    patchNode(current, param(req, 'nodeId'), patch as never),
  );
  res.json({ graph });
});

graphsRouter.delete('/graphs/:id/nodes/:nodeId', validate(versionSchema), async (req, res) => {
  const body = valid<z.infer<typeof versionSchema>>(req, 'body');
  // Cascades to any edge touching this node — see removeNode.
  const graph = await mutateGraph(param(req, 'id'), body?.version, (current) =>
    removeNode(current, param(req, 'nodeId')),
  );
  res.json({ graph });
});

/* ------------------------------------------------------------------- Edges */

graphsRouter.post(
  '/graphs/:id/edges',
  validate(z.object({ edge: z.unknown(), version: z.number().int().min(1).optional() })),
  async (req, res) => {
    const body = valid<{ edge: unknown; version?: number }>(req, 'body');
    const parsed = graphEdgeSchema.safeParse(body.edge);
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid edge', { issues: parsed.error.issues });
    }
    const graph = await mutateGraph(param(req, 'id'), body.version, (current) =>
      addEdge(current, parsed.data),
    );
    res.status(201).json({ graph });
  },
);

graphsRouter.delete('/graphs/:id/edges/:edgeId', validate(versionSchema), async (req, res) => {
  const body = valid<z.infer<typeof versionSchema>>(req, 'body');
  const graph = await mutateGraph(param(req, 'id'), body?.version, (current) =>
    removeEdge(current, param(req, 'edgeId')),
  );
  res.json({ graph });
});
