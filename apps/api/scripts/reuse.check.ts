/**
 * Reuse accounting: frozen decisions and remembered targets per run and per
 * node, warm/cold benchmark separation, and the editor's site alerts.
 *
 * Synthetic records only; no store, network or browser.
 *
 *   pnpm --filter @htn/api check:reuse
 */

import assert from 'node:assert/strict';
import {
  agentGraphSchema,
  buildBenchmarkReport,
  promotionCandidates,
  runReuse,
  type BenchmarkSample,
  type BrowserTargetMemory,
  type EgressEvent,
  type Run,
  type ScheduleDecision,
  type Step,
  type ToolLifecycleEvent,
} from '@htn/shared';
import { buildGraphReuseReport } from '../src/core/graph/reuseReport.js';
import { renderOptimizeRequest } from '../src/services/optimization.service.js';

const at = '2026-10-17T12:00:00.000Z';
let checks = 0;
function check(label: string, work: () => void): void {
  work();
  checks += 1;
  console.log('  [PASS] ' + label);
}

const run: Run = {
  id: 'run_1',
  kind: 'graph',
  title: 't',
  status: 'succeeded',
  input: {},
  graphId: 'g1',
  createdAt: at,
  updatedAt: at,
};
const step = (id: string, nodeId: string): Step =>
  ({
    id,
    runId: 'run_1',
    parentStepId: null,
    kind: 'task',
    label: id,
    status: 'succeeded',
    nodeId,
    startedAt: at,
    endedAt: at,
  }) as Step;
const schedule = (stepId: string, rule: string): ScheduleDecision =>
  ({ id: 'sch_' + stepId + rule, runId: 'run_1', stepId, rule, at }) as unknown as ScheduleDecision;
const proposed = (stepId: string, decisionSource: string): ToolLifecycleEvent => ({
  id: 'tl_' + stepId + decisionSource + Math.random(),
  runId: 'run_1',
  stepId,
  sessionStateId: 'ss',
  phase: 'proposed',
  action: {
    id: 'act',
    review: { kind: 'browser_target', decisionSource },
  } as unknown as ToolLifecycleEvent['action'],
  at,
});
const jevRow: EgressEvent = {
  id: 'e',
  runId: 'run_1',
  stepId: 's_judge',
  at,
  providerId: 'jev',
  op: 'decide',
  destination: 'https://ai-gateway.vercel.sh',
  dataSpans: [],
  policyRule: 'test',
  decision: 'allowed',
};

const input = {
  run,
  steps: [step('s_agent', 'research'), step('s_pick', 'pick'), step('s_judge', 'verdict')],
  egress: [jevRow],
  scheduleDecisions: [
    schedule('s_agent', 'compiled-graph-route'),
    schedule('s_pick', 'dispatch-selected-single-tool'),
  ],
  toolLifecycle: [
    proposed('s_agent', 'memory'),
    proposed('s_agent', 'jev'),
    proposed('s_agent', 'cache'),
  ],
};

check('a run counts frozen vs live decisions and remembered vs decided targets per node', () => {
  const reuse = runReuse(input);
  assert.deepEqual(
    {
      frozen: reuse.frozenDecisions,
      live: reuse.liveDecisions,
      remembered: reuse.rememberedTargets,
      decided: reuse.decidedTargets,
    },
    { frozen: 1, live: 1, remembered: 2, decided: 1 },
  );
  assert.equal(reuse.jevCalls, 2, 'one ledger Jev call plus one Jev target pick');
  assert.equal(reuse.warm, true);
  assert.equal(reuse.byNode.research?.rememberedTargets, 2);
  assert.equal(reuse.byNode.pick?.liveDecisions, 1);
});

check('a run that reused nothing is cold', () => {
  assert.equal(runReuse({ run, steps: [], egress: [] }).warm, false);
});

