/**
 * The graph compile step: Jev decisions a saved graph can make once are frozen
 * on the graph and reused by runs while they still describe the node.
 *
 * No network: deterministic doubles and mock providers only.
 *
 *   pnpm --filter @htn/api check:graph-compile
 */

import assert from 'node:assert/strict';
import {
  agentGraphSchema,
  type AgentGraph,
  type AgentRuntimeAdapter,
  type CompiledNodeDecision,
  type DecisionAdapter,
  type GraphNode,
  type Json,
  type Run,
  type Step,
  type ToolDescriptor,
} from '@htn/shared';
import {
  compileGraph,
  nodeHash,
  prunedCompiled,
  usableAgentRoute,
  usableDispatch,
} from '../src/core/graph/compile.js';
import { runGraph } from '../src/core/graph/interpreter.js';
import { Orchestrator, type OrchestratorDeps } from '../src/core/orchestrator.js';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import type { PlaybookContext } from '../src/core/playbooks/types.js';
import { createMemoryStore } from '../src/store/memory.js';
import { create as createJev } from '../src/providers/jev/index.js';
import {
  configureGraphCompile,
  recordCompiledDecision,
  saveGraphOwned,
  settleGraphCompiles,
} from '../src/services/graphCompile.service.js';
import { mutateGraph } from '../src/services/graphs.service.js';
import { store as appStore } from '../src/store/index.js';

const at = '2026-10-17T00:00:00.000Z';
const position = { x: 0, y: 0 };
let checks = 0;
async function check(label: string, work: () => void | Promise<void>): Promise<void> {
  await work();
  checks += 1;
  console.log('  [PASS] ' + label);
}

function descriptor(id: string, version = '1'): ToolDescriptor {
  return {
    id,
    version,
    providerId: 'check',
    family: 'research',
    description: 'Read public pages: ' + id,
    inputSchemaRef: 'check://' + id + '/' + version,
    transport: 'local',
    baselineEffect: 'read',
    reversibility: 'reversible',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: 'available',
    executorRef: 'check://' + id,
    executionMode: 'live',
  };
}

const agentNode = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  id,
  type: 'agent_task',
  label: id,
  position,
  config: {
    goal: 'Summarize public notes about ' + id + '.',
    availableTools: ['notes.read', 'notes.search'],
    pollIntervalMs: 100,
    contextInputs: {},
    ...extra,
  },
});
const dispatchNode = (id: string, goal = 'Choose the next read'): unknown => ({
  id,
  type: 'dispatch',
  label: id,
  position,
  config: { goal, candidateTools: ['notes.read', 'notes.search'], args: {} },
});
const graphOf = (nodes: unknown[], id = 'graph_compile_check'): AgentGraph =>
  agentGraphSchema.parse({
    id,
    name: 'Compile check',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes,
    edges: [],
  });

function countingDecider() {
  const mock = createJev({ mode: 'mock', keyVar: 'UNUSED' }) as DecisionAdapter;
  const counts = { route: 0, decide: 0 };
  const decider: DecisionAdapter = {
    ...mock,
    async route(input, ctx) {
      counts.route += 1;
      return mock.route(input, ctx);
    },
    async decide(input, ctx) {
      counts.decide += 1;
      return {
        ok: true,
        data: { choice: input.options.at(-1)!, confidence: 0.9 },
        meta: { provider: 'jev', mode: 'mock', op: 'decide', latencyMs: 0, destination: null },
      };
    },
  };
  return { decider, counts };
}

const tools = [descriptor('notes.read'), descriptor('notes.search')];
const resolveTools = async (ids: string[]) => tools.filter((tool) => ids.includes(tool.id));

