/**
 * Cross-run browser target memory: identity replay across runs, eviction,
 * privacy, and a person's correction flowing through the real broker.
 *
 * No browser, no network: deterministic doubles and the in-memory store.
 *
 *   pnpm --filter @htn/api check:target-memory
 */

import assert from 'node:assert/strict';
import type {
  ActionPolicyRecommendation,
  BrowserAdapter,
  DecisionAdapter,
  ElementRow,
  ElementTable,
  Json,
} from '@htn/shared';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { ToolBroker } from '../src/core/tools/broker.js';
import { createBrowserExecutor } from '../src/core/tools/browser.js';
import type { BrowserDecider, BrowserDecisionRequest } from '../src/core/tools/browserDecision.js';
import { browserToolRegistrations } from '../src/core/tools/browserDescriptors.js';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import {
  createTargetMemory,
  normalizedGoal,
  pageTemplate,
  targetMemoryKey,
} from '../src/core/tools/targetMemory.js';
import { createMemoryStore } from '../src/store/memory.js';

let checks = 0;
async function check(label: string, work: () => void | Promise<void>): Promise<void> {
  await work();
  checks += 1;
  console.log('  [PASS] ' + label);
}

const row = (index: number, label: string, role = 'button'): ElementRow => ({
  index,
  role,
  label,
  clickable: true,
  editable: false,
  selectable: false,
});
const tableOf = (
  rows: ElementRow[],
  url = 'https://shop.example/product/123?q=x#top',
): ElementTable => ({
  snapshotId: 'snap_' + Math.random().toString(36).slice(2),
  sessionId: 'session_1',
  url,
  title: 'Shop',
  capturedAt: new Date().toISOString(),
  rows,
  truncated: false,
  totalInteractive: rows.length,
});
function countingDecider(pick: (request: BrowserDecisionRequest) => number) {
  const counts = { calls: 0 };
  const decide: BrowserDecider = async (request) => {
    counts.calls += 1;
    return {
      operation: 'CLICK',
      index: pick(request),
      confidence: 0.9,
      source: 'jev',
      rationale: 'test',
    };
  };
  return { decide, counts };
}
const request = (
  table: ElementTable,
  extra: Partial<BrowserDecisionRequest> = {},
): BrowserDecisionRequest => ({
  goal: 'Click the Add to bag button',
  table,
  allowedOperations: ['CLICK'],
  memoryScope: 'graph_1|buy_node',
  ...extra,
});

console.log('Keys');
await check('goal wording and id segments do not split one page', () => {
  assert.equal(normalizedGoal('Click the "Add to bag" button'), normalizedGoal('add to bag'));
  assert.deepEqual(pageTemplate('https://shop.example/product/123?q=x'), {
    origin: 'https://shop.example',
    pathTemplate: '/product/*',
  });
  assert.equal(
    targetMemoryKey({
      scope: 's',
      url: 'https://shop.example/product/1',
      goal: 'press Add to bag',
    }),
    targetMemoryKey({
      scope: 's',
      url: 'https://shop.example/product/999?ref=a',
      goal: 'add to bag',
    }),
  );
  assert.equal(pageTemplate('data:text/html,hi'), undefined, 'only web pages are remembered');
  assert.equal(pageTemplate('file:///C:/secret.html'), undefined);
});

console.log('Decider layer');
await check('a second run on a shifted page replays the element with no model call', async () => {
  const store = createMemoryStore();
  const memory = createTargetMemory(store);
  const { decide, counts } = countingDecider(() => 2);
  const decider = memory.decider(decide);
  await decider(request(tableOf([row(1, 'Size guide'), row(2, 'Add to bag')])));
  assert.equal(counts.calls, 1);
  // A banner shifted every index by one; identity still finds the element.
  const replay = await decider(
    request(
      tableOf(
        [row(1, 'Accept cookies'), row(2, 'Size guide'), row(3, 'Add to bag')],
        'https://shop.example/product/456',
      ),
    ),
  );
  assert.equal(counts.calls, 1, 'no model call on a remembered page');
  assert.equal(replay.index, 3);
  assert.equal(replay.source, 'memory');
  const [entry] = await store.listTargetMemory('graph_1|buy_node');
  assert.equal(entry?.hits, 1);
  assert.equal(entry?.label, 'Add to bag');
  assert.doesNotMatch(
    JSON.stringify(entry),
    /q=x|#top|123/,
    'no query, fragment or id segment stored',
  );
});

await check('another graph node never reuses this node’s memory', async () => {
  const store = createMemoryStore();
  const memory = createTargetMemory(store);
  const { decide, counts } = countingDecider(() => 1);
  const decider = memory.decider(decide);
  const table = tableOf([row(1, 'Add to bag')]);
  await decider(request(table));
  await decider(request(table, { memoryScope: 'graph_2|other' }));
  assert.equal(counts.calls, 2);
});

await check('private pages are never stored or served', async () => {
  const store = createMemoryStore();
  const memory = createTargetMemory(store);
  const { decide, counts } = countingDecider(() => 1);
  const decider = memory.decider(decide);
  const table = tableOf([row(1, 'Message Jane Doe')]);
  await decider(request(table, { localOnly: true, goal: 'message Jane' }));
  await decider(request(table, { localOnly: true, goal: 'message Jane' }));
  assert.equal(counts.calls, 2);
  assert.equal((await store.listTargetMemory()).length, 0);
});