check('reports can keep warm and cold graph runs apart; baselines are always kept', () => {
  const sample = (overrides: Partial<BenchmarkSample>): BenchmarkSample => ({
    runId: 'x',
    arm: 'graph',
    graphId: 'g1',
    pairId: 'p',
    createdAt: at,
    status: 'succeeded',
    hasAssertions: true,
    assertionsPassed: 1,
    assertionsTotal: 1,
    success: true,
    costCents: 1,
    unpricedCalls: 0,
    tokens: 1,
    llmCalls: 1,
    wallMs: 1,
    humanWaitMs: 0,
    mocked: false,
    experimentFingerprint: 'f'.repeat(64),
    qualityEligible: true,
    provenanceKnown: true,
    completionVerified: true,
    jevCalls: 3,
    warm: false,
    ...overrides,
  });
  const samples = [
    sample({ runId: 'cold', pairId: 'p1' }),
    sample({ runId: 'warm', pairId: 'p2', warm: true, jevCalls: 1 }),
    sample({ runId: 'b1', arm: 'baseline', pairId: 'p1' }),
    sample({ runId: 'b2', arm: 'baseline', pairId: 'p2' }),
  ];
  const all = buildBenchmarkReport(samples, { g1: 'G' });
  assert.equal(all.overall.graph?.runs, 2);
  assert.equal(all.overall.graph?.warmRuns, 1);
  assert.equal(all.overall.graph?.medianJevCalls, 2);
  const cold = buildBenchmarkReport(samples, { g1: 'G' }, { warmth: 'cold' });
  assert.equal(cold.overall.graph?.runs, 1);
  assert.equal(cold.overall.baseline?.runs, 2, 'baselines are never filtered by warmth');
  assert.equal(cold.warmth, 'cold');
});

check('the editor report lists frozen nodes, remembered targets and site alerts', () => {
  const graph = agentGraphSchema.parse({
    id: 'g1',
    name: 'G',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes: [
      { id: 'research', type: 'agent_task', label: 'Research', config: { goal: 'Read notes.' } },
      {
        id: 'pick',
        type: 'dispatch',
        label: 'Pick',
        config: { goal: 'Pick', candidateTools: ['a', 'b'] },
      },
    ],
    edges: [],
    compiled: {
      protocol: 'agentos-graph-compile-v1',
      nodes: {
        research: {
          kind: 'agent_route',
          nodeHash: 'h',
          decisionMode: 'mock',
          tools: {},
          privacy: 'cloud',
          intelligence: 'low',
          privacyConfidence: 1,
          intelligenceConfidence: 1,
          modelTier: 'cheap',
          exposedTools: [],
          confidence: 1,
          source: 'compile',
          at,
        },
      },
    },
  });
  const memory = (overrides: Partial<BrowserTargetMemory>): BrowserTargetMemory => ({
    key: 'k' + Math.random(),
    scope: 'g1|research',
    origin: 'https://shop.example',
    pathTemplate: '/p/*',
    operation: 'CLICK',
    role: 'button',
    label: 'Add',
    ordinal: 0,
    source: 'jev',
    hits: 4,
    misses: 0,
    consecutiveMisses: 0,
    createdAt: at,
    lastSeen: at,
    ...overrides,
  });
  const report = buildGraphReuseReport({
    graph,
    runs: [input as never],
    memory: [
      memory({}),
      memory({ source: 'human', consecutiveMisses: 2, misses: 2 }),
      memory({ scope: 'other_graph|x' }),
    ],
    siteBlocks: [
      {
        origin: 'https://www.google.com',
        reason: 'browser_challenge',
        count: 3,
        firstAt: at,
        lastAt: at,
      },
      {
        origin: 'https://old.example',
        reason: 'empty_page',
        count: 1,
        firstAt: '2026-01-01T00:00:00Z',
        lastAt: '2026-01-01T00:00:00Z',
      },
    ],
    now: at,
  });
  assert.deepEqual(report.nodes.research?.compiled, { kind: 'agent_route', source: 'compile' });
  assert.deepEqual(report.nodes.research?.remembered, {
    entries: 2,
    hits: 8,
    misses: 2,
    corrected: 1,
  });
  assert.equal(report.runs, 1);
  assert.equal(report.warmRuns, 1);
  assert.deepEqual(
    report.alerts.map((alert) => alert.kind + ':' + alert.origin),
    ['site_changed:https://shop.example', 'site_blocked:https://www.google.com'],
    'another graph’s memory and old blocks are left out',
  );
});

