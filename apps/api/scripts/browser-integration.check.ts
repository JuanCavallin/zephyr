import assert from 'node:assert/strict';
import type { BrowserAdapter, BrowserBackend, BrowserViewer, ProviderResult } from '@htn/shared';
import { createMockBrowser } from '../src/providers/mockBrowser.js';
import { createLiveBrowserless } from '../src/providers/browserless/live.js';
import {
  withBrowserOwnership,
  resolveBrowserSessionProvider,
  prepareBrowserHandoffApproval,
} from '../src/providers/withBrowserOwnership.js';
import { CredentialStore } from '../src/services/credentials.js';
import type { chromium } from 'playwright-core';

const ctx = { runId: 'browser_protocol_test', policyRule: 'synthetic-browser-verification' };
function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
for (const providerId of ['browserbase', 'browserless', 'localbrowser'] as const) {
  const adapter = withBrowserOwnership(
    createMockBrowser(providerId, { mode: 'mock', keyVar: 'TEST_KEY' }),
  );
  const sessionId = value(
    await adapter.openSession({ startUrl: 'https://example.com' }, ctx),
  ).sessionId;
  assert.equal(resolveBrowserSessionProvider(sessionId, ctx.runId), providerId);
  assert.equal(value(await adapter.viewer!({ sessionId, mode: 'watch' }, ctx)).simulated, true);
  const table = value(await adapter.snapshot!({ sessionId }, ctx));
  value(
    await adapter.perform!(
      {
        sessionId,
        snapshotId: table.snapshotId,
        operation: 'TYPE_TEXT',
        index: 1,
        text: 'fixture',
      },
      ctx,
    ),
  );
  assert.equal(
    (
      await adapter.perform!(
        { sessionId, snapshotId: table.snapshotId, operation: 'CLICK', index: 2 },
        ctx,
      )
    ).ok,
    false,
  );
  await assert.rejects(
    adapter.extract({ sessionId, instruction: '' }, { ...ctx, runId: 'another-run' }),
    /not owned/,
  );
  await adapter.setOwnership!({ sessionId, owner: 'human', expectedRevision: 0 }, ctx);
  await assert.rejects(adapter.snapshot!({ sessionId }, ctx), /human control/);
  assert.equal((await adapter.ownershipStatus!(sessionId, ctx)).revision, 1);
  await assert.rejects(
    adapter.setOwnership!({ sessionId, owner: 'agent', expectedRevision: 0 }, ctx),
    /STALE/,
  );
  await adapter.setOwnership!({ sessionId, owner: 'agent', expectedRevision: 1 }, ctx);
  value(await adapter.snapshot!({ sessionId }, ctx));
  await adapter.releaseRun!(ctx.runId, ctx);
  assert.throws(() => resolveBrowserSessionProvider(sessionId, ctx.runId), /not owned/);
}

