import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTrace,
  previewTrace,
  advancePreview,
  formatCost,
  formatTokens,
  layoutTrace,
  canInterveneLive,
  RUN_CAPABILITIES,
  LIVE_INTERVENTION_REASON,
} from '../src/lib/workspace.ts';

const empty = {
  run: null,
  steps: [],
  egress: [],
  approvals: [],
  scheduleDecisions: [],
  piiSpans: [],
  logs: [],
  codingWork: [],
  lastSeq: 0,
};
const step = (id, parentStepId = null) => ({
  id,
  parentStepId,
  runId: 'r',
  seq: 1,
  kind: 'tool',
  label: id,
  status: 'succeeded',
});

test('live trace does not invent dependencies from sequence order', () => {
  const trace = buildTrace({ ...empty, steps: [step('a'), step('b'), step('c', 'a')] });
  assert.deepEqual(
    trace.edges.map(({ source, target }) => [source, target]),
    [['a', 'c']],
  );
});

test('unknown live measurements remain unknown instead of becoming free', () => {
  const trace = buildTrace({ ...empty, steps: [step('a')] });
  assert.equal(trace.tokens, undefined);
  assert.equal(trace.costCents, undefined);
  assert.equal(trace.nodes[0].costCents, undefined);
});

test('ledger measurements are attributed to their actual node and cents stay cents', () => {
  const trace = buildTrace({
    ...empty,
    steps: [step('a')],
    egress: [
      {
        id: 'e',
        stepId: 'a',
        tokensIn: 100,
        tokensOut: 20,
        estimatedCostCents: 3.7,
        destination: 'mock://hermes',
      },
    ],
  });
  assert.equal(trace.tokens, 120);
  assert.equal(trace.nodes[0].costCents, 3.7);
  assert.equal(trace.provenance, 'mock');
  assert.equal(formatCost(3.7), '$0.037');
});

test('paused preview clock cannot advance', () => {
  assert.equal(advancePreview(4500, 1000, false, 18000), 4500);
  assert.equal(advancePreview(4500, 1000, true, 18000), 5500);
  assert.equal(advancePreview(17900, 1000, true, 18000), 18000);
});

test('support preview stops at approval, never claims to send outreach', () => {
  const trace = previewTrace('support', 18000);
  assert.equal(trace.status, 'awaiting_approval');
  assert.equal(trace.nodes.at(-1).status, 'blocked');
  assert.equal(trace.provenance, 'preview');
  assert.equal(previewTrace('support', 18000, 'approved').status, 'succeeded');
  assert.equal(previewTrace('support', 18000, 'rejected').status, 'cancelled');
});

test('travel preview finishes without an invented approval gate', () => {
  assert.equal(previewTrace('trip', 18000).status, 'succeeded');
});

test('skipped steps remain skipped and failures are not hidden', () => {
  const trace = buildTrace({
    ...empty,
    steps: [
      { ...step('a'), status: 'skipped' },
      { ...step('b'), status: 'failed' },
    ],
  });
  assert.equal(trace.nodes[0].status, 'skipped');
  assert.equal(trace.nodes[1].status, 'failed');
});

