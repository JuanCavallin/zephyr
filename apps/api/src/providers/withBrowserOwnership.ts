import type { BrowserAdapter, BrowserControlState, ProviderCallContext } from '@htn/shared';

type Owner = 'agent' | 'human';
const sessionProviders = new Map<
  string,
  {
    providerId: BrowserAdapter['id'];
    runId: string;
    control: SessionOwner;
    prepareResume: (
      input: { sessionId: string; expectedUrl?: string },
      ctx: ProviderCallContext,
    ) => Promise<void>;
  }
>();
/** A closed/disconnected transport invalidates every browser control capability. */
export function notifyBrowserSessionClosed(sessionId: string): void {
  const session = sessionProviders.get(sessionId);
  if (!session) return;
  session.control.phase = 'closed';
  session.control.revision += 1;
  sessionProviders.delete(sessionId);
}
/** The approval service awaits this before storing/emitting an approved handoff. */
export async function prepareBrowserHandoffApproval(input: {
  runId: string;
  sessionId: string;
  expectUrl?: string;
}): Promise<void> {
  const session = sessionProviders.get(input.sessionId);
  if (!session || session.runId !== input.runId)
    throw new Error('Browser handoff session is closed or belongs to another run.');
  await session.prepareResume(
    { sessionId: input.sessionId, ...(input.expectUrl ? { expectedUrl: input.expectUrl } : {}) },
    { runId: input.runId, policyRule: 'human-handoff-approval-preparation' },
  );
}
/** Safe canonical metadata for normal run-resume guards. */
export function browserControlStatesForRun(
  runId: string,
): (BrowserControlState & { sessionId: string; providerId: BrowserAdapter['id'] })[] {
  return [...sessionProviders]
    .filter(([, value]) => value.runId === runId)
    .map(([sessionId, value]) => ({
      sessionId,
      providerId: value.providerId,
      owner: value.control.owner,
      revision: value.control.revision,
      phase: value.control.phase,
    }));
}
/** Actual run-owned backend; never inferred from configured preferred backend or opaque IDs. */
export function resolveBrowserSessionProvider(
  sessionId: string,
  runId: string,
): BrowserAdapter['id'] {
  const session = sessionProviders.get(sessionId);
  if (!session || session.runId !== runId)
    throw new Error('Browser session is not owned by this run.');
  return session.providerId;
}
interface SessionOwner {
  runId: string;
  owner: Owner;
  revision: number;
  phase: BrowserControlState['phase'];
  transitioning?: boolean;
  approvalPrepared?: boolean;
}