// Takeover drains the current operation and blocks new/queued automation before
// granting human ownership. Failed viewer revocation never resumes the agent.
let finishRead!: () => void;
let enteredRead!: () => void;
const entered = new Promise<void>((resolve) => {
  enteredRead = resolve;
});
const pending = new Promise<void>((resolve) => {
  finishRead = resolve;
});
const delayedBase = createMockBrowser('browserbase', { mode: 'mock', keyVar: 'TEST' });
const delayed = withBrowserOwnership({
  ...delayedBase,
  async extract<T>() {
    enteredRead();
    await pending;
    return {
      ok: true as const,
      data: {} as T,
      meta: {
        provider: 'browserbase' as const,
        mode: 'mock' as const,
        op: 'extract',
        latencyMs: 0,
        destination: 'mock://browserbase',
      },
    };
  },
});
const delayedId = value(await delayed.openSession({}, ctx)).sessionId;
const reading = delayed.extract({ sessionId: delayedId, instruction: '' }, ctx);
await entered;
const takeover = delayed.setOwnership!(
  { sessionId: delayedId, owner: 'human', expectedRevision: 0 },
  ctx,
);
assert.equal((await delayed.ownershipStatus!(delayedId, ctx)).phase, 'draining');
await assert.rejects(delayed.snapshot!({ sessionId: delayedId }, ctx), /human control/);
finishRead();
await reading;
await takeover;
assert.equal((await delayed.ownershipStatus!(delayedId, ctx)).phase, 'human_control');
await delayed.releaseRun!(ctx.runId, ctx);
const failing = withBrowserOwnership({
  ...delayedBase,
  async revokeControl() {
    return {
      ok: false as const,
      error: { code: 'UPSTREAM' as const, message: 'revocation unproven', retryable: false },
      meta: {
        provider: 'browserbase' as const,
        mode: 'mock' as const,
        op: 'revokeControl',
        latencyMs: 0,
        destination: 'mock://browserbase',
      },
    };
  },
});
const failingId = value(await failing.openSession({}, ctx)).sessionId;
await failing.setOwnership!({ sessionId: failingId, owner: 'human' }, ctx);
await assert.rejects(
  failing.setOwnership!({ sessionId: failingId, owner: 'agent' }, ctx),
  /revocation failed/,
);
assert.equal((await failing.ownershipStatus!(failingId, ctx)).phase, 'verifying');
await assert.rejects(failing.snapshot!({ sessionId: failingId }, ctx), /human control/);
await failing.releaseRun!(ctx.runId, ctx);

// Cancelling while a handoff drains must invalidate the pending approval's
// verification and close the browser, even if its provider call later succeeds.
let finishRevoke!: () => void;
let enteredRevoke!: () => void;
const revoking = new Promise<void>((resolve) => {
  enteredRevoke = resolve;
});
const revokePending = new Promise<void>((resolve) => {
  finishRevoke = resolve;
});
const cancellable = withBrowserOwnership({
  ...createMockBrowser('browserless', { mode: 'mock', keyVar: 'TEST' }),
  async revokeControl(id, context) {
    enteredRevoke();
    await revokePending;
    return {
      ok: true as const,
      data: null,
      meta: {
        provider: 'browserless' as const,
        mode: 'mock' as const,
        op: 'revokeControl',
        latencyMs: 0,
        destination: 'mock://browserless',
      },
    };
  },
});
const cancelledId = value(await cancellable.openSession({}, ctx)).sessionId;
await cancellable.setOwnership!({ sessionId: cancelledId, owner: 'human' }, ctx);
const preparing = prepareBrowserHandoffApproval({ runId: ctx.runId, sessionId: cancelledId });
const rejectedPrepare = assert.rejects(preparing, /closed/);
await revoking;
const cancelling = cancellable.releaseRun!(ctx.runId, ctx);
assert.equal(
  (await cancellable.ownershipStatus!(cancelledId, ctx).catch(() => ({ phase: 'closed' }))).phase,
  'closed',
);
finishRevoke();
await rejectedPrepare;
await cancelling;
assert.throws(() => resolveBrowserSessionProvider(cancelledId, ctx.runId), /not owned/);

