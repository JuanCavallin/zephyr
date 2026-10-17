import assert from 'node:assert/strict';
import type {
  BrowserAdapter,
  BrowserPerformResult,
  ElementTable,
  ProviderCallContext,
  ToolAction,
} from '@htn/shared';
import { createBrowserExecutor } from '../src/core/tools/browser.js';
import { consequentialBrowserAction } from '../src/core/tools/browserRisk.js';
import {
  browserbaseDescriptorsAreSafe,
  browserToolRegistrations,
} from '../src/core/tools/browserDescriptors.js';

const calls = { opened: 0, snapped: 0, performed: 0, closed: 0 };
const table: ElementTable = {
  snapshotId: 'snap_1',
  sessionId: 'session_1',
  url: 'about:blank',
  title: 'Check page',
  capturedAt: new Date().toISOString(),
  rows: [
    {
      index: 1,
      role: 'button',
      label: 'Continue',
      clickable: true,
      editable: false,
      selectable: false,
    },
  ],
  truncated: false,
  totalInteractive: 1,
};

const adapter: BrowserAdapter = {
  id: 'localbrowser',
  mode: 'live',
  capabilities: ['browser.local'],
  async health() {
    return { ok: true, data: {}, meta: meta('health') };
  },
  async invoke() {
    return { ok: false, error: failure('not used'), meta: meta('invoke') };
  },
  async openSession() {
    calls.opened += 1;
    return {
      ok: true,
      data: { sessionId: 'session_' + calls.opened.toString() },
      meta: meta('openSession'),
    };
  },
  async act() {
    return { ok: false, error: failure('not used'), meta: meta('act') };
  },
  async extract<T>() {
    return { ok: true, data: { text: 'result' } as T, meta: meta('extract') };
  },
  async snapshot(input) {
    calls.snapped += 1;
    return {
      ok: true,
      data: { ...table, sessionId: input.sessionId },
      meta: meta('snapshot'),
    };
  },
  async perform(input) {
    calls.performed += 1;
    const result: BrowserPerformResult = {
      operation: input.operation,
      index: input.index,
      url: 'about:blank',
      navigated: false,
    };
    return { ok: true, data: result, meta: meta('perform') };
  },
  async closeSession() {
    calls.closed += 1;
    return { ok: true, data: null, meta: meta('closeSession') };
  },
};

const registrations = browserToolRegistrations({
  localAvailable: true,
  browserbaseAvailable: true,
});
assert.equal(registrations.length, 18);
assert.equal(browserbaseDescriptorsAreSafe(registrations), true);
assert.equal(
  registrations.find((item) => item.descriptor.id === 'browserbase.submit')?.descriptor
    .reversibility,
  'irreversible',
);

const announced: string[] = [];
const executor = createBrowserExecutor({
  provider: () => adapter,
  // The dashboard lists only announced sessions; an agent's `open` must be one.
  onSession: (event) => {
    announced.push(event.phase + ':' + event.sessionId);
  },
  decide: async () => ({
    operation: 'CLICK',
    index: 1,
    confidence: 0.95,
    source: 'jev',
    rationale: 'check decision',
  }),
});

const context: ProviderCallContext = {
  runId: 'run_browser_check',
  stepId: 'step_browser_check',
  policyRule: 'authorized-tool-action',
};
await executor.execute(action('localbrowser.open', { url: 'about:blank' }), context);
assert.deepEqual(announced, ['opened:session_1'], 'an opened session is announced to the run');
const clicked = await executor.execute(
  action('localbrowser.click', { sessionId: 'session_1' }),
  context,
);
assert.equal((clicked.output as { target?: string }).target, 'Continue');
assert.deepEqual(calls, { opened: 1, snapped: 1, performed: 1, closed: 0 });

await assert.rejects(
  executor.execute(
    action('localbrowser.extract', {
      url: 'https://example.com',
      instruction: 'read',
      dataLabels: ['secret'],
    }),
    context,
  ),
  /cannot be sent to a remote website/,
);
assert.equal(calls.opened, 1, 'privacy rejection must happen before browser I/O');

