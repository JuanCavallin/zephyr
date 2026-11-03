/**
 * Learning loop (docs/cacp-08-learning-loop.md): the "What Zephyr learned" feed and its
 * actions, signals the UI produces, and the profile's export and delete.
 *
 *   GET    /api/learning                          { items: FeedItem[] } entries with evidence and versions.
 *                                                 ?status=active,candidate  ?kind=pref|skill
 *   POST   /api/learning/:id/revert               one-click revert: off, and never auto-reactivated.
 *   POST   /api/learning/:id/restore              { version } roll back to an earlier version.
 *   POST   /api/learning/:id/accept               activate a candidate by hand.
 *   POST   /api/learning/:id/promote              personal -> project. 409 for private entries.
 *   POST   /api/learning/signals/variant-pick     { chosen, rejected[], taskId?, runId?, private? }
 *   POST   /api/learning/signals/feedback         { rating: up|down, comment?, taskId?, runId?, private? }
 *   POST   /api/learning/pass                     run a learning pass now; returns its result.
 *   POST   /api/learning/proposals                { ids?, id? } project knowledge as a local branch.
 *                                                 Never pushed: a person opens the PR.
 *   GET    /api/learning/export                   the whole profile as JSON. Local control required.
 *   DELETE /api/learning                          forget everything. { signals, entries } removed.
 *
 * Learning never changes what the agent may do, so none of this touches policy or grants.
 */

import { Router } from 'express';
import { z } from 'zod';
import { learningService } from '../services/learning.runtime.js';
import { requireLocalControl } from '../services/localControl.js';
import { LearningError, type LearningService } from '../services/learning.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

const statuses = ['candidate', 'active', 'retired'] as const;

const feedQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()) : undefined))
    .pipe(z.array(z.enum(statuses)).optional()),
  kind: z.enum(['pref', 'skill']).optional(),
});

const origin = {
  taskId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
  private: z.boolean().optional(),
};

const restoreBody = z.object({ version: z.number().int().positive() });
const variantPickBody = z.object({
  chosen: z.string().min(1).max(200),
  rejected: z.array(z.string().min(1).max(200)).min(1).max(20),
  ...origin,
});
const feedbackBody = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().min(1).max(2_000).optional(),
  ...origin,
});
const proposalBody = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
});

/** LearningError -> HTTP. */
async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LearningError) throw new HttpError(err.status, 'LEARNING_' + err.code, err.message);
    throw err;
  }
}

/** The routes, over any LearningService. The checks mount them on a private one. */
export function learningRoutes(service: () => LearningService): Router {
  const r = Router();

  r.get('/learning', validate(feedQuery, 'query'), (req, res) => {
    const q = valid<z.infer<typeof feedQuery>>(req, 'query');
    res.json({
      items: service().feed({ ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}) }),
    });
  });

  // The whole profile, private evidence included: local control even though it is a GET.
  r.get('/learning/export', requireLocalControl, (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="zephyr-profile.json"');
    res.json(service().export());
  });

  r.delete('/learning', (_req, res) => {
    res.json(service().deleteAll());
  });

  r.post('/learning/pass', async (_req, res) => {
    res.json(await service().runPass());
  });

  r.post('/learning/proposals', validate(proposalBody), async (req, res) => {
    const body = valid<z.infer<typeof proposalBody>>(req, 'body');
    res.status(201).json(await call(() => service().propose(body)));
  });

  r.post('/learning/signals/variant-pick', validate(variantPickBody), async (req, res) => {
    const { chosen, rejected, ...o } = valid<z.infer<typeof variantPickBody>>(req, 'body');
    res.status(201).json({ signal: await service().variantPick(chosen, rejected, o) });
  });

  r.post('/learning/signals/feedback', validate(feedbackBody), async (req, res) => {
    const { rating, comment, ...o } = valid<z.infer<typeof feedbackBody>>(req, 'body');
    res.status(201).json({ signal: await service().feedback(rating, comment, o) });
  });

  r.post('/learning/:id/revert', async (req, res) => {
    res.json({ entry: await call(() => service().revert(param(req, 'id'))) });
  });

  r.post('/learning/:id/restore', validate(restoreBody), async (req, res) => {
    const { version } = valid<z.infer<typeof restoreBody>>(req, 'body');
    res.json({ entry: await call(() => service().restore(param(req, 'id'), version)) });
  });

  r.post('/learning/:id/accept', async (req, res) => {
    res.json({ entry: await call(() => service().accept(param(req, 'id'))) });
  });

  r.post('/learning/:id/promote', async (req, res) => {
    res.json({ entry: await call(() => service().promote(param(req, 'id'))) });
  });

  return r;
}

export const learningRouter: Router = learningRoutes(learningService);