/** Server-side run ownership and serialization for every browser backend. */
export function withBrowserOwnership(adapter: BrowserAdapter): BrowserAdapter {
  const sessions = new Map<string, SessionOwner>();
  const tails = new Map<string, Promise<void>>();

  async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(id, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (tails.get(id) === tail) tails.delete(id);
    }
  }

  function check(
    id: string,
    ctx: ProviderCallContext,
    access: 'agent' | 'human' | 'view' | 'cleanup' = 'agent',
  ): void {
    const session = sessions.get(id);
    if (!session || session.runId !== ctx.runId)
      throw new Error('Browser session is not owned by this run.');
    if (session.phase === 'closed' && access !== 'cleanup')
      throw new Error('Browser session is closed.');
    if (access === 'human' && (session.owner !== 'human' || session.phase !== 'human_control'))
      throw new Error('Browser session is not currently handed to a person.');
    if (access === 'agent' && (session.owner === 'human' || session.phase !== 'agent_running'))
      throw new Error('Browser session is under human control.');
  }

  async function revokeAndVerify(
    id: string,
    ctx: ProviderCallContext,
    expectedUrl?: string,
  ): Promise<void> {
    if (!adapter.revokeControl)
      throw new Error('Browser backend cannot prove human control revocation.');
    const revoked = await adapter.revokeControl(id, ctx);
    if (!revoked.ok) throw new Error('Human control revocation failed: ' + revoked.error.message);
    if (!adapter.invalidateSnapshot || !adapter.snapshot)
      throw new Error('Browser backend cannot verify a fresh page before resuming.');
    const invalidated = await adapter.invalidateSnapshot(id, ctx);
    if (!invalidated.ok) throw new Error('Browser snapshot invalidation failed.');
    const current = await adapter.snapshot({ sessionId: id, maxElements: 1 }, ctx);
    if (!current.ok) throw new Error('Browser page verification failed: ' + current.error.message);
    if (expectedUrl) {
      const expected = new URL(expectedUrl);
      const actual = new URL(current.data.url);
      if (
        !['http:', 'https:'].includes(expected.protocol) ||
        expected.username ||
        expected.password ||
        expected.search ||
        expected.hash
      )
        throw new Error(
          'Handoff expected URL must identify an HTTP(S) origin and path without credentials or query data.',
        );
      if (actual.origin !== expected.origin || !actual.pathname.startsWith(expected.pathname))
        throw new Error(
          'Handoff page has not reached the expected origin and path. Take control to complete the manual step before approving.',
        );
    }
    // The verification table is private, discarded, and never sent to Jev/SSE.
    const cleared = await adapter.invalidateSnapshot(id, ctx);
    if (!cleared.ok) throw new Error('Verified browser snapshot could not be cleared.');
  }

  async function prepareResume(
    input: { sessionId: string; expectedUrl?: string },
    ctx: ProviderCallContext,
  ): Promise<void> {
    const owned = sessions.get(input.sessionId);
    if (!owned || owned.runId !== ctx.runId || owned.owner !== 'human')
      throw new Error('Browser handoff is not under human ownership.');
    if (owned.transitioning)
      throw new Error('A browser control transition is already in progress.');
    if (owned.approvalPrepared) return;
    owned.transitioning = true;
    if (owned.phase !== 'verifying') {
      owned.phase = 'verifying';
      owned.revision += 1;
    }
    try {
      await serialized(input.sessionId, () =>
        revokeAndVerify(input.sessionId, ctx, input.expectedUrl),
      );
      if (sessions.get(input.sessionId)?.phase === 'closed' || !sessions.has(input.sessionId))
        throw new Error('Browser handoff closed while verification was in progress.');
      // Keep control frozen between verification and the approval service's
      // persist/emit/settle. Only the approved graph continuation may resume it.
      owned.approvalPrepared = true;
    } finally {
      owned.transitioning = false;
    }
  }

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'prepareResume') return prepareResume;
      if (prop === 'ownershipStatus')
        return async (id: string, ctx: ProviderCallContext) => {
          check(id, ctx, 'view');
          const owned = sessions.get(id)!;
          return { owner: owned.owner, revision: owned.revision, phase: owned.phase };
        };
      if (prop === 'setOwnership')
        return async (
          input: { sessionId: string; owner: Owner; expectedRevision?: number },
          ctx: ProviderCallContext,
        ) => {
          const owned = sessions.get(input.sessionId);
          if (!owned || owned.runId !== ctx.runId)
            throw new Error('Browser session is not owned by this run.');
          if (owned.transitioning)
            throw new Error('A browser control transition is already in progress.');
          if (input.owner === 'human' && owned.approvalPrepared)
            throw new Error('Browser handoff approval is completing.');
          if (input.expectedRevision !== undefined && input.expectedRevision !== owned.revision)
            throw new Error('STALE_BROWSER_REVISION');
          if (
            owned.owner === input.owner &&
            ['agent_running', 'human_control'].includes(owned.phase)
          )
            return;
          // Block all new agent and human input before draining in-flight calls.
          owned.phase = input.owner === 'human' ? 'draining' : 'verifying';
          owned.revision += 1;
          owned.transitioning = true;
          try {
            await serialized(input.sessionId, async () => {
              if (input.owner === 'agent') {
                await revokeAndVerify(input.sessionId, ctx);
              }
              if (owned.phase === 'closed' || !sessions.has(input.sessionId))
                throw new Error('Browser session closed while control was transferring.');
              owned.owner = input.owner;
              owned.phase = input.owner === 'human' ? 'human_control' : 'agent_running';
              owned.approvalPrepared = false;
            });
          } finally {
            owned.transitioning = false;
          }
        };
      if (prop === 'releaseRun')
        return async (runId: string, ctx: ProviderCallContext) => {
          if (runId !== ctx.runId)
            throw new Error('Cannot release browser resources for another run.');
          const entries = [...sessions].filter(([, value]) => value.runId === runId);
          // Cancellation closes the control gate before draining an in-flight
          // verification, so that it cannot approve/resume a released session.
          for (const [, owned] of entries) {
            owned.phase = 'closed';
            owned.revision += 1;
          }
          await Promise.all(
            entries.map(([id]) =>
              serialized(id, async () => {
                try {
                  const result = await target.closeSession(id, ctx);
                  if (!result.ok) throw new Error(result.error.message);
                } finally {
                  sessions.delete(id);
                  sessionProviders.delete(id);
                }
              }),
            ),
          );
        };
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (
        typeof value !== 'function' ||
        ![
          'openSession',
          'act',
          'extract',
          'navigate',
          'closeSession',
          'liveView',
          'snapshot',
          'perform',
          'viewer',
          'captureFrame',
          'humanInput',
          'revokeControl',
          'invalidateSnapshot',
        ].includes(String(prop))
      )
        return value;
      return async (...args: unknown[]) => {
        const ctx = args.at(-1) as ProviderCallContext;
        const first = args[0] as { sessionId?: string } | string | undefined;
        if (prop === 'openSession') {
          const result = (await (value as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          )) as { ok?: boolean; data?: { sessionId?: string } };
          if (result.ok && result.data?.sessionId) {
            const control: SessionOwner = {
              runId: ctx.runId,
              owner: 'agent',
              revision: 0,
              phase: 'agent_running',
            };
            sessions.set(result.data.sessionId, control);
            sessionProviders.set(result.data.sessionId, {
              providerId: target.id,
              runId: ctx.runId,
              control,
              prepareResume,
            });
          }
          return result;
        }
        const id = typeof first === 'string' ? first : first?.sessionId;
        if (!id) throw new Error('Browser operation requires a session id.');
        const cleanup = prop === 'closeSession' && ctx.policyRule.includes('release');
        const watch = prop === 'viewer' && (first as { mode?: string })?.mode === 'watch';
        const access = cleanup
          ? 'cleanup'
          : ['liveView', 'humanInput'].includes(String(prop)) || (prop === 'viewer' && !watch)
            ? 'human'
            : ['captureFrame', 'viewer'].includes(String(prop))
              ? 'view'
              : 'agent';
        check(id, ctx, access);
        return serialized(id, async () => {
          // Ownership may have changed while this call queued.
          check(id, ctx, access);
          if (
            prop === 'humanInput' &&
            (first as { expectedRevision?: number })?.expectedRevision !== undefined &&
            (first as { expectedRevision: number }).expectedRevision !== sessions.get(id)!.revision
          )
            throw new Error('STALE_BROWSER_REVISION');
          const result = (await (value as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          )) as { ok?: boolean };
          if (prop === 'viewer' && result.ok) {
            const owned = sessions.get(id)!;
            Object.assign((result as { data?: object }).data ?? {}, {
              owner: owned.owner,
              revision: owned.revision,
              phase: owned.phase,
            });
          }
          if (prop === 'closeSession' && result.ok) {
            sessions.delete(id);
            sessionProviders.delete(id);
          }
          return result;
        });
      };
    },
  });
}
