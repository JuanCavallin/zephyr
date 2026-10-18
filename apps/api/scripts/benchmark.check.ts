/**
 * Unit checks for the measurement path: per-model pricing, the rollup's
 * unpriced-call and human-wait accounting, the baseline task builder, and the
 * benchmark pairing / savings rules.
 *
 * No network, no store, no running API -- synthetic runs only.
 *
 *   pnpm --filter @htn/api check:benchmark
 */

import assert from 'node:assert/strict';
import {
  benchmarkSample,
  buildBenchmarkReport,
  canAutoApproveMockBenchmark,
  modelCostCents,
  outcomeAssertionsForGraph,
  pairedSaving,
  rollup,
  type ActionEvidence,
  type AgentGraph,
  type Approval,
  type BenchmarkSample,
  type EgressEvent,
  type Json,
  type Run,
  type Step,
  type ToolLifecycleEvent,
} from '@htn/shared';
import {
  answerContract,
  buildBaselineTask,
  buildBenchmarkExperiment,
  parseBaselineReply,
} from '../src/core/playbooks/baselineTask.js';
import { buildDemoGraph } from '../src/core/graph/demo.graph.js';

let checks = 0;
function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  assert.ok(condition, label + (detail ? ' -> ' + detail : ''));
  console.log('  [PASS] ' + label);
}
const close = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    kind: 'graph',
    title: 't',
    status: 'succeeded',
    input: {},
    graphId: 'g1',
    createdAt: iso(0),
    updatedAt: iso(60_000),
    ...overrides,
  };
}

function step(id: string, start: number, end: number): Step {
  return {
    id,
    runId: 'run_1',
    parentStepId: null,
    kind: 'task',
    label: id,
    status: 'succeeded',
    startedAt: iso(start),
    endedAt: iso(end),
  } as Step;
}

function egress(overrides: Partial<EgressEvent>): EgressEvent {
  return {
    id: 'e',
    runId: 'run_1',
    stepId: 's1',
    at: iso(0),
    providerId: 'anthropic',
    op: 'complete',
    destination: 'https://api.anthropic.com',
    dataSpans: [],
    policyRule: 'test',
    decision: 'allowed',
    ...overrides,
  };
}