console.log('Compile');
await check('compiles public agent routes and static dispatches only', async () => {
  const { decider, counts } = countingDecider();
  const graph = graphOf([
    agentNode('research'),
    agentNode('secret_notes', { dataLabels: ['private'] }),
    dispatchNode('fixed'),
    dispatchNode('dynamic', 'Choose a read for {{input.topic}}'),
  ]);
  const compiled = await compileGraph(graph, { decider, resolveTools, now: () => at });
  assert.deepEqual(Object.keys(compiled?.nodes ?? {}).sort(), ['fixed', 'research']);
  assert.deepEqual(counts, { route: 1, decide: 1 }, 'one Jev call per compilable node');
  const route = compiled!.nodes.research!;
  assert.equal(route.kind, 'agent_route');
  assert.deepEqual(route.kind === 'agent_route' && route.tools, {
    'notes.read': '1',
    'notes.search': '1',
  });

  const again = await compileGraph(
    { ...graph, compiled },
    { decider, resolveTools, now: () => at },
  );
  assert.deepEqual(counts, { route: 1, decide: 1 }, 'a still-valid entry is not recompiled');
  assert.deepEqual(again, compiled);
});

await check('a frozen entry is unusable when anything it was decided over changed', () => {
  const node = agentGraphSchema.parse(graphOf([agentNode('research')])).nodes[0]!;
  const entry: CompiledNodeDecision = {
    kind: 'agent_route',
    nodeHash: nodeHash(node),
    decisionMode: 'mock',
    tools: { 'notes.read': '1', 'notes.search': '1' },
    privacy: 'cloud',
    intelligence: 'low',
    privacyConfidence: 1,
    intelligenceConfidence: 1,
    modelTier: 'cheap',
    exposedTools: ['notes.read'],
    confidence: 1,
    source: 'compile',
    at,
  };
  const expected = { nodeHash: nodeHash(node), decisionMode: 'mock', tools: entry.tools };
  assert.ok(usableAgentRoute(entry, expected));
  assert.equal(usableAgentRoute(entry, { ...expected, decisionMode: 'live' }), undefined);
  assert.equal(usableAgentRoute(entry, { ...expected, nodeHash: 'other' }), undefined);
  assert.equal(
    usableAgentRoute(entry, { ...expected, tools: { 'notes.read': '2', 'notes.search': '1' } }),
    undefined,
    'a tool version bump invalidates the grant',
  );
  assert.equal(
    usableAgentRoute(entry, { ...expected, tools: { 'notes.read': '1' } }),
    undefined,
    'a different candidate set invalidates the grant',
  );
  assert.equal(
    usableAgentRoute({ ...entry, exposedTools: ['mail.send'] }, expected),
    undefined,
    'a frozen grant can never widen beyond its candidate set',
  );
  const dispatch: CompiledNodeDecision = {
    kind: 'dispatch',
    nodeHash: 'h',
    decisionMode: 'mock',
    options: ['a', 'b'],
    choice: 'b',
    confidence: 1,
    source: 'compile',
    at,
  };
  assert.ok(usableDispatch(dispatch, { nodeHash: 'h', decisionMode: 'mock', options: ['a', 'b'] }));
  assert.equal(
    usableDispatch(dispatch, { nodeHash: 'h', decisionMode: 'mock', options: ['a'] }),
    undefined,
  );
});

await check('editing a node drops only that node’s entry', async () => {
  const { decider } = countingDecider();
  const graph = graphOf([agentNode('research'), dispatchNode('fixed')]);
  const compiled = await compileGraph(graph, { decider, resolveTools, now: () => at });
  const edited = graphOf([
    agentNode('research', { goal: 'Summarize something else entirely.' }),
    dispatchNode('fixed'),
  ]);
  assert.deepEqual(Object.keys(prunedCompiled(compiled, edited)?.nodes ?? {}), ['fixed']);
});

