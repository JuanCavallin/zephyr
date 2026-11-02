/**
 * Coding-agent task board (docs/cacp-07-task-board.md).
 *
 *   POST  /api/tasks                       decompose a request into a board. 201 { run, tasks, waves }.
 *                                          Nothing runs: the board waits for review.
 *   GET   /api/tasks/inbox                 "Needs you": pending approvals (every run), blocked
 *                                          tasks, queued lease extensions. Oldest first.
 *   GET   /api/tasks/inbox/stream          the same, re-sent over SSE whenever it changes.
 *   GET   /api/tasks/:boardId              { run, tasks, waves }.
 *   PATCH /api/tasks/:boardId              { ops: [...] } split / merge / reorder / scope / update /
 *                                          pin, atomically. 409 for a task already started.
 *   POST  /api/tasks/:boardId/run          start the ready tasks. 202.
 *   POST  /api/tasks/:boardId/cancel       stop scheduling and cancel the board.
 *   POST  /api/tasks/:boardId/tasks/:taskId/resume          blocked -> ready.
 *   POST  /api/tasks/:boardId/tasks/:taskId/extension       ask to widen a task's lease.
 *   POST  /api/tasks/:boardId/extensions/:requestId         { outcome: approve | reject }.
 *   POST  /api/tasks/_demo                 dev only: a fake 3-task board driven by mocks.
 *
 * Task progress arrives as task.* events on /api/runs/:boardId/stream and /api/stream.
 * Merge approvals are ordinary approvals: decide them with POST /api/approvals/:id.
 */

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { assigneeSchema } from '@htn/shared';
import { config } from '../config.js';
import { bus, store } from '../services/runtime.js';
import { boardService } from '../services/board.runtime.js';
import { startDemoBoard } from '../services/tasks.demo.js';
import { BoardError, type BoardService } from '../services/tasks.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

export const tasksRouter: Router = Router();

const HEARTBEAT_MS = 15_000;

const scope = z.array(z.string().min(1).max(500)).min(1).max(50);

export const createBoardBody = z.object({
  request: z.string().trim().min(1).max(20_000),
  repoFiles: z.array(z.string().max(500)).max(5_000).optional(),
  private: z.boolean().optional(),
  base: z.string().min(1).max(200).optional(),
});

export const editOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('split'),
    taskId: z.string(),
    parts: z
      .array(z.object({ title: z.string().min(1).max(300), acceptance: z.string().max(2_000).optional(), writeScope: scope }))
      .min(2)
      .max(10),
  }),
  z.object({
    op: z.literal('merge'),
    taskIds: z.array(z.string()).min(2).max(20),
    title: z.string().min(1).max(300).optional(),
    acceptance: z.string().max(2_000).optional(),
  }),
  z.object({ op: z.literal('reorder'), order: z.array(z.string()).min(1).max(200) }),
  z.object({ op: z.literal('scope'), taskId: z.string(), writeScope: scope }),
  z.object({
    op: z.literal('update'),
    taskId: z.string(),
    title: z.string().min(1).max(300).optional(),
    acceptance: z.string().max(2_000).optional(),
    dependsOn: z.array(z.string()).max(50).optional(),
  }),
  z.object({ op: z.literal('pin'), taskId: z.string(), assignee: assigneeSchema.nullable() }),
]);

const editBody = z.object({ ops: z.array(editOpSchema).min(1).max(50) });
const runBody = z.object({
  concurrency: z.number().int().min(1).max(8).optional(),
  autoMergeGreen: z.boolean().optional(),
});
const resumeBody = z.object({ assignee: assigneeSchema.optional() });
const extensionBody = z.object({ globs: scope });
const decideBody = z.object({ outcome: z.enum(['approve', 'reject']) });
const demoBody = z.object({
  /** Delay between board ticks. Small values are for tests. */
  tickMs: z.number().int().min(1).max(60_000).default(1000),
});

