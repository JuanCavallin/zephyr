/**
 * End-to-end smoke test. The only test in the repo, on purpose.
 *
 * Verifies the walking skeleton against a running API in mock mode:
 *   launch a run -> steps stream -> it BLOCKS on an approval -> approve ->
 *   it completes -> the egress ledger recorded the calls.
 *
 * Usage:  pnpm dev:api    (in one terminal)
 *         pnpm smoke      (in another)
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8787';

let failures = 0;
let controlCookie = '';

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log('  [' + mark + '] ' + label + (detail ? ' -> ' + detail : ''));
}

async function api(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      Origin: new URL(BASE).origin,
      ...(controlCookie ? { Cookie: controlCookie } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function waitFor(runId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api('/api/runs/' + runId);
    if (body?.run && predicate(body.run, body)) return body;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function main() {
  console.log('Smoke test against ' + BASE + '\n');
  const setup = await fetch(BASE + '/api/credentials/session', {
    method: 'POST',
    headers: { Origin: new URL(BASE).origin },
  });
  controlCookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  check('local control session established', setup.ok && Boolean(controlCookie));
  const unauthenticated = await fetch(BASE + '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: new URL(BASE).origin },
    body: '{}',
  });
  check('graph authoring requires authenticated local control', unauthenticated.status === 401);
  const foreignOrigin = await api('/api/graphs', {
    method: 'POST',
    headers: { Origin: 'https://example.com' },
    body: JSON.stringify({ name: 'Must not be created' }),
  });
  check('cross-origin dashboard mutations are denied', foreignOrigin.status === 403);

  console.log('1. Health and providers');
  const health = await api('/api/health');
  check('GET /api/health is 200', health.status === 200, JSON.stringify(health.body));

  const providers = await api('/api/providers');
  const list = providers.body?.providers ?? [];
  const requiredProviders = [
    'hermes',
    'jev',
    'browserbase',
    'localbrowser',
    'composio',
    'ollama',
    'mcp',
    'anthropic',
    'gemini',
    'gptzero',
  ];
  check(
    'all control-plane providers reported',
    requiredProviders.every((id) => list.some((provider) => provider.id === id)),
    list.map((provider) => provider.id).join(', '),
  );
  check(
    'no provider is in live mode without a key',
    list.every((p) => p.mode !== 'live'),
    list.map((p) => p.id + '=' + p.mode).join(' '),
  );

  // REGRESSION GUARD. Registering the `graph` playbook put it in the launch
  // dropdown, which posts an empty input -- and a graph run needs a graphId, so
  // that option could never work. Anything the API advertises as directly
  // launchable must actually launch with no input.
  console.log('\n1b. Every directly-launchable playbook really launches');
  const advertised = (await api('/api/playbooks')).body?.playbooks ?? [];
  check(
    'playbooks report directLaunch',
    advertised.every((p) => typeof p.directLaunch === 'boolean'),
  );
  for (const playbook of advertised.filter((p) => p.directLaunch)) {
    const probe = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ kind: playbook.kind, input: {} }),
    });
    check(
      '"' + playbook.kind + '" launches with an empty input',
      probe.status === 201,
      'status ' + probe.status,
    );
    if (probe.body?.run?.id) {
      await api('/api/runs/' + probe.body.run.id + '/cancel', { method: 'POST' });
    }
  }
  const needsInput = advertised.filter((p) => !p.directLaunch);
  check(
    'a playbook needing configuration is flagged rather than offered blindly',
    needsInput.every(
      (p) => p.kind === 'graph' || p.kind === 'agent' || p.kind === 'baseline_agent',
    ),
    needsInput.map((p) => p.kind).join(',') || 'none',
  );

  console.log('\n2. Launch a run');
  const created = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'demo', input: {} }),
  });
  check('POST /api/runs is 201', created.status === 201, 'status ' + created.status);
  const runId = created.body?.run?.id;
  check('run id returned', Boolean(runId), runId ?? 'none');
  if (!runId) return;

  console.log('\n3. The risk gate blocks on the irreversible action');
  const blocked = await waitFor(runId, (run) => run.status === 'awaiting_approval');
  check('run reached awaiting_approval', Boolean(blocked), blocked?.run?.status ?? 'timed out');
  if (!blocked) return;

  const approval = blocked.approvals.find((a) => a.status === 'pending');
  check('a pending approval exists', Boolean(approval));
  check(
    'it was gated on reversibility, not model confidence',
    approval?.reversibility === 'irreversible' &&
      approval?.policyRule === 'irreversible-action-requires-approval',
    approval?.policyRule ?? 'none',
  );

  const swarmWorkers = blocked.steps.filter((s) => s.parentStepId !== null);
  check(
    'swarm fanned out as child steps',
    swarmWorkers.length >= 3,
    swarmWorkers.length + ' workers',
  );

  const agentTaskStep = blocked.steps.find((s) => s.kind === 'agent_task');
  check('agent task step ran', Boolean(agentTaskStep), agentTaskStep?.status ?? 'missing');
  check(
    'agent task step succeeded',
    agentTaskStep?.status === 'succeeded',
    agentTaskStep?.status ?? 'none',
  );

  const scheduleDecisions = blocked.scheduleDecisions ?? [];
  check(
    'a schedule decision was recorded',
    scheduleDecisions.length >= 1,
    scheduleDecisions.length + ' found',
  );
  const decision = scheduleDecisions[0];
  check(
    'Jev exposed no more than the trusted tool candidates',
    Boolean(decision) && decision.exposedTools.length <= decision.availableTools.length,
    decision
      ? decision.exposedTools.length + ' of ' + decision.availableTools.length
      : 'no decision',
  );
  check('the routing decision names the rule that produced it', Boolean(decision?.rule));
  check(
    'the routing decision is NOT gated on model confidence',
    !('riskClass' in (decision ?? {})),
  );

  check(
    'Hermes tool activity is reported when Jev exposes a tool',
    !decision?.exposedTools.length ||
      blocked.egress.some((e) => e.policyRule === 'reported-post-hoc-by-hermes'),
  );

  check(
    'PII was detected and pinned locally',
    blocked.piiSpans.length >= 3,
    blocked.piiSpans.length + ' spans',
  );
  check(
    'no raw PII value crossed the wire',
    blocked.piiSpans.every((s) => !('value' in s) && s.routedTo === 'local'),
  );

  // Regression guard. A step's `output` is streamed and stored, so a playbook
  // that returns a raw document from a step leaks it to every connected client.
  // These are the exact values the demo case file contains.
  const wire = JSON.stringify(blocked);
  check(
    'no raw sensitive value appears anywhere in the client payload',
    !wire.includes('046 454 286') &&
      !wire.includes('avery.chen@example.edu') &&
      !wire.includes('519-555-0142'),
  );
  check('placeholders appear instead', wire.includes('[[PII_1]]'));

  console.log('\n4. Approve, and the run resumes');
  const decided = await api('/api/approvals/' + approval.id + '/decide', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  });
  check('POST decide is 200', decided.status === 200, 'status ' + decided.status);

  const done = await waitFor(runId, (run) => run.status === 'succeeded' || run.status === 'failed');
  check('run succeeded', done?.run?.status === 'succeeded', done?.run?.status ?? 'timed out');
  check('run produced a summary', Boolean(done?.run?.summary), done?.run?.summary ?? '');

  console.log('\n5. The egress ledger');
  const egress = await api('/api/runs/' + runId + '/egress');
  const events = egress.body?.events ?? [];
  check('ledger recorded provider calls', events.length > 0, events.length + ' rows');
  check(
    'every row names the rule that allowed it',
    events.every((e) => Boolean(e.policyRule)),
  );
  check(
    'the cloud model call carried placeholders, not values',
    events.some((e) => e.providerId === 'anthropic' && e.decision === 'redacted'),
  );
  check('summary reports zero raw values sent', egress.body?.summary?.rawValuesSent === 0);

  console.log('\n6. Tool catalog and analytics');
  const tools = await api('/api/tools');
  check('GET /api/tools is 200', tools.status === 200, 'status ' + tools.status);
  const catalog = tools.body?.tools ?? [];
  check('catalog returned tools', catalog.length > 0, catalog.length + ' tools');
  check(
    'every tool has a name and a description',
    catalog.every((t) => Boolean(t.name) && Boolean(t.description)),
  );
  const cachedRead = await api('/api/tools');
  check('a second read is served from cache', cachedRead.body?.cached === true);

  const analytics = await api('/api/runs/' + runId + '/analytics');
  check('GET analytics is 200', analytics.status === 200, 'status ' + analytics.status);
  const totals = analytics.body?.totals ?? {};

  // REGRESSION GUARD. Before the ProviderMeta fix these were all zero: the
  // anthropic and jev adapters reported usage in `data` but never in `meta`,
  // and withEgress only reads `meta`. If these fail, check the adapter, not
  // the rollup.
  check(
    'tokens reached the egress ledger',
    totals.tokensIn > 0 && totals.tokensOut > 0,
    totals.tokensIn + ' in / ' + totals.tokensOut + ' out',
  );
  check('model calls were counted', totals.llmCalls > 0, totals.llmCalls + ' calls');
  check(
    'a cost was estimated',
    totals.estimatedCostCents > 0,
    totals.estimatedCostCents + ' cents',
  );

  check('wall-clock time was measured', totals.wallMs > 0, totals.wallMs + 'ms');
  check(
    'tool exposure never exceeds the trusted candidates',
    totals.toolsAvailable >= totals.toolsExposed,
    totals.toolsExposed + ' of ' + totals.toolsAvailable,
  );
  check(
    'the demo playbook rolls up as unattributed (its steps carry no nodeId)',
    analytics.body?.unattributed !== null && (analytics.body?.nodes ?? []).length === 0,
    (analytics.body?.nodes ?? []).length + ' attributed node(s)',
  );
  check(
    'no step was dropped from the rollup',
    analytics.body?.unattributed?.stepIds?.length === totals.stepCount,
    analytics.body?.unattributed?.stepIds?.length + ' of ' + totals.stepCount,
  );

  console.log('\n7. Graph CRUD');
  const seeded = await api('/api/graphs');
  const demoGraph = (seeded.body?.graphs ?? []).find((g) => g.id === 'graph_demo');
  check('the demo graph is seeded', Boolean(demoGraph), demoGraph?.name ?? 'missing');
  check(
    'it covers every executor family',
    new Set((demoGraph?.nodes ?? []).map((n) => n.type)).size >= 7,
    new Set((demoGraph?.nodes ?? []).map((n) => n.type)).size + ' distinct node types',
  );

  const made = await api('/api/graphs', {
    method: 'POST',
    body: JSON.stringify({ name: 'smoke graph' }),
  });
  check('POST /api/graphs is 201', made.status === 201, 'status ' + made.status);
  const gid = made.body?.graph?.id;

  const node = (id) => ({
    id,
    type: 'tool',
    label: 'Tool ' + id,
    position: { x: 0, y: 0 },
    config: { tool: 'sheets.append', args: {} },
  });

  let v = made.body?.graph?.version;
  const n1 = await api('/api/graphs/' + gid + '/nodes', {
    method: 'POST',
    body: JSON.stringify({ node: node('a'), version: v }),
  });
  check('add node is 201', n1.status === 201, 'status ' + n1.status);
  v = n1.body?.graph?.version;

  const n2 = await api('/api/graphs/' + gid + '/nodes', {
    method: 'POST',
    body: JSON.stringify({ node: node('b'), version: v }),
  });
  v = n2.body?.graph?.version;

  const e1 = await api('/api/graphs/' + gid + '/edges', {
    method: 'POST',
    body: JSON.stringify({ edge: { id: 'e1', source: 'a', target: 'b' }, version: v }),
  });
  check('add edge is 201', e1.status === 201, 'status ' + e1.status);
  v = e1.body?.graph?.version;

  // The point of routing every mutation through one whole-graph validate: a
  // node delete must take its edges with it, or the next save fails on a
  // dangling reference.
  const del = await api('/api/graphs/' + gid + '/nodes/b', {
    method: 'DELETE',
    body: JSON.stringify({ version: v }),
  });
  check('delete node is 200', del.status === 200, 'status ' + del.status);
  check(
    'deleting a node cascaded to its edges',
    (del.body?.graph?.edges ?? []).length === 0,
    (del.body?.graph?.edges ?? []).length + ' edges left',
  );

  const stale = await api('/api/graphs/' + gid + '/nodes', {
    method: 'POST',
    body: JSON.stringify({ node: node('c'), version: 1 }),
  });
  check('a stale version is a 409', stale.status === 409, 'status ' + stale.status);

  const cyclic = await api('/api/graphs/' + gid, {
    method: 'PUT',
    body: JSON.stringify({
      nodes: [node('x'), node('y')],
      edges: [
        { id: 'c1', source: 'x', target: 'y' },
        { id: 'c2', source: 'y', target: 'x' },
      ],
    }),
  });
  check(
    'a cycle is rejected with 400, not accepted',
    cyclic.status === 400,
    'status ' + cyclic.status,
  );

  await api('/api/graphs/' + gid, { method: 'DELETE' });

  console.log('\n8. Run the seeded graph');
  const gRun = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'graph',
      input: { graphId: 'graph_demo', variables: { target: 'SMOKE-1' } },
    }),
  });
  check('POST graph run is 201', gRun.status === 201, 'status ' + gRun.status);
  const gRunId = gRun.body?.run?.id;

  check(
    'the run snapshotted the graph it will execute',
    Boolean(gRun.body?.run?.input?.graphSnapshot),
  );

  const gBlocked = await waitFor(gRunId, (run) => run.status === 'awaiting_approval', 60_000);
  check(
    'the graph run reached its approval gate',
    Boolean(gBlocked),
    gBlocked?.run?.status ?? 'timed out',
  );

  if (gBlocked) {
    const withNode = gBlocked.steps.filter((s) => s.nodeId);
    check(
      'every step is attributed to a graph node',
      withNode.length === gBlocked.steps.length,
      withNode.length + ' of ' + gBlocked.steps.length,
    );

    const dispatched = gBlocked.scheduleDecisions.find(
      (d) => d.rule === 'dispatch-selected-single-tool',
    );
    check(
      'dispatch narrowed its candidates to exactly one tool, with no harness',
      Boolean(dispatched) && dispatched.exposedTools.length === 1,
      dispatched ? dispatched.availableTools.length + ' -> 1' : 'no dispatch decision',
    );

    // Each external mutation has its own receipt, including background writes.
    // Approving one gate cannot approve a later submit implicitly.
    let gDone = gBlocked;
    const graphDeadline = Date.now() + 60_000;
    const decided = new Set();
    while (
      gDone &&
      !['succeeded', 'failed', 'cancelled'].includes(gDone.run.status) &&
      Date.now() < graphDeadline
    ) {
      for (const approval of gDone.approvals.filter(
        (a) => a.status === 'pending' && !decided.has(a.id),
      )) {
        const result = await api('/api/approvals/' + approval.id + '/decide', {
          method: 'POST',
          body: JSON.stringify({ decision: 'approved' }),
        });
        check('each graph mutation receives explicit approval', result.status === 200);
        decided.add(approval.id);
      }
      await new Promise((r) => setTimeout(r, 250));
      gDone = (await api('/api/runs/' + gRunId)).body;
    }
    check(
      'the graph run completed',
      gDone?.run?.status === 'succeeded',
      gDone?.run?.status ?? 'timed out',
    );
    const swarmSteps = gDone?.steps.filter((s) => s.nodeId === 'verify') ?? [];
    check(
      'a swarm parent and its workers share one nodeId',
      swarmSteps.length === 4,
      swarmSteps.length + ' steps on the swarm node',
    );

    const gAnalytics = await api('/api/runs/' + gRunId + '/analytics');
    check(
      'analytics attributes every node, nothing unattributed',
      gAnalytics.body?.unattributed === null && gAnalytics.body?.nodes.length === 8,
      (gAnalytics.body?.nodes ?? []).length +
        ' nodes, unattributed=' +
        gAnalytics.body?.unattributed,
    );

    // The whole argument for the middle rung, asserted rather than claimed.
    const nodeById = Object.fromEntries((gAnalytics.body?.nodes ?? []).map((n) => [n.nodeId, n]));
    const agentTokens = (nodeById.followup?.tokensIn ?? 0) + (nodeById.followup?.tokensOut ?? 0);
    const dispatchTokens = (nodeById.notify?.tokensIn ?? 0) + (nodeById.notify?.tokensOut ?? 0);
    check(
      'dispatch costs far fewer tokens than the agent harness',
      dispatchTokens > 0 && dispatchTokens * 3 < agentTokens,
      dispatchTokens + ' vs ' + agentTokens + ' tokens',
    );
    check(
      'deterministic nodes cost nothing',
      (nodeById.load?.tokensIn ?? 0) === 0 && (nodeById.load?.llmCalls ?? 0) === 0,
    );
  }

  console.log('\n9. Rejection path');
  const second = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'demo', input: { workerCount: 2 } }),
  });
  const secondId = second.body?.run?.id;
  const blocked2 = await waitFor(secondId, (run) => run.status === 'awaiting_approval');
  const approval2 = blocked2?.approvals.find((a) => a.status === 'pending');
  if (approval2) {
    await api('/api/approvals/' + approval2.id + '/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'rejected', note: 'smoke test' }),
    });
    const cancelled = await waitFor(
      secondId,
      (run) => run.status === 'cancelled' || run.status === 'failed',
    );
    check(
      'rejecting stops the run',
      cancelled?.run?.status === 'cancelled',
      cancelled?.run?.status,
    );
    const conflict = await api('/api/approvals/' + approval2.id + '/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    check('deciding twice is a 409', conflict.status === 409, 'status ' + conflict.status);
  } else {
    check('second run reached its approval', false, 'timed out');
  }

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  console.error('Is the API running?  pnpm dev:api');
  process.exit(1);
});
