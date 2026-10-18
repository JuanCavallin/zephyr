import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTrace,
  previewTrace,
  toolActivity,
  toolGlyph,
  providerLabel,
} from '../src/lib/workspace.ts';

const empty = {
  run: null,
  steps: [],
  egress: [],
  approvals: [],
  scheduleDecisions: [],
  piiSpans: [],
  logs: [],
  lastSeq: 0,
};

const catalog = new Map([
  ['mail.send', { providerId: 'composio', family: 'mail', effect: 'write' }],
  ['docs.draft', { providerId: 'composio', family: 'googledocs', effect: 'write' }],
  ['browser.open', { providerId: 'localbrowser', family: 'browser', effect: 'read' }],
]);

const agentStep = {
  id: 'agent',
  parentStepId: null,
  runId: 'r',
  seq: 1,
  kind: 'agent_task',
  label: 'Run supervised agent task',
  status: 'running',
};
const at = (n) => new Date(Date.UTC(2026, 8, 20, 12, 0, n)).toISOString();
const life = (actionId, toolId, phase, n, extra = {}) => ({
  id: `${actionId}-${phase}`,
  runId: 'r',
  stepId: 'agent',
  sessionStateId: 'sess',
  phase,
  action: {
    id: actionId,
    runId: 'r',
    stepId: 'agent',
    toolId,
    descriptorVersion: '1',
    operation: toolId,
    arguments: { to: 'a@example.invalid' },
    destination: 'composio://gmail',
    dataLabels: ['public'],
    createdAt: at(0),
  },
  at: at(n),
  ...extra,
});
const toolNodes = (trace) => trace.nodes.filter((node) => node.role);
const viewWith = (toolLifecycle, more = {}) => ({
  ...empty,
  steps: [agentStep],
  toolLifecycle,
  ...more,
});

test('an executing Composio call shows its provider and says it is connecting', () => {
  const trace = buildTrace(
    viewWith([life('a1', 'mail.send', 'proposed', 1), life('a1', 'mail.send', 'executing', 2)]),
    null,
    Date.parse(at(5)),
    catalog,
  );
  const [node] = toolNodes(trace);
  assert.equal(node.role, 'tool-called');
  assert.equal(node.status, 'running');
  assert.equal(node.tool.providerId, 'composio');
  assert.match(node.route, /^Composio/);
  assert.equal(toolActivity(node), 'Connecting to Composio…');
  assert.equal(toolGlyph(node.tool), '✉️');
  // Measured from the first lifecycle event to now, because it has not finished.
  assert.equal(node.durationMs, 4000);
  // The tool hangs off the step that owned it.
  assert.deepEqual(
    trace.edges.map(({ source, target }) => [source, target]),
    [['agent', 'tool:a1']],
  );
});

test('"connecting" is claimed only while executing, never during policy or approval', () => {
  const activity = (phase) =>
    toolActivity(
      toolNodes(buildTrace(viewWith([life('a1', 'mail.send', phase, 1)]), null, 0, catalog))[0],
    );
  assert.equal(activity('proposed'), 'Checking policy');
  assert.equal(activity('policy_decided'), 'Checking policy');
  assert.equal(activity('awaiting_approval'), 'Needs your approval');
  assert.equal(activity('approved'), 'Connecting to Composio…');
  assert.equal(activity('executing'), 'Connecting to Composio…');
  assert.equal(activity('succeeded'), 'Ran via Composio');
  assert.equal(activity('failed'), 'Failed via Composio');
  assert.equal(activity('blocked'), 'Blocked by policy');
});

test('a tool awaiting approval is blocked, and a policy denial reads as failed', () => {
  const awaiting = toolNodes(
    buildTrace(viewWith([life('a1', 'mail.send', 'awaiting_approval', 1)]), null, 0, catalog),
  )[0];
  assert.equal(awaiting.status, 'blocked');

  const denied = toolNodes(
    buildTrace(
      viewWith([
        life('a1', 'mail.send', 'blocked', 1, {
          error: { code: 'TOOL_ACTION_DENIED', message: 'Exact tool action was denied.' },
        }),
      ]),
      null,
      0,
      catalog,
    ),
  )[0];
  assert.equal(denied.status, 'failed');
  assert.equal(denied.detail, 'Exact tool action was denied.');
});

test('every exact action is its own node, so three calls are three nodes', () => {
  const trace = buildTrace(
    viewWith([
      life('a1', 'docs.draft', 'succeeded', 1),
      life('a2', 'docs.draft', 'succeeded', 2),
      life('a3', 'docs.draft', 'failed', 3),
    ]),
    null,
    0,
    catalog,
  );
  assert.equal(toolNodes(trace).length, 3);
  assert.equal(toolNodes(trace)[0].tool.attempts, 3);
});

test('an offered tool is drawn as exposed, carries no measurements, and is never called', () => {
  const trace = buildTrace(
    viewWith([], {
      agentSessions: [
        { id: 'sess', stepId: 'agent', selectedToolIds: ['mail.send', 'docs.draft'] },
      ],
    }),
    null,
    0,
    catalog,
  );
  const nodes = toolNodes(trace);
  assert.deepEqual(
    nodes.map((n) => n.role),
    ['tool-exposed', 'tool-exposed'],
  );
  for (const node of nodes) {
    assert.equal(node.planned, true);
    assert.equal(node.durationMs, undefined);
    assert.equal(node.tokens, undefined);
    assert.equal(toolActivity(node), 'Available via Composio');
  }
});

