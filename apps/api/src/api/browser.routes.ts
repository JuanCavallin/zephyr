import { Router, type Request } from 'express';
import { z } from 'zod';
import type {
  BrowserAdapter,
  BrowserHumanInput,
  BrowserViewer,
  ProviderCallContext,
} from '@htn/shared';
import {
  getRunDetail as defaultGetRunDetail,
  pauseRun as defaultPauseRun,
  resumeRun as defaultResumeRun,
} from '../services/runs.service.js';
import { providers } from '../services/runtime.js';
import { assertRunAccess, requireLocalControl } from '../services/localControl.js';
import { resolveBrowserSessionProvider } from '../providers/withBrowserOwnership.js';
import { HttpError, param } from './middleware/validate.js';
import { KeyedLock } from '../core/locks.js';
import { browserLocation } from '../providers/browserSafety.js';

export interface BrowserRouterDependencies {
  byId: (id: BrowserAdapter['id']) => BrowserAdapter;
  getRunDetail: typeof defaultGetRunDetail;
  pauseRun: typeof defaultPauseRun;
  resumeRun: typeof defaultResumeRun;
}
const transitionSchema = z
  .object({ revision: z.number().int().min(0), idempotencyKey: z.string().min(8).max(128) })
  .strict();
const inputSchema = z
  .object({
    revision: z.number().int().min(0),
    input: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('click'),
          x: z.number().min(0).max(1279),
          y: z.number().min(0).max(719),
        })
        .strict(),
      z
        .object({
          type: z.literal('key'),
          key: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-zA-Z0-9+ _-]+$/),
        })
        .strict(),
      z.object({ type: z.literal('text'), text: z.string().min(1).max(4096) }).strict(),
      z
        .object({
          type: z.literal('scroll'),
          deltaX: z.number().min(-2000).max(2000),
          deltaY: z.number().min(-2000).max(2000),
        })
        .strict(),
    ]),
  })
  .strict();