const uncertain = createBrowserExecutor({
  provider: () => adapter,
  decide: async () => ({
    operation: 'CLICK',
    index: 1,
    confidence: 0.4,
    source: 'deterministic',
    rationale: 'weak match',
  }),
});
{
  const risk = (label: string, op: 'CLICK' | 'TYPE_TEXT' = 'CLICK', tool = 'click') =>
    consequentialBrowserAction(tool, op, { label, role: 'button' });
  for (const harmless of ['Apply filters', 'Add to bag', 'Sign in', 'Next page', 'Posts', 'Share'])
    assert.equal(risk(harmless), null, harmless + ' is reversible');
  for (const committing of ['Checkout', 'Place your order', 'Send message', 'Delete', 'Pay now'])
    assert.equal(risk(committing), 'consequential_label', committing + ' commits something');
  assert.equal(risk('Send message', 'TYPE_TEXT', 'type'), null, 'typing is gated at its submit');
  assert.equal(risk('Continue', 'CLICK', 'submit'), 'submit_operation');
}

// Jev's pick is followed at any confidence: a low-confidence click on a
// harmless control runs at once, and the trace says it was a weak pick.
const uncertainAction = action('localbrowser.click', { sessionId: 'session_1' });
const preparation = await uncertain.prepareReview!(uncertainAction, context);
assert.equal(preparation.requiresApproval, false, 'confidence alone never asks a person');
const lowPick = await uncertain.execute(uncertainAction, context);
assert.equal(calls.performed, 2, 'a low-confidence pick on a harmless target executes');
assert.match(lowPick.summary, /low-confidence pick, 0\.40/);

// What the click DOES decides approval: a confident "Place order" waits.
{
  const orderTable: ElementTable = {
    ...table,
    snapshotId: 'snap_order',
    rows: [{ ...table.rows[0]!, label: 'Place order' }],
  };
  let snapshots = 0;
  let failFirst = true;
  const orderAdapter: BrowserAdapter = {
    ...adapter,
    async snapshot(input) {
      snapshots += 1;
      // The page re-renders after review: same element, new snapshot id.
      return {
        ok: true,
        data: { ...orderTable, sessionId: input.sessionId, snapshotId: 'snap_order_' + snapshots },
        meta: meta('snapshot'),
      };
    },
    async perform(input) {
      calls.performed += 1;
      if (failFirst) {
        failFirst = false;
        return {
          ok: false,
          error: { ...failure('stale_snapshot'), code: 'BAD_INPUT' },
          meta: meta('perform'),
        };
      }
      return {
        ok: true,
        data: {
          operation: input.operation,
          index: input.index,
          url: 'about:blank',
          navigated: false,
        },
        meta: meta('perform'),
      };
    },
  };
  const ordering = createBrowserExecutor({
    provider: () => orderAdapter,
    decide: async () => ({
      operation: 'CLICK',
      index: 1,
      confidence: 0.99,
      source: 'jev',
      rationale: 'exact',
    }),
  });
  const order = action('localbrowser.click', { sessionId: 'session_1' });
  const review = await ordering.prepareReview!(order, context);
  assert.equal(
    review.requiresApproval,
    true,
    'a confident consequential click still needs approval',
  );
  assert.equal((review.review as { risk?: string }).risk, 'consequential_label');
  const performedBefore = calls.performed;
  await assert.rejects(ordering.execute(order, context), /requires human review/);
  assert.equal(calls.performed, performedBefore, 'nothing is clicked before approval');
  const done = await ordering.execute(
    { ...order, review: review.review },
    { ...context, policyRule: 'human-approved-exact-tool-action' },
  );
  assert.equal(
    calls.performed,
    performedBefore + 2,
    'a re-rendered approved element is clicked by identity',
  );
  assert.match(done.summary, /Place order/);
}
assert.equal(calls.closed, 0, 'bound sessions are not closed by an action');

assert.equal(calls.closed, 0, 'an explicitly opened session stays available during the run');
await executor.closeRunSessions(context.runId, context);
assert.equal(calls.closed, 1, 'run cleanup releases explicitly opened sessions');
assert.deepEqual(announced, ['opened:session_1', 'closed:session_1']);

