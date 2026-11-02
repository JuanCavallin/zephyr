/**
 * Coding-agent task board.
 *
 *   POST /api/tasks/_demo   dev only: seed a fake 3-task board driven by mocks. 202
 *                           { runId, tasks }; progress arrives as task.* events on
 *                           /api/runs/:runId/stream and /api/stream.
 */

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { bus, store } from '../services/runtime.js';
import { startDemoBoard } from '../services/tasks.demo.js';
import { HttpError, valid, validate } from './middleware/validate.js';

export const tasksRouter: Router = Router();

const demoBody = z.object({
  /** Delay between board ticks. Small values are for tests. */
  tickMs: z.number().int().min(1).max(60_000).default(1000),
});

const devOnly: RequestHandler = (_req, _res, next) =>
  next(config.isDev ? undefined : new HttpError(404, 'NOT_FOUND', 'Not found'));

tasksRouter.post('/tasks/_demo', devOnly, validate(demoBody), async (req, res) => {
  const { tickMs } = valid<z.infer<typeof demoBody>>(req, 'body');
  const board = await startDemoBoard({ bus, store, tickMs });
  res.status(202).json({ runId: board.run.id, tasks: board.tasks });
});