export function createBrowserRouter(overrides: Partial<BrowserRouterDependencies> = {}): Router {
  const browserRouter = Router();
  const byId = overrides.byId ?? ((id) => providers.byId(id) as BrowserAdapter);
  const getRunDetail = overrides.getRunDetail ?? defaultGetRunDetail;
  const pauseRun = overrides.pauseRun ?? defaultPauseRun;
  const resumeRun = overrides.resumeRun ?? defaultResumeRun;
  const locks = new KeyedLock();
  const transitions = new Map<string, { fingerprint: string }>();
  const pendingFrames = new Set<string>();

  async function resource(req: Request): Promise<{
    runId: string;
    sessionId: string;
    adapter: BrowserAdapter;
    ctx: ProviderCallContext;
  }> {
    const runId = param(req, 'id');
    const sessionId = param(req, 'sessionId');
    assertRunAccess(req, runId);
    if (!(await getRunDetail(runId))) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
    try {
      const providerId = resolveBrowserSessionProvider(sessionId, runId);
      const adapter = byId(providerId);
      if (!adapter.ownershipStatus || !adapter.viewer)
        throw new HttpError(409, 'VIEWER_UNSUPPORTED', 'Browser backend has no supervised viewer.');
      return {
        runId,
        sessionId,
        adapter,
        ctx: { runId, policyRule: 'authenticated-browser-supervision' },
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        404,
        'BROWSER_SESSION_UNAVAILABLE',
        'Browser session is closed or does not belong to this run.',
      );
    }
  }

  async function viewer(
    adapter: BrowserAdapter,
    sessionId: string,
    ctx: ProviderCallContext,
  ): Promise<BrowserViewer> {
    const state = await adapter.ownershipStatus!(sessionId, ctx);
    if (state.phase === 'draining' || state.phase === 'verifying') {
      // Inspecting a frozen handoff must never create a fresh interactive grant.
      return {
        ...state,
        providerId: adapter.id as BrowserViewer['providerId'],
        mode: adapter.mode,
        kind: 'none',
        interactive: false,
        canWatch: false,
        canControl: adapter.mode === 'live',
        width: 1280,
        height: 720,
        ...(adapter.mode === 'mock' ? { simulated: true } : {}),
        reason:
          state.phase === 'verifying'
            ? 'Browser input is frozen while the handoff is verified.'
            : 'Waiting for in-flight browser actions to finish.',
      };
    }
    const result = await adapter.viewer!(
      { sessionId, mode: state.owner === 'human' ? 'control' : 'watch' },
      ctx,
    );
    if (!result.ok) throw new HttpError(409, 'VIEWER_UNAVAILABLE', result.error.message);
    return safeViewer(result.data);
  }

  function safeViewer(value: BrowserViewer): BrowserViewer {
    // Page URLs can contain login codes; the client only needs a safe location label.
    return { ...value, ...(value.pageUrl ? { pageUrl: browserLocation(value.pageUrl) } : {}) };
  }

  browserRouter.get(
    '/runs/:id/browser/:sessionId/live-view',
    requireLocalControl,
    async (req, res) => {
      const { adapter, sessionId, ctx } = await resource(req);
      res.json(await viewer(adapter, sessionId, ctx));
    },
  );

  browserRouter.post(
    '/runs/:id/browser/:sessionId/viewer',
    requireLocalControl,
    async (req, res) => {
      const parsed = z
        .object({ mode: z.enum(['watch', 'control']) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success)
        throw new HttpError(400, 'BAD_INPUT', 'Viewer mode must be watch or control.');
      const { adapter, sessionId, ctx } = await resource(req);
      const state = await adapter.ownershipStatus!(sessionId, ctx);
      if (state.phase === 'draining' || state.phase === 'verifying')
        throw new HttpError(
          409,
          'CONTROL_FROZEN',
          'Browser viewer is frozen during control transfer or verification.',
        );
      const result = await adapter.viewer!({ sessionId, mode: parsed.data.mode }, ctx);
      if (!result.ok) throw new HttpError(409, 'VIEWER_UNAVAILABLE', result.error.message);
      res.json(safeViewer(result.data));
    },
  );

  for (const operation of ['take-control', 'release-control'] as const) {
    browserRouter.post(
      '/runs/:id/browser/:sessionId/' + operation,
      requireLocalControl,
      async (req, res) => {
        const parsed = transitionSchema.safeParse(req.body);
        if (!parsed.success)
          throw new HttpError(
            400,
            'BAD_INPUT',
            'Control requests require a revision and idempotency key.',
          );
        const { adapter, sessionId, runId, ctx } = await resource(req);
        const release = await locks.acquire(runId + ':' + sessionId);
        let result: BrowserViewer;
        try {
          result = await (async () => {
            const key = runId + ':' + sessionId + ':' + parsed.data.idempotencyKey;
            const fingerprint = operation + ':' + parsed.data.revision;
            const previous = transitions.get(key);
            if (previous) {
              if (previous.fingerprint !== fingerprint)
                throw new HttpError(
                  409,
                  'IDEMPOTENCY_CONFLICT',
                  'This idempotency key belongs to a different control request.',
                );
              return viewer(adapter, sessionId, ctx);
            }
            const state = await adapter.ownershipStatus!(sessionId, ctx);
            if (state.revision !== parsed.data.revision)
              throw new HttpError(
                409,
                'STALE_BROWSER_REVISION',
                'Browser control changed. Refresh before trying again.',
              );
            if (!adapter.setOwnership)
              throw new HttpError(
                409,
                'CONTROL_UNSUPPORTED',
                'Backend cannot safely transfer control.',
              );
            const detail = (await getRunDetail(runId))!;
            if (
              operation === 'release-control' &&
              detail.approvals.some((approval) => approval.status === 'pending')
            ) {
              throw new HttpError(
                409,
                'PENDING_APPROVAL',
                'Resolve the pending approval before continuing the agent.',
              );
            }
            if (operation === 'take-control') {
              const capability = await viewer(adapter, sessionId, ctx);
              if (!capability.canControl || capability.simulated)
                throw new HttpError(
                  409,
                  'CONTROL_UNSUPPORTED',
                  'This session cannot accept real human input.',
                );
              if (state.owner !== 'human') await pauseRun(runId);
            }
            try {
              await adapter.setOwnership(
                {
                  sessionId,
                  owner: operation === 'take-control' ? 'human' : 'agent',
                  expectedRevision: state.revision,
                },
                ctx,
              );
            } catch {
              throw new HttpError(
                409,
                'CONTROL_TRANSITION_FAILED',
                'Browser control could not safely transfer. Refresh the current state before retrying.',
              );
            }
            if (operation === 'release-control') await resumeRun(runId);
            const response = await viewer(adapter, sessionId, ctx);
            // Bound process-local idempotency records; no viewer URL is persisted.
            if (transitions.size >= 256) transitions.delete(transitions.keys().next().value!);
            transitions.set(key, { fingerprint });
            return response;
          })();
        } finally {
          release();
        }
        res.json(result);
      },
    );
  }

  browserRouter.get('/runs/:id/browser/:sessionId/frame', requireLocalControl, async (req, res) => {
    const { adapter, sessionId, ctx, runId } = await resource(req);
    if (!adapter.captureFrame)
      throw new HttpError(409, 'VIEWER_UNSUPPORTED', 'This backend uses a native iframe viewer.');
    const key = runId + ':' + sessionId;
    if (pendingFrames.has(key))
      throw new HttpError(429, 'VIEWER_BUSY', 'A frame request is already in progress.');
    pendingFrames.add(key);
    try {
      const frame = await adapter.captureFrame(sessionId, ctx);
      if (!frame.ok) throw new HttpError(409, 'FRAME_UNAVAILABLE', frame.error.message);
      if (frame.data.bytes.byteLength > 2_000_000)
        throw new HttpError(413, 'FRAME_TOO_LARGE', 'Browser frame exceeded the viewer limit.');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(frame.data.bytes));
    } finally {
      pendingFrames.delete(key);
    }
  });

  browserRouter.post(
    '/runs/:id/browser/:sessionId/input',
    requireLocalControl,
    async (req, res) => {
      const parsed = inputSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'BAD_INPUT', 'Invalid browser input.');
      const { adapter, sessionId, ctx } = await resource(req);
      const state = await adapter.ownershipStatus!(sessionId, ctx);
      if (
        state.owner !== 'human' ||
        state.phase !== 'human_control' ||
        state.revision !== parsed.data.revision
      )
        throw new HttpError(
          409,
          'STALE_BROWSER_CONTROL',
          'Human control is inactive or has changed.',
        );
      if (!adapter.humanInput)
        throw new HttpError(
          409,
          'CONTROL_UNSUPPORTED',
          'This backend uses its native human viewer.',
        );
      const result = await adapter.humanInput(
        {
          sessionId,
          input: parsed.data.input as BrowserHumanInput,
          expectedRevision: parsed.data.revision,
        },
        ctx,
      );
      if (!result.ok) throw new HttpError(409, 'INPUT_FAILED', result.error.message);
      // Never log/persist keystrokes, input payloads, or frames.
      res.json({ ok: true, revision: state.revision });
    },
  );
  return browserRouter;
}

export const browserRouter: Router = createBrowserRouter();