console.log('Server-owned saves');
await check(
  'a client cannot supply compiled decisions; the server compiles after save',
  async () => {
    const { decider, counts } = countingDecider();
    configureGraphCompile({ decider: () => decider, resolveTools }, { enabled: true });
    const forged = {
      ...graphOf([agentNode('research'), dispatchNode('fixed')], 'graph_owned_check'),
      compiled: {
        protocol: 'agentos-graph-compile-v1' as const,
        nodes: {
          research: {
            kind: 'agent_route' as const,
            nodeHash: 'forged',
            decisionMode: 'mock',
            tools: {},
            privacy: 'cloud' as const,
            intelligence: 'low' as const,
            privacyConfidence: 1,
            intelligenceConfidence: 1,
            modelTier: 'frontier' as const,
            exposedTools: ['mail.send'],
            confidence: 1,
            source: 'compile' as const,
            at,
          },
        },
      },
    };
    const saved = await saveGraphOwned(forged);
    assert.equal(saved.compiled, undefined, 'the forged entry is not stored');
    await settleGraphCompiles();
    const stored = await appStore.getGraph('graph_owned_check');
    assert.deepEqual(Object.keys(stored?.compiled?.nodes ?? {}).sort(), ['fixed', 'research']);
    assert.equal(stored?.version, 1, 'compiling does not bump the graph version');
    assert.ok(counts.route === 1 && counts.decide === 1);

    await mutateGraph('graph_owned_check', 1, (graph) => ({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'fixed'
          ? ({ ...node, config: { ...node.config, goal: 'Pick another read' } } as GraphNode)
          : node,
      ),
    }));
    const kept = await appStore.getGraph('graph_owned_check');
    assert.deepEqual(
      Object.keys(kept?.compiled?.nodes ?? {}),
      ['research'],
      'only the edited node is dropped',
    );
    await settleGraphCompiles();
    const recompiled = await appStore.getGraph('graph_owned_check');
    assert.deepEqual(Object.keys(recompiled?.compiled?.nodes ?? {}).sort(), ['fixed', 'research']);
    assert.equal(counts.route, 1, 'the unchanged agent node is not recompiled');
    assert.equal(counts.decide, 2, 'the edited dispatch is recompiled');

    const stale = recompiled!.compiled!.nodes.fixed!;
    await recordCompiledDecision('graph_owned_check', 'fixed', { ...stale, nodeHash: 'old-node' });
    assert.deepEqual(
      (await appStore.getGraph('graph_owned_check'))?.compiled?.nodes.fixed,
      stale,
      'a decision learned for an older node version is ignored',
    );
  },
);

console.log('Dispatch at run time');
function dispatchContext(decider: DecisionAdapter) {
  const recorded: CompiledNodeDecision[] = [];
  const rules: string[] = [];
  let seq = 0;
  const context = {
    runId: 'run_dispatch',
    signal: new AbortController().signal,
    async log() {},
    async step(
      spec: { label: string; nodeId?: string; kind?: string },
      work: (step: Step) => unknown,
    ) {
      return work({
        ...spec,
        id: 'step_' + ++seq,
        runId: 'run_dispatch',
        parentStepId: null,
        seq,
        kind: spec.kind ?? 'task',
        status: 'running',
        startedAt: at,
      } as Step);
    },
    async recordSchedule(input: { rule: string }) {
      rules.push(input.rule);
      return input;
    },
    async callBrokeredTool() {
      return { output: { text: 'ok' }, summary: 'ok' };
    },
    async requireApproval(_stepId: string, action: unknown) {
      return action;
    },
    async recordCompiledDecision(_graphId: string, _nodeId: string, entry: CompiledNodeDecision) {
      recorded.push(entry);
    },
    providerFor: () => 'jev',
    provider: () => decider,
    callContext: (args: Record<string, unknown>) => ({ ...args, runId: 'run_dispatch' }),
  } as unknown as PlaybookContext;
  return { context, recorded, rules };
}

await check(
  'a static dispatch asks Jev once, records it, then reuses the frozen choice',
  async () => {
    const { decider, counts } = countingDecider();
    const graph = graphOf([dispatchNode('fixed')]);
    const first = dispatchContext(decider);
    await runGraph(first.context, graph);
    assert.equal(counts.decide, 1);
    assert.equal(first.recorded.length, 1, 'the run keeps the answer for the next run');
    assert.deepEqual(first.rules, ['dispatch-selected-single-tool']);

    const frozen = {
      ...graph,
      compiled: {
        protocol: 'agentos-graph-compile-v1' as const,
        nodes: { fixed: first.recorded[0]! },
      },
    };
    const second = dispatchContext(decider);
    await runGraph(second.context, frozen);
    assert.equal(counts.decide, 1, 'the second run makes no Jev call');
    assert.deepEqual(second.rules, ['dispatch-compiled-single-tool']);
    assert.equal(second.recorded.length, 0);

    const dynamic = dispatchContext(decider);
    await runGraph(
      dynamic.context,
      graphOf([dispatchNode('dynamic', 'Read about {{input.topic}}')]),
    );
    assert.equal(counts.decide, 2, 'a goal with {{refs}} is always asked');
    assert.equal(dynamic.recorded.length, 0, 'and never frozen');
  },
);