// Pooled research: stateless public searches/reads in one run share ONE
// session (a session per call exhausted the Browserbase plan), reads prefer
// the focused region, and a dead pooled session is replaced, not fatal.
{
  const pool = { opened: 0, navigated: 0, closed: 0, scopes: [] as string[], failNavigate: false };
  const pooledAdapter: BrowserAdapter = {
    ...adapter,
    async openSession() {
      pool.opened += 1;
      return { ok: true, data: { sessionId: 'pooled_' + pool.opened }, meta: meta('openSession') };
    },
    async navigate(input) {
      pool.navigated += 1;
      if (pool.failNavigate)
        return { ok: false, error: failure('expired'), meta: meta('navigate') };
      return { ok: true, data: { url: input.url }, meta: meta('navigate') };
    },
    async extract<T>(input: { sessionId: string; instruction: string }) {
      pool.scopes.push(input.instruction);
      // No <main> on this page: the scoped read is thin, the whole page is not.
      const text =
        input.instruction === 'main' ? '' : 'Product page. Price $120. In stock. '.repeat(10);
      return { ok: true, data: { text } as T, meta: meta('extract') };
    },
    async closeSession() {
      pool.closed += 1;
      return { ok: true, data: null, meta: meta('closeSession') };
    },
  };
  const pooled = createBrowserExecutor({
    provider: () => pooledAdapter,
    decide: async () => {
      throw new Error('not used');
    },
  });
  const research = (toolId: string, args: Record<string, string>): ToolAction => ({
    ...action(toolId),
    arguments: args,
  });

  await pooled.execute(research('localbrowser.search', { query: 'black running shoes' }), context);
  const read = await pooled.execute(
    research('localbrowser.read', { url: 'https://example.com/p/1', instruction: 'price' }),
    context,
  );
  assert.equal(pool.opened, 1, 'research calls in one run share a single session');
  assert.equal(pool.navigated, 1, 'the second call navigates the pooled session');
  assert.equal(pool.closed, 0, 'the pooled session stays open between calls');
  assert.deepEqual(pool.scopes.slice(-2), ['main', ''], 'a thin <main> falls back to the page');
  assert.match(JSON.stringify(read.output), /Price \$120/);

  pool.failNavigate = true;
  await pooled.execute(
    research('localbrowser.read', { url: 'https://example.com/p/2', instruction: 'price' }),
    context,
  );
  assert.equal(pool.opened, 2, 'a pooled session that cannot navigate is replaced');
  assert.equal(pool.closed, 1, 'the dead pooled session is released');

  await pooled.closeRunSessions(context.runId, context);
  assert.equal(pool.closed, 2, 'run cleanup releases the pooled session');

  const secret = {
    ...research('localbrowser.read', { url: 'https://example.com', instruction: 'x' }),
  };
  const opensBefore = pool.opened;
  await pooled.execute({ ...secret, dataLabels: ['private'] }, context);
  assert.equal(pool.opened, opensBefore + 1, 'non-public research is never pooled');
}

console.log(
  'PASS: browser tools use trusted descriptors, protect sensitive destinations, resolve bounded targets, release sessions, and pool public research.',
);

function action(
  toolId: string,
  overrides: {
    url?: string;
    instruction?: string;
    sessionId?: string;
    dataLabels?: ToolAction['dataLabels'];
  } = {},
): ToolAction {
  return {
    id: 'act_' + Math.random().toString(36).slice(2),
    runId: context.runId,
    stepId: context.stepId!,
    toolId,
    descriptorVersion: '1',
    operation: toolId,
    arguments: {
      goal: 'Click Continue',
      ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
      ...(overrides.url ? { url: overrides.url } : {}),
      ...(overrides.instruction ? { instruction: overrides.instruction } : {}),
    },
    destination: 'local://chromium',
    dataLabels: overrides.dataLabels ?? ['public'],
    createdAt: new Date().toISOString(),
  };
}

function meta(op: string) {
  return {
    provider: 'localbrowser' as const,
    op,
    mode: 'live' as const,
    latencyMs: 0,
    destination: 'local://chromium',
  };
}

function failure(message: string) {
  return { code: 'BAD_INPUT' as const, message, retryable: false };
}