check('an agent node that keeps doing the same verified thing is a promotion candidate', () => {
  const graph = agentGraphSchema.parse({
    id: 'g1',
    name: 'G',
    version: 1,
    createdAt: at,
    updatedAt: at,
    edges: [],
    nodes: [
      { id: 'research', type: 'agent_task', label: 'Research', config: { goal: 'Read notes.' } },
    ],
  });
  const runOf = (
    id: string,
    tools: string[],
    options: { verified?: boolean; query?: string; labels?: ('public' | 'private')[] } = {},
  ) => {
    const stepId = 's_' + id;
    return {
      run: { ...run, id },
      steps: [
        {
          ...step(stepId, 'research'),
          output: { completionDecision: { status: 'done', verified: options.verified ?? true } },
        } as Step,
      ],
      egress: [],
      scheduleDecisions: [
        {
          ...schedule(stepId, 'jev-routed'),
          requestedCapability: 'agent.runtime' as const,
          exposedTools: ['web.search', 'docs.read'],
        },
      ],
      toolLifecycle: tools.map((toolId, index): ToolLifecycleEvent => ({
        id: id + index,
        runId: id,
        stepId,
        sessionStateId: 'ss',
        phase: 'succeeded',
        action: {
          toolId,
          arguments: { query: options.query ?? 'agentos' },
          dataLabels: options.labels ?? ['public'],
        } as unknown as ToolLifecycleEvent['action'],
        at: '2026-10-17T12:00:0' + index + '.000Z',
      })),
    };
  };
  const same = ['web.search', 'docs.read'];
  const [candidate] = promotionCandidates({
    graph,
    runs: [runOf('r3', same), runOf('r2', same), runOf('r1', same)],
  });
  assert.equal(candidate?.suggestion, 'tool_nodes');
  assert.deepEqual(candidate?.tools, same);
  assert.equal(candidate?.stableArguments, true);
  assert.equal(candidate?.arguments?.length, 2, 'public stable arguments are offered');
  assert.equal(
    promotionCandidates({
      graph,
      runs: [
        runOf('r3', same, { verified: false }),
        runOf('r2', same),
        runOf('r1', same),
        runOf('r0', same),
      ],
    }).length,
    0,
    'the newest run must be verified: only an unbroken recent streak counts',
  );
  assert.equal(
    promotionCandidates({
      graph,
      runs: [runOf('r3', same), runOf('r2', ['web.search']), runOf('r1', same)],
    }).length,
    0,
    'a different tool sequence is not the same work',
  );
  const varied = promotionCandidates({
    graph,
    runs: [runOf('r3', same, { query: 'a' }), runOf('r2', same, { query: 'b' }), runOf('r1', same)],
  })[0];
  assert.equal(varied?.stableArguments, false);
  assert.equal(varied?.arguments, undefined);
  const privateCandidate = promotionCandidates({
    graph,
    runs: ['r3', 'r2', 'r1'].map((id) => runOf(id, same, { labels: ['private'] })),
  })[0];
  assert.equal(
    privateCandidate?.arguments,
    undefined,
    'private arguments never leave in a suggestion',
  );
  const request = renderOptimizeRequest(
    {
      graphId: 'g1',
      runsAnalyzed: 3,
      lowConfidence: false,
      assertionFailures: [],
      costOutliers: [],
      latencyOutliers: [],
      toolDivergenceOutliers: [],
      failureEvidence: [],
    },
    [candidate!],
  );
  assert.match(request, /web\.search -> docs\.read/);
  assert.match(request, /Keep every approval, submit and handoff gate/);
  assert.doesNotMatch(request, /Nothing obviously wrong/);
});

console.log('\n' + checks + ' reuse checks passed.');