test('a planned node renders as planned and carries no measurements', () => {
  const graph = {
    nodes: [
      { id: 'n1', label: 'Read context', type: 'redact' },
      { id: 'n2', label: 'Write brief', type: 'agent_task' },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  };
  const trace = buildTrace(
    { ...empty, steps: [{ ...step('s1'), nodeId: 'n1', startedAt: '2026-09-19T12:00:00.000Z' }] },
    graph,
  );
  const n2 = trace.nodes.find((node) => node.id === 'n2');
  assert.equal(n2.planned, true);
  assert.equal(n2.status, 'pending');
  assert.equal(n2.tokens, undefined);
  assert.equal(n2.costCents, undefined);
  assert.equal(n2.durationMs, undefined);
});

test('a node materializes on its step being reported without losing node identity', () => {
  const graph = { nodes: [{ id: 'n1', label: 'Read context', type: 'redact' }], edges: [] };
  const before = buildTrace({ ...empty }, graph);
  const after = buildTrace(
    { ...empty, steps: [{ ...step('s1'), nodeId: 'n1', startedAt: '2026-09-19T12:00:00.000Z' }] },
    graph,
  );
  assert.equal(before.nodes[0].id, 'n1');
  assert.equal(after.nodes[0].id, 'n1');
  assert.equal(before.nodes[0].planned, true);
  assert.equal(after.nodes[0].planned, false);
  assert.equal(after.nodes[0].status, 'succeeded');
});

test('a runtime-created node appears and is distinguished from planned structure', () => {
  const graph = { nodes: [{ id: 'n1', label: 'Research', type: 'browse' }], edges: [] };
  const parent = { ...step('s1'), nodeId: 'n1' };
  const child = { ...step('s2', 's1'), nodeId: null, label: 'Fanned-out worker' };
  const trace = buildTrace({ ...empty, steps: [parent, child] }, graph);
  const runtime = trace.nodes.find((node) => node.id === 's2');
  assert.ok(runtime, 'the runtime-created step must appear on the canvas');
  assert.equal(runtime.unplanned, true);
  assert.equal(trace.nodes.find((node) => node.id === 'n1').unplanned, false);
  assert.deepEqual(
    trace.edges.map(({ source, target }) => [source, target]),
    [['n1', 's2']],
  );
});

test('the preview graph grows: a runtime node does not exist before the runtime makes it', () => {
  const early = previewTrace('support', 3000);
  const later = previewTrace('support', 9000);
  assert.equal(
    early.nodes.some((node) => node.unplanned),
    false,
  );
  assert.ok(
    later.nodes.find((node) => node.unplanned),
    'a runtime-created node must appear once the runtime creates it',
  );
  assert.ok(later.nodes.length > early.nodes.length);
  for (const node of early.nodes) assert.ok(later.nodes.some((item) => item.id === node.id));
});

test('editing a route in preview changes what re-runs, and is labeled as revised', () => {
  const plain = previewTrace('support', 9000);
  const edited = previewTrace('support', 9000, undefined, { research: 'local' });
  const before = plain.nodes.find((node) => node.id === 'research');
  const after = edited.nodes.find((node) => node.id === 'research');
  assert.notEqual(after.route, before.route);
  assert.equal(after.route, 'Local · private');
  assert.equal(after.revised, true);
  assert.equal(before.revised, false);
  assert.match(after.detail, /re-authorized/);
});

test('pause/resume is live, but editing a running node stays closed', () => {
  assert.equal(RUN_CAPABILITIES.pauseResume, true);
  // Pausing was necessary for live editing, not sufficient -- a run executes a
  // snapshot, so the edit still would not reach it.
  assert.equal(RUN_CAPABILITIES.editRunningNode, false);
  assert.equal(canInterveneLive, false);
  assert.match(LIVE_INTERVENTION_REASON, /snapshot/);
});

test('layout is stable: adding a node never reorders the nodes already placed', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
  ];
  const before = layoutTrace([{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges);
  const after = layoutTrace(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    [...edges, { source: 'a', target: 'd' }],
  );
  assert.equal(before.get('b').x, after.get('b').x);
  assert.ok(before.get('b').y < before.get('c').y);
  assert.ok(after.get('b').y < after.get('c').y);
  assert.ok(after.get('c').y < after.get('d').y);
});

test('per-node token usage is compact, and unknown usage never reads as zero', () => {
  assert.equal(formatTokens(undefined), '—');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(156), '156');
  assert.equal(formatTokens(1130), '1.1k');
  assert.equal(formatTokens(2000), '2k');

  // A planned node has reported nothing, so its node card must show the em dash.
  const graph = {
    nodes: [
      { id: 'n1', label: 'Read context', type: 'redact' },
      { id: 'n2', label: 'Write brief', type: 'agent_task' },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  };
  const trace = buildTrace(
    {
      ...empty,
      steps: [{ ...step('s1'), nodeId: 'n1' }],
      egress: [
        {
          id: 'e',
          stepId: 's1',
          tokensIn: 900,
          tokensOut: 230,
          estimatedCostCents: 1,
          destination: 'mock://hermes',
        },
      ],
    },
    graph,
  );
  assert.equal(formatTokens(trace.nodes.find((n) => n.id === 'n1').tokens), '1.1k');
  assert.equal(formatTokens(trace.nodes.find((n) => n.id === 'n2').tokens), '—');
});
