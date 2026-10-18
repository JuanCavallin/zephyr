import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mockGraphFor } from '../src/providers/anthropic/mockGraphs.js';

// Defaults to an isolated in-memory, all-mock API. An explicitly supplied URL
// must be loopback and must report only mock/disabled providers before this
// script creates conversations, graphs, runs or individual approval decisions.
const configuredBase = process.env.VERIFY_AUTHORING_BASE;
let server: Server | undefined;
let base: string;
if (configuredBase) {
  const url = new URL(configuredBase);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Authoring verification requires a loopback API.',
  );
  assert.equal(url.protocol, 'http:');
  base = url.origin;
} else {
  process.env.MOCK_ALL = 'true';
  process.env.PERSIST_TO_DISK = 'false';
  process.env.MOCK_MIN_LATENCY_MS = '0';
  process.env.MOCK_MAX_LATENCY_MS = '0';
  process.env.MOCK_FAILURE_RATE = '0';
  const { initializeRuntimeProviders } = await import('../src/services/runtime.js');
  const { createApp } = await import('../src/app.js');
  await initializeRuntimeProviders();
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = 'http://127.0.0.1:' + address.port;
}

let cookie = '';
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(response.ok, path + ': HTTP ' + response.status + ' ' + JSON.stringify(result));
  return result;
}
function toolIds(graph: any): string[] {
  return graph.nodes.flatMap((node: any) => [
    ...(typeof node.config.tool === 'string' ? [node.config.tool] : []),
    ...(node.config.availableTools ?? []),
    ...(node.config.candidateTools ?? []),
  ]);
}
async function runGraph(graph: any, label: string) {
  const created = await api('/runs', {
    kind: 'graph',
    title: 'Mock authoring regression: ' + label,
    input: {
      graphId: graph.id,
      variables: {
        document: 'Synthetic public draft: compare fictional project options and file the result.',
      },
    },
  });
  const runId = created.run.id;
  const approved = new Set<string>();
  const deadline = Date.now() + 60_000;
  let detail: any;
  while (Date.now() < deadline) {
    detail = await api('/runs/' + runId);
    for (const approval of detail.approvals.filter((item: any) => item.status === 'pending')) {
      assert.equal(
        approved.has(approval.id),
        false,
        'Resolved approval must not become pending again.',
      );
      // Each API request decides precisely one currently pending action. No
      // blanket permission or live provider action is granted by this harness.
      const result = await api('/approvals/' + approval.id + '/decide', {
        decision: 'approved',
        note: 'Approved synthetic all-mock regression action.',
      });
      assert.equal(result.approval.status, 'approved');
      approved.add(approval.id);
    }
    if (['succeeded', 'failed', 'cancelled'].includes(detail.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  assert.equal(
    detail?.run.status,
    'succeeded',
    label +
      ': ' +
      JSON.stringify({
        status: detail?.run.status,
        error: detail?.run.error,
        steps: detail?.steps
          .filter((step: any) => step.status === 'failed')
          .map((step: any) => ({ label: step.label, error: step.error })),
      }),
  );
  assert.ok(detail.steps.length > 0);
  assert.equal(
    detail.approvals.some((item: any) => item.status === 'pending'),
    false,
  );
  assert.ok(
    detail.egress.every((event: any) => !/^https?:|^wss?:/.test(event.destination)),
    'Mock authoring must not report cloud egress.',
  );
  const { events } = await api('/runs/' + runId + '/events');
  const completed = events
    .filter(
      (stored: any) =>
        stored.event.type === 'tool.lifecycle' && stored.event.lifecycle.phase === 'succeeded',
    )
    .map((stored: any) => stored.event.lifecycle);
  for (const event of completed) {
    assert.equal(
      event.evidence?.executionMode,
      'mock',
      'Completed tool evidence must disclose its mock mode: ' + event.action.toolId,
    );
    assert.notEqual(
      event.evidence?.evidenceLevel,
      'readback_verified',
      'Mock output must not claim real provider readback.',
    );
  }
  console.log(
    JSON.stringify({
      fixture: label,
      graphId: graph.id,
      runId,
      status: detail.run.status,
      steps: detail.steps.length,
      approvals: approved.size,
      executedTools: completed.map((item: any) => item.action.toolId),
      mode: 'mock',
    }),
  );
  return { detail, completed, runId };
}

try {
  const status = await api('/providers');
  assert.ok(status.providers.length > 0);
  assert.ok(
    status.providers.every(
      (provider: any) => provider.mode === 'mock' || provider.mode === 'disabled',
    ),
    'Refusing authoring/action verification on a live API.',
  );
  const setup = await fetch(base + '/api/credentials/session', {
    method: 'POST',
    headers: { origin: base },
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  const catalog = new Set<string>(
    (await api('/tools')).tools
      .filter((tool: any) => tool.availability === 'available')
      .map((tool: any) => tool.name),
  );
  assert.ok(catalog.has('agentos.document_read'));
  assert.ok(catalog.has('agentos.document_update'));
  assert.ok(catalog.has('web.search'));
  const fixtures = [
    {
      label: 'invoice',
      prompt: 'Check overdue vendor invoices and email the findings.',
      name: 'Vendor invoice sweep',
    },
    {
      label: 'document',
      prompt: 'Summarise the document and file the result.',
      name: 'Summarise and file',
    },
    {
      label: 'research',
      prompt: 'Investigate available options and take the appropriate action.',
      name: 'Research and report',
    },
  ];
  let documentGraph: any;
  for (const fixture of fixtures) {
    const { conversation } = await api('/conversations', {});
    const { graph, message } = await api('/conversations/' + conversation.id + '/messages', {
      text: fixture.prompt,
    });
    assert.equal(graph.name, fixture.name);
    assert.ok(message.text.length > 0);
    for (const id of toolIds(graph))
      assert.ok(catalog.has(id), 'Authored tool is absent from the trusted registry: ' + id);
    if (fixture.label === 'document') {
      documentGraph = graph;
      const draft = graph.nodes.find((node: any) => node.id === 'file').config.args[
        'agentos.document_update'
      ];
      assert.equal(draft.artifactId, 'summary');
      assert.equal(draft.expectedVersion, 'new');
      assert.equal(typeof draft.content, 'string');
      assert.equal(toolIds(graph).includes('docs.write'), false);
    }
    await runGraph(graph, fixture.label);
  }
  // Exercise the document candidate itself, not just its schema in the authored
  // graph: fork a synthetic test graph and bind only that action to the new
  // reviewed local draft ID. The original conversation graph remains unchanged.
  const draftNodes = structuredClone(documentGraph.nodes);
  const draftDispatch = draftNodes.find((node: any) => node.id === 'file');
  draftDispatch.type = 'tool';
  draftDispatch.config = {
    tool: 'agentos.document_update',
    args: draftDispatch.config.args['agentos.document_update'],
  };
  const { graph: draftGraph } = await api('/graphs', {
    name: 'Mock document draft authoring regression',
    nodes: draftNodes,
    edges: documentGraph.edges,
  });
  const draft = await runGraph(draftGraph, 'document-draft');
  const update = draft.completed.find(
    (event: any) => event.action.toolId === 'agentos.document_update',
  );
  assert.ok(update, 'New document draft tool must execute through the exact-action broker.');
  assert.equal(update.evidence.executionMode, 'mock');
  assert.equal(update.evidence.evidenceLevel, 'provider_reported');
  const preview = (await api('/runs/' + draft.runId + '/previews/' + update.evidence.previewRef))
    .preview;
  assert.equal(preview.kind, 'document');
  assert.equal(preview.title, 'summary');
  assert.ok(preview.changes.length > 0);

  // Pure fixture checks cover preferred-backend rewrites without launching any
  // alternative provider or changing the currently running API configuration.
  for (const backend of ['browserbase', 'browserless', 'localbrowser'] as const)
    for (const fixture of [fixtures[0]!, fixtures[2]!]) {
      const graph = JSON.parse(mockGraphFor(fixture.prompt, backend));
      const browsers = toolIds(graph).filter((id) =>
        /^(browserbase|browserless|localbrowser)\./.test(id),
      );
      assert.equal(browsers.length, 2);
      assert.ok(browsers.every((id) => id.startsWith(backend + '.')));
    }
  console.log(
    'PASS: authenticated mock chat -> registry-valid graph -> individually approved successful run; new document draft IDs, truthful mock evidence and all preferred browser fixture rewrites. No live services were contacted.',
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