console.log('Agent route at run time');
async function runAgentGraph(graph: AgentGraph, registry: InMemoryToolRegistry) {
  const store = createMemoryStore();
  const bus = new RunBus((id, event) => store.appendEvent(id, event));
  const sessions = new SessionStateService(store, bus);
  const { decider, counts } = countingDecider();
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
    async startTask() {
      return { ok: true, data: { taskId: 'task' }, meta };
    },
    async pollTask() {
      return { ok: true, data: { status: 'done', result: { text: 'Notes summarised.' } }, meta };
    },
    async continueTask() {
      return { ok: true, data: null, meta };
    },
    async cancelTask() {
      return { ok: true, data: null, meta };
    },
  };
  const recorded: CompiledNodeDecision[] = [];
  const orchestrator = new Orchestrator({
    store,
    bus,
    sessionStateService: sessions,
    decisionService: new DecisionService(decider),
    toolRegistry: registry,
    provider: ((capability: string) =>
      capability === 'agent.runtime' ? runtime : decider) as OrchestratorDeps['provider'],
    providerFor: (capability) => (capability === 'agent.runtime' ? 'hermes' : 'jev'),
    agentCeilings: { maxDurationMs: 60_000, networkRetries: 0 },
    recordCompiledDecision: async (_graphId, _nodeId, entry) => {
      recorded.push(entry);
    },
  });
  const run: Run = {
    id: 'run_agent_compile',
    kind: 'graph',
    title: 'Compile',
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    input: { graphId: graph.id, graphSnapshot: graph as unknown as Json },
  };
  await store.createRun(run);
  await (orchestrator as unknown as { execute(run: Run): Promise<void> }).execute(run);
  const decisions = await store.listScheduleDecisions(run.id);
  const states = await store.listSessionStates(run.id);
  return { run: await store.getRun(run.id), counts, recorded, decisions, states };
}

function registryWith(readVersion: string): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  const schema: Json = { type: 'object', properties: {}, additionalProperties: false };
  registry.register({ descriptor: descriptor('notes.read', readVersion), inputSchema: schema });
  registry.register({ descriptor: descriptor('notes.search'), inputSchema: schema });
  return registry;
}

await check(
  'an agent node routes with Jev once, then reuses the frozen grant and tier',
  async () => {
    const graph = graphOf([agentNode('research')]);
    const first = await runAgentGraph(graph, registryWith('1'));
    assert.equal(first.run?.status, 'succeeded', first.run?.summary);
    assert.equal(first.counts.route, 1);
    assert.equal(first.recorded.length, 1, 'the route is kept for the next run');
    assert.equal(first.decisions[0]?.rule, 'jev-routed');

    const frozen = {
      ...graph,
      compiled: {
        protocol: 'agentos-graph-compile-v1' as const,
        nodes: { research: first.recorded[0]! },
      },
    };
    const second = await runAgentGraph(frozen, registryWith('1'));
    assert.equal(second.run?.status, 'succeeded', second.run?.summary);
    assert.equal(second.counts.route, 0, 'no Jev routing call on a compiled node');
    assert.equal(second.decisions[0]?.rule, 'compiled-graph-route');
    assert.deepEqual(second.decisions[0]?.exposedTools, first.decisions[0]?.exposedTools);
    assert.equal(
      second.states[0]?.preferredModelTier,
      first.recorded[0]!.kind === 'agent_route' ? first.recorded[0]!.modelTier : undefined,
    );
    assert.equal(second.recorded.length, 0);

    const bumped = await runAgentGraph(frozen, registryWith('2'));
    assert.equal(bumped.counts.route, 1, 'a changed tool version asks Jev again');
    assert.equal(bumped.decisions[0]?.rule, 'jev-routed');
  },
);

console.log('\n' + checks + ' graph compile checks passed.');
