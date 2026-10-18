import assert from 'node:assert/strict';
import {
  agentGraphSchema,
  type AgentRuntimeAdapter,
  type AgentGraph,
  type Run,
  type Json,
} from '@htn/shared';
import { Orchestrator, type OrchestratorDeps } from '../src/core/orchestrator.js';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { createMemoryStore } from '../src/store/memory.js';
import { create as createJev } from '../src/providers/jev/index.js';
import { KeyedLock } from '../src/core/locks.js';

const at = new Date().toISOString();
const edge = (source: string, target: string) => ({ id: source + '-' + target, source, target });
const node = (id: string, scope?: { id: string; mode: 'fresh' | 'continue' }, extra = {}) => ({
  id,
  type: 'agent_task',
  label: id,
  position: { x: 0, y: 0 },
  config: {
    goal: 'Summarize the supplied synthetic notes.',
    pollIntervalMs: 100,
    contextInputs: {},
    availableTools: ['known.read'],
    ...(scope ? { contextScope: scope } : {}),
    ...extra,
  },
});
const parse = (nodes: unknown[], edges: unknown[] = []) =>
  agentGraphSchema.parse({
    id: 'scope-graph',
    name: 'Scope checks',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes,
    edges,
  });

async function execute(graph: AgentGraph, cancel = false) {
  const store = createMemoryStore();
  const bus = new RunBus((id, event) => store.appendEvent(id, event));
  const sessions = new SessionStateService(store, bus);
  const jev = createJev({ mode: 'mock', keyVar: 'UNUSED' });
  const started: Parameters<AgentRuntimeAdapter['startTask']>[0][] = [];
  const continued: string[] = [];
  let cancelRun: (() => void) | undefined;
  const closed: string[] = [];
  const cleanup: string[] = [];
  const meta = {
    provider: 'hermes' as const,
    mode: 'mock' as const,
    op: 'test',
    latencyMs: 0,
    destination: null,
  };
  const runtime: AgentRuntimeAdapter = {
    id: 'hermes',
    mode: 'mock',
    capabilities: ['agent.runtime'],
    async health() {
      return { ok: true, data: {}, meta };
    },
    async invoke() {
      throw new Error('Unexpected invoke');
    },
    async startTask(input, ctx) {
      assert.ok(ctx.gatewayCredentials);
      started.push(input);
      return { ok: true, data: { taskId: 'task-' + started.length }, meta };
    },
    async pollTask() {
      // Cancel once the agent is actually running. A fixed timer raced the
      // mock Jev's latency, and a run cancelled before launch starts no agent.
      if (cancel) setTimeout(() => cancelRun?.(), 0);
      return {
        ok: true,
        data: { status: cancel ? 'running' : 'done', result: { text: 'SYNTHETIC_RESULT' } },
        meta,
      };
    },
    async continueTask(id) {
      assert.ok(!closed.includes(id), 'retained transcript must not have been closed');
      assert.equal(cleanup.length, 0, 'resources must survive earlier agent nodes');
      continued.push(id);
      return { ok: true, data: null, meta };
    },
    async cancelTask(id) {
      closed.push(id);
      return { ok: true, data: null, meta };
    },
  };
  const orchestrator = new Orchestrator({
    store,
    bus,
    sessionStateService: sessions,
    decisionService: new DecisionService(jev),
    provider: ((capability: string) =>
      capability === 'agent.runtime' ? runtime : jev) as OrchestratorDeps['provider'],
    providerFor: (capability) => (capability === 'agent.runtime' ? 'hermes' : 'jev'),
    localToolCandidates: async () => ['discovered.extra'],
    releaseRunResources: async ({ runId }) => {
      cleanup.push(runId);
    },
  });
  const run: Run = {
    id: 'run-test',
    kind: 'graph',
    title: 'Scope test',
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    input: { graphId: graph.id, graphSnapshot: graph as unknown as Json },
  };
  await store.createRun(run);
  cancelRun = () => orchestrator.cancel(run.id);
  await (orchestrator as unknown as { execute(run: Run): Promise<void> }).execute(run);
  return {
    store,
    started,
    continued,
    closed,
    cleanup,
    run: await store.getRun(run.id),
    states: await store.listSessionStates(run.id),
  };
}

const first = node(
  'first',
  { id: 'investigation', mode: 'fresh' },
  { toolCeiling: [], dataLabels: ['local_only'] },
);
const second = node(
  'second',
  { id: 'investigation', mode: 'continue' },
  { toolCeiling: ['discovered.extra'], dataLabels: ['public'] },
);
const shared = await execute(parse([first, second], [edge('first', 'second')]));
assert.equal(shared.run?.status, 'succeeded', shared.run?.summary);
assert.equal(shared.started.length, 1);
assert.deepEqual(shared.started[0]?.tools, []);
assert.deepEqual(shared.continued, ['task-1']);
assert.equal(shared.states.length, 1);
assert.equal(shared.states[0]?.turn, 2);
assert.equal(shared.states[0]?.status, 'completed');
assert.deepEqual(shared.states[0]?.toolCeiling, []);
assert.ok(shared.states[0]?.dataLabels.includes('local_only'));
assert.equal(shared.states[0]?.contextVersion, 2);
assert.equal(shared.cleanup.length, 1);
assert.ok(!JSON.stringify(await shared.store.listSteps('run-test')).includes('SYNTHETIC_RESULT'));

const isolated = await execute(parse([node('a'), node('b')]));
assert.equal(isolated.run?.status, 'succeeded', isolated.run?.summary);
assert.equal(isolated.started.length, 2);
assert.equal(isolated.continued.length, 0);
assert.equal(new Set(isolated.states.map((state) => state.harnessSessionId)).size, 2);

for (const [nodes, edges] of [
  [[second], []],
  [[first, second], []],
  [[first, { ...first, id: 'duplicate' }], [edge('first', 'duplicate')]],
  [
    [first, second, node('third', { id: 'investigation', mode: 'continue' })],
    [edge('first', 'second'), edge('first', 'third')],
  ],
] as [unknown[], unknown[]][])
  assert.throws(() => parse(nodes, edges), /ordered chain/);

const stopped = await execute(parse([first]), true);
assert.equal(stopped.run?.status, 'cancelled');
assert.ok(stopped.closed.includes('task-1'));
assert.equal(stopped.cleanup.length, 1);
assert.equal(stopped.states[0]?.status, 'cancelled');

const lock = new KeyedLock();
const unlock = await lock.acquire('shared');
let acquired = false;
const waiting = lock.acquire('shared').then((release) => {
  acquired = true;
  release();
});
await Promise.resolve();
assert.equal(acquired, false);
const independent = await lock.acquire('independent');
independent();
unlock();
await waiting;
assert.equal(acquired, true);
console.log(
  'PASS: shared/fresh scopes, ceilings, labels, cancellation, run cleanup, and writer ordering.',
);