test('exposure is unioned across Jev, the model request and the session, without duplicates', () => {
  const trace = buildTrace(
    viewWith([], {
      controlDecisions: [
        { id: 'c', stepId: 'agent', operation: 'select_tools', selectedIds: ['mail.send'] },
      ],
      modelCalls: [
        {
          id: 'm',
          sessionStateId: 'sess',
          stepId: 'agent',
          selectedToolIds: ['mail.send', 'docs.draft'],
        },
      ],
      agentSessions: [
        { id: 'sess', stepId: 'agent', selectedToolIds: ['docs.draft', 'browser.open'] },
      ],
    }),
    null,
    0,
    catalog,
  );
  assert.deepEqual(
    toolNodes(trace)
      .map((n) => n.tool.id)
      .sort(),
    ['browser.open', 'docs.draft', 'mail.send'],
  );

  // A model-selection decision is not tool exposure.
  const ignored = buildTrace(
    viewWith([], {
      controlDecisions: [
        { id: 'c', stepId: 'agent', operation: 'select_model', selectedIds: ['route-1'] },
      ],
    }),
    null,
    0,
    catalog,
  );
  assert.equal(toolNodes(ignored).length, 0);
});

test('a tool that was called is not also drawn as a ghost', () => {
  const trace = buildTrace(
    viewWith([life('a1', 'mail.send', 'succeeded', 1)], {
      agentSessions: [
        { id: 'sess', stepId: 'agent', selectedToolIds: ['mail.send', 'docs.draft'] },
      ],
    }),
    null,
    0,
    catalog,
  );
  assert.deepEqual(
    toolNodes(trace).map((n) => [n.tool.id, n.role]),
    [
      ['mail.send', 'tool-called'],
      ['docs.draft', 'tool-exposed'],
    ],
  );
});

test('a tool the catalog does not know is never presented as Composio', () => {
  const trace = buildTrace(
    viewWith([life('a1', 'mystery.tool', 'executing', 1)]),
    null,
    0,
    new Map(),
  );
  const [node] = toolNodes(trace);
  assert.equal(node.tool.providerId, undefined);
  assert.doesNotMatch(node.route, /Composio/);
  assert.doesNotMatch(toolActivity(node), /Composio/);
  assert.equal(providerLabel('localbrowser'), 'Local browser (Playwright)');
  assert.equal(providerLabel('browserless'), 'Browserless');
  assert.equal(toolGlyph({ id: 'x.y', providerId: 'composio' }), '🔌');
  assert.equal(toolGlyph({ id: 'x.y' }), '🔧');
});

test('in a graph run a tool hangs off the plan node its step executed', () => {
  const graph = { nodes: [{ id: 'n1', label: 'Research', type: 'agent_task' }], edges: [] };
  const trace = buildTrace(
    {
      ...empty,
      steps: [{ ...agentStep, nodeId: 'n1' }],
      toolLifecycle: [life('a1', 'browser.open', 'succeeded', 1)],
    },
    graph,
    0,
    catalog,
  );
  assert.deepEqual(
    trace.edges.map(({ source, target }) => [source, target]),
    [['n1', 'tool:a1']],
  );
});

test('a run with no tool events is unchanged', () => {
  const trace = buildTrace({ ...empty, steps: [agentStep] }, null, 0, catalog);
  assert.equal(toolNodes(trace).length, 0);
  assert.equal(trace.nodes.length, 1);
});

test('preview shows illustrative Composio tools, and mail.send waits on approval', () => {
  const during = previewTrace('support', 9000);
  assert.ok(
    during.nodes.some((n) => n.role === 'tool-exposed'),
    'offered tools appear',
  );
  assert.ok(during.nodes.every((n) => !n.tool || n.tool.providerId === 'composio'));

  const awaiting = previewTrace('support', 18000);
  const send = awaiting.nodes.find((n) => n.tool?.id === 'mail.send');
  assert.equal(send.status, 'pending');
  assert.equal(send.planned, true);
  assert.equal(awaiting.nodes.at(-1).id, 'finish');

  const sendIn = (approval) =>
    previewTrace('support', 18000, approval).nodes.find((n) => n.tool?.id === 'mail.send');
  assert.equal(sendIn('approved').status, 'succeeded');
  assert.equal(sendIn('rejected').status, 'skipped');
  assert.equal(
    previewTrace('trip', 18000).nodes.some((n) => n.tool?.id === 'mail.send'),
    false,
  );
});

test('tool nodes add no tokens or cost of their own', () => {
  const trace = previewTrace('support', 18000, 'approved');
  const tools = trace.nodes.filter((n) => n.tool);
  assert.ok(tools.length > 0);
  for (const node of tools) {
    assert.equal(node.tokens, undefined);
    assert.equal(node.costCents, undefined);
  }
});