const devOnly: RequestHandler = (_req, _res, next) =>
  next(config.isDev ? undefined : new HttpError(404, 'NOT_FOUND', 'Not found'));

/** BoardError -> HTTP. */
async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BoardError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400;
      throw new HttpError(status, 'BOARD_' + err.code, err.message);
    }
    throw err;
  }
}

/** The routes, over any BoardService. The checks mount them on a private one. */
export function boardRoutes(service: () => BoardService): Router {
  const r = Router();

  r.post('/tasks', validate(createBoardBody), async (req, res) => {
    const body = valid<z.infer<typeof createBoardBody>>(req, 'body');
    res.status(201).json(await call(() => service().createBoard(body)));
  });

  r.get('/tasks/inbox', async (_req, res) => {
    res.json({ items: await service().inbox() });
  });

  r.get('/tasks/inbox/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let closed = false;
    let seq = 0;
    let queued = false;
    const send = async () => {
      if (closed) return;
      const items = await service().inbox();
      if (closed) return;
      res.write('id: ' + ++seq + '\nevent: inbox\ndata: ' + JSON.stringify({ items }) + '\n\n');
    };
    // Coalesce bursts: one re-send per tick, however many changes landed in it.
    const schedule = () => {
      if (queued) return;
      queued = true;
      setImmediate(() => {
        queued = false;
        void send().catch(() => undefined);
      });
    };
    const offBoard = service().onInboxChange(schedule);
    const offBus = bus.subscribeAll((s) => {
      const t = s.event.type;
      if (t === 'approval.requested' || t === 'approval.resolved' || t === 'run.updated') schedule();
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      offBoard();
      offBus();
    });
    await send();
  });

  r.get('/tasks/:boardId', async (req, res) => {
    res.json(await call(() => service().getBoard(param(req, 'boardId'))));
  });

  r.patch('/tasks/:boardId', validate(editBody), async (req, res) => {
    const { ops } = valid<z.infer<typeof editBody>>(req, 'body');
    res.json(await call(() => service().editBoard(param(req, 'boardId'), ops)));
  });

  r.post('/tasks/:boardId/run', validate(runBody), async (req, res) => {
    const body = valid<z.infer<typeof runBody>>(req, 'body');
    res.status(202).json(await call(() => service().runReady(param(req, 'boardId'), body)));
  });

  r.post('/tasks/:boardId/cancel', async (req, res) => {
    await call(() => service().cancel(param(req, 'boardId')));
    res.json(await call(() => service().getBoard(param(req, 'boardId'))));
  });

  r.post('/tasks/:boardId/tasks/:taskId/resume', validate(resumeBody), async (req, res) => {
    const { assignee } = valid<z.infer<typeof resumeBody>>(req, 'body');
    const task = await call(() => service().resumeTask(param(req, 'boardId'), param(req, 'taskId'), assignee));
    res.json({ task });
  });

  r.post('/tasks/:boardId/tasks/:taskId/extension', validate(extensionBody), async (req, res) => {
    const { globs } = valid<z.infer<typeof extensionBody>>(req, 'body');
    res.json(await call(() => service().requestExtension(param(req, 'boardId'), param(req, 'taskId'), globs)));
  });

  r.post('/tasks/:boardId/extensions/:requestId', validate(decideBody), async (req, res) => {
    const { outcome } = valid<z.infer<typeof decideBody>>(req, 'body');
    res.json(await call(() => service().decideExtension(param(req, 'boardId'), param(req, 'requestId'), outcome)));
  });

  return r;
}

// Registered first so `/tasks/:boardId` never captures `_demo`.
tasksRouter.post('/tasks/_demo', devOnly, validate(demoBody), async (req, res) => {
  const { tickMs } = valid<z.infer<typeof demoBody>>(req, 'body');
  const board = await startDemoBoard({ bus, store, tickMs });
  res.status(202).json({ runId: board.run.id, tasks: board.tasks });
});
tasksRouter.use(boardRoutes(boardService));