console.log('Pricing');
check(
  'dated model id prices as its family',
  close(modelCostCents('claude-haiku-4-5-20251001', { inputTokens: 1e6, outputTokens: 0 }), 100),
);
check(
  'opus-5-5 is not priced as opus-5',
  close(modelCostCents('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 0 }), 400),
);
check(
  'cache reads bill at 0.1x input, writes at 1.25x',
  close(
    modelCostCents('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1e6,
      cacheWriteTokens: 1e6,
    }),
    50 + 625,
  ),
);
check(
  'unknown model is unpriced, not free',
  modelCostCents('gemini-3.8-flash', { inputTokens: 10, outputTokens: 10 }) === undefined,
);

console.log('Rollup');
const analytics = rollup({
  run: run({ pauses: [{ at: iso(10_000), resumedAt: iso(20_000) }] }),
  steps: [step('s1', 0, 60_000)],
  egress: [
    egress({ tokensIn: 100, tokensOut: 10, estimatedCostCents: 1 }),
    egress({ id: 'e2', tokensIn: 100, tokensOut: 10 }),
    egress({ id: 'e3' }),
  ],
  approvals: [
    // Overlaps the pause by 5s: counted once, not twice.
    {
      id: 'a',
      runId: 'run_1',
      stepId: 's1',
      status: 'approved',
      createdAt: iso(15_000),
      decidedAt: iso(30_000),
    } as Approval,
  ],
});
check('unpriced model calls are counted', analytics.totals.unpricedCalls === 1);
check('a row without tokens is not a model call', analytics.totals.llmCalls === 2);
check('priced cost still sums', analytics.totals.estimatedCostCents === 1);
check(
  'human wait merges pause and approval',
  analytics.totals.humanWaitMs === 20_000,
  String(analytics.totals.humanWaitMs),
);
check(
  'active time excludes human wait',
  analytics.totals.wallMs === 40_000,
  String(analytics.totals.wallMs),
);
check('elapsed keeps the raw span', analytics.totals.elapsedMs === 60_000);

console.log('Baseline task');
const demo = buildDemoGraph(iso(0));
const demoTask = buildBaselineTask({ graph: demo, requests: [], variables: { target: 'ACME-1' } });
check(
  'no chat -> description is the task',
  demoTask.promptSource === 'description' && demoTask.prompt.startsWith('Task: '),
);
check(
  'inline source text is included with inputs substituted',
  demoTask.prompt.includes('Case reference ACME-1.'),
);
check(
  'judge assertion becomes an answer field keyed by its assertion id, with options',
  JSON.stringify(demoTask.answerFields) ===
    JSON.stringify([{ name: 'a_verdict', options: ['file_correction', 'no_action'] }]),
  JSON.stringify(demoTask.answerFields),
);
check(
  'pipeline-property assertions are NOT asked of the baseline',
  !demoTask.answerFields.some((f) => f.name === 'a_pii' || f.name === 'spans'),
);
check(
  'contract asks for outcomes by assertion id, never the expected value',
  answerContract(demoTask.answerFields).includes(
    '"outcomes": {"a_verdict": "file_correction" | "no_action"}',
  ),
  answerContract(demoTask.answerFields),
);
{
  // Two nodes ending in the same field name must not collide.
  const twoChoices = {
    ...demo,
    assertions: [
      { id: 'x1', description: 'd', path: 'nodes.verdict.choice', expected: 'no_action' },
      {
        id: 'x2',
        description: 'd',
        path: 'nodes.verdict.choice',
        scope: 'outcome' as const,
        expected: 'file_correction',
      },
    ],
  } as AgentGraph;
  const fields = buildBaselineTask({ graph: twoChoices, requests: [], variables: {} }).answerFields;
  check(
    'answer fields keep a unique identity per assertion',
    fields.map((f) => f.name).join(',') === 'x1,x2',
    JSON.stringify(fields),
  );
}
const chatTask = buildBaselineTask({ graph: demo, requests: ['Find X', 'Also Y'], variables: {} });
check(
  'chat requests become the prompt, refinements kept',
  chatTask.promptSource === 'conversation' &&
    chatTask.prompt.startsWith('Original request: Find X') &&
    chatTask.prompt.includes('Refinement: Also Y'),
);
check(
  'reply parser tolerates prose around JSON',
  parseBaselineReply('Sure! {"choice":"no_action"} done')?.choice === 'no_action',
);
check('reply parser returns null on no JSON', parseBaselineReply('no json here') === null);

console.log('Benchmark');
const baselineSample = benchmarkSample({
  run: run({
    id: 'b1',
    kind: 'baseline',
    result: { outcomes: { a_verdict: 'file_correction' } },
    // The demo's pipeline assertion (a_pii, 3 redacted spans) travels along but
    // must not be graded against a baseline that cannot produce it.
    input: {
      assertions: demo.assertions,
      outcomeAssertions: outcomeAssertionsForGraph(demo),
    } as unknown as Json,
  }),
  steps: [],
  egress: [egress({ runId: 'b1', tokensIn: 10, tokensOut: 10, estimatedCostCents: 2 })],
  toolLifecycle: [],
});
{
  const release = (op: string, providerId: EgressEvent['providerId']) =>
    egress({ runId: 'b1', op, providerId, destination: 'mock://' + providerId });
  const input = (rows: EgressEvent[]) => ({
    run: run({ id: 'b1', kind: 'baseline' }),
    steps: [],
    egress: [egress({ runId: 'b1', tokensIn: 10, tokensOut: 10 }), ...rows],
    toolLifecycle: [],
  });
  check(
    'releasing an unused mock browser does not mark a live run as mocked',
    benchmarkSample(input([release('releaseRun', 'browserless')]))?.mocked === false,
  );
  check(
    'a run that read through a mock browser is still mocked',
    benchmarkSample(input([release('extract', 'browserless')]))?.mocked === true,
  );
}
check(
  'baseline success is judged only by shared outcome assertions',
  baselineSample?.success === true && baselineSample.assertionsTotal === 1,
  JSON.stringify(baselineSample),
);
check(
  'a top-level field with the old name does not satisfy an outcome',
  benchmarkSample({
    run: run({
      id: 'b2',
      kind: 'baseline',
      result: { choice: 'file_correction' },
      input: { outcomeAssertions: outcomeAssertionsForGraph(demo) } as unknown as Json,
    }),
    steps: [],
    egress: [],
  })?.success === false,
);

function lifecycle(mode: 'live' | 'mock'): ToolLifecycleEvent {
  return {
    id: 'tl_' + mode,
    runId: 'run_1',
    stepId: 's1',
    sessionStateId: 'ss',
    phase: 'succeeded',
    action: { id: 'act_' + mode } as ToolLifecycleEvent['action'],
    evidence: { executionMode: mode } as ToolLifecycleEvent['evidence'],
    at: iso(0),
  };
}
const liveModelMockSearch = benchmarkSample({
  run: run({ id: 'g_mix', input: { graphSnapshot: demo } as unknown as Json }),
  steps: [],
  // A real model call and no mock egress row: the old classifier said "live".
  egress: [egress({ runId: 'g_mix', tokensIn: 10, tokensOut: 10, estimatedCostCents: 1 })],
  toolLifecycle: [lifecycle('mock')],
});
check(
  'a live model with mock tool evidence is classified as mocked',
  liveModelMockSearch?.mocked === true,
);
check(
  'missing lifecycle history leaves provenance unknown',
  benchmarkSample({ run: run({ id: 'g_old' }), steps: [], egress: [] })?.provenanceKnown === false,
);
check(
  'an agent baseline without a verified done verdict is not a success',
  benchmarkSample({
    run: run({
      id: 'b1_unverified',
      kind: 'baseline_agent',
      result: {
        outcomes: { a_verdict: 'file_correction' },
        completion: { status: 'blocked', verified: false },
      },
      input: { outcomeAssertions: outcomeAssertionsForGraph(demo) } as unknown as Json,
    }),
    steps: [],
    egress: [],
  })?.success === false,
);

console.log('Approval automation');
const pendingWrite = {
  id: 'ap',
  runId: 'r',
  status: 'pending',
  proposedAction: { actionId: 'act_w', previewFingerprint: 'fp' },
} as unknown as Approval;
const mockEvidence: ActionEvidence = {
  actionId: 'act_w',
  runId: 'r',
  resourceRef: 'x',
  kind: 'document',
  phase: 'proposed',
  evidenceLevel: 'arguments_only',
  fingerprint: 'fp',
  summary: '',
  dataLabels: ['public'],
  executionMode: 'mock',
} as ActionEvidence;
check(
  'an empty ledger is not proof a pending action is mocked',
  !canAutoApproveMockBenchmark({
    mockAll: false,
    providers: [{ mode: 'live' }],
    approval: pendingWrite,
    evidence: [{ ...mockEvidence, executionMode: 'live' }],
    egress: [],
  }),
);
check(
  'live evidence on the pending action blocks auto-approval even under MOCK_ALL',
  !canAutoApproveMockBenchmark({
    mockAll: true,
    providers: [{ mode: 'mock' }],
    approval: pendingWrite,
    evidence: [{ ...mockEvidence, executionMode: 'live' }],
    egress: [],
  }),
);
check(
  'explicit mock provenance for the exact pending action allows auto-approval',
  canAutoApproveMockBenchmark({
    mockAll: true,
    providers: [{ mode: 'mock' }],
    approval: pendingWrite,
    evidence: [mockEvidence],
    egress: [],
  }),
);

function sample(overrides: Partial<BenchmarkSample>): BenchmarkSample {
  return {
    runId: 'x',
    arm: 'graph',
    graphId: 'g1',
    createdAt: iso(0),
    status: 'succeeded',
    hasAssertions: true,
    assertionsPassed: 1,
    assertionsTotal: 1,
    success: true,
    costCents: 1,
    unpricedCalls: 0,
    tokens: 100,
    llmCalls: 1,
    wallMs: 1000,
    humanWaitMs: 0,
    mocked: false,
    experimentFingerprint: 'f'.repeat(64),
    qualityEligible: true,
    provenanceKnown: true,
    completionVerified: true,
    ...overrides,
  };
}
const graphRuns = [
  sample({ runId: 'g_a', pairId: 'p1', costCents: 6 }),
  sample({ runId: 'g_b', pairId: 'p2', costCents: 6 }),
  sample({ runId: 'g_c', pairId: 'p3', costCents: 6 }),
];
const baselines = [
  sample({ runId: 'b_c', arm: 'baseline', pairId: 'p3', costCents: 10, success: false }),
  sample({ runId: 'b_a', arm: 'baseline', pairId: 'p1', costCents: 10 }),
  sample({ runId: 'b_b', arm: 'baseline', pairId: 'p2', costCents: 20 }),
];
const saved = pairedSaving('baseline', graphRuns, baselines);
check('runs pair by pairId', saved.pairs === 3);
check(
  'savings count only where both succeeded',
  saved.bothSucceeded === 2 && saved.graphOnlyWins === 1,
);
check(
  'median saving over both-succeeded pairs',
  close(saved.medianCostSaving ?? undefined, (0.4 + 0.7) / 2),
  String(saved.medianCostSaving),
);
const report = buildBenchmarkReport(
  [...graphRuns, ...baselines, sample({ runId: 'm', mocked: true })],
  { g1: 'Demo' },
);
check(
  'mocked runs excluded by default',
  report.mockedRunsExcluded === 1 && report.overall.graph?.runs === 3,
);
check(
  'cost per success = spend / successes',
  close(report.overall.baseline?.costPerSuccessCents ?? undefined, 40 / 2),
);
check(
  'runs from a different experiment snapshot never pair',
  pairedSaving('baseline', graphRuns, [
    sample({ runId: 'b_x', arm: 'baseline', pairId: 'p1', experimentFingerprint: 'e'.repeat(64) }),
  ]).pairs === 0,
);
{
  const unpriced = pairedSaving(
    'baseline',
    [sample({ runId: 'g_u', pairId: 'u1', costCents: 1, unpricedCalls: 1 })],
    [sample({ runId: 'b_u', arm: 'baseline', pairId: 'u1', costCents: 10 })],
  );
  check(
    'pairs with unpriced calls are excluded from cost savings',
    unpriced.bothSucceeded === 1 &&
      unpriced.unpricedPairs === 1 &&
      unpriced.medianCostSaving === null,
  );
}
{
  const withLegacy = buildBenchmarkReport(
    [...graphRuns, ...baselines, sample({ runId: 'legacy', experimentFingerprint: undefined })],
    { g1: 'Demo' },
  );
  check(
    'runs without an experiment snapshot are excluded and counted',
    withLegacy.ineligibleRunsExcluded === 1 && withLegacy.overall.graph?.runs === 3,
  );
}

{
  // A run that learns a decision rewrites `compiled` (and updatedAt) without a
  // version bump; the experiment must not change, or later baselines never pair.
  const graph = buildDemoGraph('2026-10-17T00:00:00.000Z');
  const args = { requests: [], variables: {}, configuration: { mockAll: false }, toolIds: [] };
  const before = buildBenchmarkExperiment({ ...args, graph }).experiment;
  const learned = buildBenchmarkExperiment({
    ...args,
    graph: {
      ...graph,
      updatedAt: '2026-10-17T01:00:00.000Z',
      compiled: { protocol: 'agentos-graph-compile-v1', nodes: {} },
    },
  }).experiment;
  check(
    'learned decisions keep the experiment fingerprint',
    before.fingerprint === learned.fingerprint,
  );
  const edited = buildBenchmarkExperiment({
    ...args,
    graph: { ...graph, description: 'A different task' },
  }).experiment;
  check(
    'an authored edit changes the experiment fingerprint',
    before.fingerprint !== edited.fingerprint,
  );
}

console.log('\n' + checks + ' checks passed.');
