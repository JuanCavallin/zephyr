/**
 * The run page's Workspace panel: checkpoints, live diff, and user-initiated rewind.
 * Refs are only ever ones the run announced (see services/runWorkspace.service.ts).
 */

import { Router } from 'express';
import { z } from 'zod';
import { HttpError, param } from './middleware/validate.js';
import { assertRunAccess, requireLocalControl } from '../services/localControl.js';
import { RunWorkspaceError, runWorkspace } from '../services/runWorkspace.service.js';

export const runWorkspaceRouter: Router = Router();

function http(err: unknown): never {
  if (err instanceof RunWorkspaceError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

runWorkspaceRouter.get('/runs/:id/workspace', async (req, res) => {
  res.json(await (await runWorkspace()).checkpoints(param(req, 'id')).catch(http));
});

runWorkspaceRouter.get('/runs/:id/workspace/diff', async (req, res) => {
  const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
  res.json(await (await runWorkspace()).diff(param(req, 'id'), since).catch(http));
});

const rewindBody = z.object({ ref: z.string().min(1).max(200) });

runWorkspaceRouter.post('/runs/:id/workspace/rewind', requireLocalControl, async (req, res) => {
  const id = param(req, 'id');
  assertRunAccess(req, id);
  const body = rewindBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, 'VALIDATION', 'Body must be { ref: string }');
  const checkpoint = await (await runWorkspace()).rewind(id, body.data.ref).catch(http);
  res.json({ checkpoint });
});