// Exercise the actual Browserless live adapter's connection/CDP/viewer protocol
// against an injected deterministic transport. This is not a hosted-provider test.
const credentialStore = new CredentialStore({ source: 'user' });
credentialStore.put('local-user', 'browserless', 'synthetic-browserless-token');
const commands: { method: string; params: Record<string, unknown> }[] = [];
let url = 'about:blank';
let closed = false;
let typed = '';
const locator = {
  nth: () => locator,
  first: () => locator,
  innerText: async () => 'Synthetic public page',
  click: async () => {
    url += '#clicked';
  },
  fill: async (text: string) => {
    typed = text;
  },
  selectOption: async () => undefined,
};
const cdp = {
  async send(method: string, params: Record<string, unknown>) {
    commands.push({ method, params });
    if (method === 'Browserless.liveURL')
      return {
        error: null,
        liveURLId: 'fixture-link',
        liveURL: 'https://production-sfo.browserless.io/live/fixture-link',
        timeout: 60000,
      };
    if (method === 'Browserless.closeLiveURL') return { error: null, liveURLId: params.liveURLId };
    throw new Error('Unexpected CDP command');
  },
};
const context = { pages: () => [page], newCDPSession: async () => cdp, on: () => undefined };
const page = {
  context: () => context,
  setDefaultTimeout: () => undefined,
  setViewportSize: async () => undefined,
  goto: async (next: string) => {
    url = next;
  },
  url: () => url,
  title: async () => 'Synthetic page',
  locator: () => locator,
  evaluate: async (expression: string) =>
    expression.includes('out.push')
      ? [
          {
            domIndex: 0,
            tag: 'input',
            role: 'textbox',
            type: 'text',
            name: 'Search',
            value: '',
            visible: true,
          },
        ]
      : { exists: true, visible: true, enabled: true, occluded: false },
  waitForTimeout: async () => undefined,
  screenshot: async () => new Uint8Array([255, 216, 255, 217]),
  mouse: { click: async () => undefined, wheel: async () => undefined },
  keyboard: {
    press: async () => undefined,
    insertText: async (text: string) => {
      typed = text;
    },
  },
};
const browser = {
  contexts: () => [context],
  close: async () => {
    closed = true;
  },
};
const connector = (async (endpoint: string) => {
  const requested = new URL(endpoint);
  assert.equal(requested.protocol, 'wss:');
  assert.equal(requested.pathname, '/chromium');
  assert.ok(requested.searchParams.get('token'));
  assert.ok(requested.searchParams.get('timeout'));
  return browser;
}) as unknown as typeof chromium.connectOverCDP;
const adapter = withBrowserOwnership(
  createLiveBrowserless(
    { mode: 'live', keyVar: 'TEST_TOKEN', baseUrl: 'https://production-sfo.browserless.io' },
    connector,
    credentialStore,
  ),
);
const sessionId = value(
  await adapter.openSession({ startUrl: 'https://example.com' }, ctx),
).sessionId;
const watch = value(await adapter.viewer!({ sessionId, mode: 'watch' }, ctx));
assert.equal(watch.kind, 'iframe');
assert.equal(watch.interactive, false);
assert.equal(commands.at(-1)?.params.interactable, false);
await assert.rejects(
  adapter.humanInput!({ sessionId, input: { type: 'text', text: 'should not type' } }, ctx),
  /handed to a person/,
);
const table = value(await adapter.snapshot!({ sessionId }, ctx));
value(
  await adapter.perform!(
    {
      sessionId,
      snapshotId: table.snapshotId,
      operation: 'TYPE_TEXT',
      index: 1,
      text: 'synthetic',
    },
    ctx,
  ),
);
assert.equal(typed, 'synthetic');
await adapter.setOwnership!({ sessionId, owner: 'human', expectedRevision: 0 }, ctx);
value(await adapter.viewer!({ sessionId, mode: 'control' }, ctx));
assert.equal(commands.at(-1)?.params.interactable, true);
value(await adapter.humanInput!({ sessionId, input: { type: 'text', text: 'manual' } }, ctx));
assert.equal(typed, 'manual');
await adapter.setOwnership!({ sessionId, owner: 'agent', expectedRevision: 1 }, ctx);
assert.equal(commands.at(-1)?.method, 'Browserless.closeLiveURL');
assert.equal(
  (
    await adapter.perform!(
      { sessionId, snapshotId: table.snapshotId, operation: 'CLICK', index: 1 },
      ctx,
    )
  ).ok,
  false,
);
value(await adapter.snapshot!({ sessionId }, ctx));
await adapter.releaseRun!(ctx.runId, ctx);
assert.equal(closed, true);
assert.throws(() => resolveBrowserSessionProvider(sessionId, ctx.runId), /not owned/);
console.log(
  'Mock Browserbase/Browserless/local lifecycle, ownership guards, and Browserless live CDP protocol checks passed. Hosted browser connectivity was not tested.',
);
