import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/app.js';
import { ApprovalRejectedError } from '../src/core/approvalGate.js';
import { createAgentOsMcpServer } from '../src/core/mcp/server.js';
import type { ToolBroker } from '../src/core/tools/broker.js';
import {
  CORE_RUNTIME_STATUS_TOOL_ID,
  CORE_RUNTIME_STATUS_WIRE_NAME,
} from '../src/core/tools/local.js';
import { sessionStateService, store, toolRegistry } from '../src/services/runtime.js';

async function main(): Promise<void> {
  const session = await sessionStateService.create({
    runId: 'mcp_gateway_check',
    stepId: 'mcp_gateway_check_step',
    harness: 'hermes',
    objective: 'Read the current AgentOS runtime status.',
    sanitizedObjective: 'Read the current AgentOS runtime status.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
    candidateToolIds: [CORE_RUNTIME_STATUS_TOOL_ID],
  });
  await sessionStateService.beginTurn(session.id);
  const credentials = sessionStateService.issueGatewayCredentials(session.id);
  await sessionStateService.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_mcp_gateway_check',
    selectedToolVersions: { [CORE_RUNTIME_STATUS_TOOL_ID]: '1' },
  });

  const listener = createApp().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = new URL('http://127.0.0.1:' + address.port + '/mcp');

  try {
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'unauthorized-check', version: '1' },
        },
      }),
    });
    assert.equal(unauthorized.status, 401);

    const client = new Client({ name: 'agentos-mcp-check', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: 'Bearer ' + credentials.mcp } },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const runtimeTool = listed.tools.find((tool) => tool.name === CORE_RUNTIME_STATUS_WIRE_NAME);
      assert.ok(runtimeTool, 'the real local runtime-status tool must be discoverable');
      assert.equal(runtimeTool.annotations?.readOnlyHint, true);

      const result = await client.callTool({
        name: CORE_RUNTIME_STATUS_WIRE_NAME,
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.match(JSON.stringify(result.content), /AgentOS session is running on turn 1/);

      // The same read again, straight away, is answered from the previous
      // result instead of running twice (the lifecycle check below sees ONE
      // execution). Back-to-back identical reads are how an agent loops.
      const repeated = await client.callTool({
        name: CORE_RUNTIME_STATUS_WIRE_NAME,
        arguments: {},
      });
      assert.equal(repeated.isError, undefined);
      assert.match(JSON.stringify(repeated.content), /Repeated call/);
      assert.match(JSON.stringify(repeated.content), /AgentOS session is running on turn 1/);
      assert.deepEqual(
        (await sessionStateService.get(session.id))?.dataLabels,
        ['public'],
        'a repeated public result keeps its trusted public label',
      );

      await sessionStateService.beginTurn(session.id);
      const expired = await client.callTool({
        name: CORE_RUNTIME_STATUS_WIRE_NAME,
        arguments: {},
      });
      assert.equal(expired.isError, true);
      assert.match(JSON.stringify(expired.content), /TOOL_NOT_SELECTED/);
      await sessionStateService.patch(session.id, { toolCeiling: [] });
      await sessionStateService.grantToolExposure(session.id, {
        modelCallId: 'forged-wide-grant',
        selectedToolVersions: { [CORE_RUNTIME_STATUS_TOOL_ID]: '1' },
      });
      assert.equal((await client.listTools()).tools.length, 0);
      const capped = await client.callTool({ name: CORE_RUNTIME_STATUS_WIRE_NAME, arguments: {} });
      assert.equal(capped.isError, true);
      assert.match(JSON.stringify(capped.content), /capability ceiling/);
    } finally {
      await client.close();
    }

    const phases = (await store.eventsSince(session.runId, 0)).flatMap((event) =>
      event.event.type === 'tool.lifecycle' ? [event.event.lifecycle.phase] : [],
    );
    assert.deepEqual(phases, ['proposed', 'policy_decided', 'executing', 'succeeded']);
  } finally {
    listener.close();
    await once(listener, 'close');
  }

  await checkRejectedAction();

  console.log(
    'PASS: authenticated Streamable HTTP MCP discovery and exact-action local execution work.',
  );
}

/**
 * A rejected approval reaches the agent as a plain, trusted TOOL_ACTION_REJECTED
 * result -- not the generic gateway failure, whose untrusted echo tainted the
 * session local_only and shut out every cloud model -- and the same exact
 * action is refused afterwards without asking the person again.
 */
async function checkRejectedAction(): Promise<void> {
  const session = await sessionStateService.create({
    runId: 'mcp_reject_check',
    stepId: 'mcp_reject_check_step',
    harness: 'hermes',
    objective: 'Read the runtime status.',
    sanitizedObjective: 'Read the runtime status.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 1 },
    candidateToolIds: [CORE_RUNTIME_STATUS_TOOL_ID],
  });
  await sessionStateService.beginTurn(session.id);
  let brokerCalls = 0;
  const server = createAgentOsMcpServer({
    registry: toolRegistry,
    sessions: sessionStateService,
    binding: { sessionStateId: session.id, turn: 1 },
    broker: {
      async execute() {
        brokerCalls += 1;
        throw new ApprovalRejectedError('apr_check');
      },
    } as unknown as ToolBroker,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agentos-reject-check', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    const call = () => client.callTool({ name: CORE_RUNTIME_STATUS_WIRE_NAME, arguments: {} });
    const rejected = await call();
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /TOOL_ACTION_REJECTED: The person reviewing/);
    const trusted = (await sessionStateService.get(session.id))?.context.filter(
      (entry) =>
        entry.role === 'tool' && entry.sanitizedSummary?.startsWith('TOOL_ACTION_REJECTED'),
    );
    assert.equal(trusted?.length, 1, 'the rejection is recorded as a trusted public result');

    const again = await call();
    assert.match(JSON.stringify(again.content), /already rejected in this run/);
    assert.equal(brokerCalls, 1, 'a rejected exact action is not sent for approval twice');
  } finally {
    await client.close();
  }
}

await main();