await check('three misses in a row evict an entry; a stale entry is ignored', async () => {
  const store = createMemoryStore();
  let clock = Date.parse('2026-10-17T00:00:00Z');
  const memory = createTargetMemory(store, {
    now: () => new Date(clock).toISOString(),
    ttlMs: 1000,
  });
  const { decide } = countingDecider(() => 1);
  const decider = memory.decider(async (r) =>
    r.table.rows.length
      ? decide(r)
      : { operation: 'BLOCKED', confidence: 0, source: 'jev', rationale: 'none' },
  );
  await decider(request(tableOf([row(1, 'Add to bag')])));
  const empty = tableOf([]);
  for (let i = 0; i < 3; i += 1) await decider(request(empty));
  assert.equal((await store.listTargetMemory()).length, 0, 'evicted after three misses');

  await decider(request(tableOf([row(1, 'Add to bag')])));
  clock += 5000;
  const { decide: second, counts } = countingDecider(() => 1);
  await createTargetMemory(store, {
    now: () => new Date(clock).toISOString(),
    ttlMs: 1000,
  }).decider(second)(request(tableOf([row(1, 'Add to bag')])));
  assert.equal(counts.calls, 1, 'an entry past its TTL is not served');
});

console.log('Correction through the broker');
await check('a person’s correction is re-reviewed, then remembered for later runs', async () => {
  const store = createMemoryStore();
  const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
  const sessions = new SessionStateService(store, bus);
  const memory = createTargetMemory(store);
  const rows = [row(1, 'Place order'), row(2, 'Place order with gift wrap')];
  const performed: number[] = [];
  const adapter = {
    id: 'localbrowser',
    mode: 'live',
    capabilities: ['browser.local'],
    async snapshot(input: { sessionId: string }) {
      return {
        ok: true,
        data: { ...tableOf(rows, 'https://shop.example/checkout'), sessionId: input.sessionId },
        meta: {},
      };
    },
    async perform(input: { index: number; operation: string }) {
      performed.push(input.index);
      return {
        ok: true,
        data: {
          operation: input.operation,
          index: input.index,
          url: 'https://shop.example/done',
          navigated: true,
        },
        meta: {},
      };
    },
  } as unknown as BrowserAdapter;
  const { decide, counts } = countingDecider(() => 1);
  const executor = createBrowserExecutor({
    provider: () => adapter,
    decide: memory.decider(decide),
    targetMemory: memory,
    memoryScope: async () => 'graph_1|checkout',
  });
  const registry = new InMemoryToolRegistry();
  registry.registerMany(
    browserToolRegistrations({ localAvailable: true, browserbaseAvailable: false }),
  );
  const executors = new InMemoryToolExecutorRegistry();
  executors.register(executor);
  const auto: ActionPolicyRecommendation = {
    policy: 'auto',
    confidence: 0.99,
    probabilities: { auto: 0.99 },
    reasonCodes: ['check'],
  };
  const decisions = new DecisionService({
    id: 'jev',
    mode: 'mock',
    capabilities: ['decision'],
    async recommendActionPolicy() {
      return {
        ok: true,
        data: auto,
        meta: { provider: 'jev', op: 'policy', mode: 'mock', latencyMs: 0, destination: null },
      };
    },
  } as unknown as DecisionAdapter);
  const requested: Json[] = [];
  const broker = new ToolBroker(registry, executors, decisions, sessions, bus, {
    approvalGate: {
      async request({ action }) {
        requested.push(action.review ?? null);
        if (requested.length === 1) {
          // The person picks the gift-wrap button on the card.
          assert.equal(await executor.correctTarget(action.id, 2), true);
          return { approvalId: 'apr_1', revisedArguments: action.arguments };
        }
        return { approvalId: 'apr_2' };
      },
    },
  });
  const session = await sessions.create({
    runId: 'run_checkout',
    stepId: 'step_checkout',
    harness: 'hermes',
    objective: 'Check out.',
    sanitizedObjective: 'Check out.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
  });
  await sessions.beginTurn(session.id);
  const click = (await registry.get('localbrowser.click'))!.descriptor;
  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_checkout',
    selectedToolVersions: { [click.id]: click.version },
  });
  await broker.execute({
    sessionStateId: session.id,
    toolId: click.id,
    arguments: { sessionId: 'session_1', goal: 'Place the order' },
  });
  assert.equal(requested.length, 2, 'the corrected element is approved separately');
  const second = requested[1] as Record<string, Json>;
  assert.equal(second.index, 2);
  assert.equal(second.remembered, 'human');
  assert.deepEqual(performed, [2], 'only the corrected element is clicked, once');
  const callsBefore = counts.calls;
  const next = await executor.prepareReview!(
    {
      id: 'act_later',
      runId: 'run_later',
      stepId: 'step_later',
      toolId: click.id,
      descriptorVersion: click.version,
      operation: click.id,
      arguments: { sessionId: 'session_later', goal: 'place order' },
      dataLabels: ['public'],
      createdAt: new Date().toISOString(),
    },
    { runId: 'run_later', stepId: 'step_later', policyRule: 'check' },
  );
  assert.equal(counts.calls, callsBefore, 'a later run uses the remembered correction');
  assert.equal((next.review as Record<string, Json>).index, 2);
  assert.equal(next.requiresApproval, true, 'remembering an element never grants permission');
});

console.log('\n' + checks + ' target memory checks passed.');
