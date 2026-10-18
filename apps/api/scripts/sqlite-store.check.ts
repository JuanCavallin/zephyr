import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionState, McpConnection, Run } from '@htn/shared';
import { createSqliteStore } from '../src/store/sqlite.js';

const directory = await mkdtemp(join(tmpdir(), 'agentos-sqlite-check-'));
const path = join(directory, 'store.sqlite');
const at = '2026-09-20T00:00:00.000Z';

try {
  let store = createSqliteStore(path);
  await store.hydrate();

  const run: Run = {
    id: 'run_sqlite_check',
    kind: 'agent',
    title: 'SQLite check',
    status: 'pending',
    input: { goal: 'Verify persistence.' },
    createdAt: at,
    updatedAt: at,
  };
  await store.createRun(run);
  await store.patchRun(run.id, { status: 'running' });
  assert.equal((await store.getRun(run.id))?.status, 'running');

  const firstStep = await store.appendStep({
    id: 'step_sqlite_1',
    runId: run.id,
    parentStepId: null,
    kind: 'check',
    label: 'First',
    status: 'running',
  });
  const secondStep = await store.appendStep({
    id: 'step_sqlite_2',
    runId: run.id,
    parentStepId: null,
    kind: 'check',
    label: 'Second',
    status: 'pending',
  });
  assert.deepEqual([firstStep.seq, secondStep.seq], [1, 2]);

  const session: AgentSessionState = {
    id: 'session_sqlite_check',
    runId: run.id,
    stepId: firstStep.id,
    harness: 'hermes',
    harnessSessionId: 'harness_sqlite_check',
    objective: 'Verify persistence.',
    sanitizedObjective: 'Verify persistence.',
    dataLabels: ['public'],
    status: 'running',
    turn: 1,
    contextVersion: 0,
    context: [],
    candidateModelRouteIds: [],
    candidateToolIds: [],
    selectedToolIds: [],
    budget: { stepsRemaining: 1 },
    createdAt: at,
    updatedAt: at,
  };
  await store.createSessionState(session);
  assert.equal(
    (await store.getSessionStateByHarnessSession('harness_sqlite_check'))?.id,
    session.id,
  );

  const connection: McpConnection = {
    id: 'mcp_conn_sqlite_check',
    name: 'Persistence MCP',
    url: 'https://mcp.example.test/',
    transport: 'streamable_http',
    enabled: true,
    headerEnv: { Authorization: 'TEST_MCP_AUTH' },
    status: 'connected',
    toolIds: ['mcp.persistence.search'],
    executableToolIds: ['mcp.persistence.search'],
    createdAt: at,
    updatedAt: at,
  };
  await store.saveMcpConnection(connection);

  const event1 = await store.appendEvent(run.id, { type: 'run.updated', run });
  const event2 = await store.appendEvent(run.id, {
    type: 'log',
    runId: run.id,
    level: 'info',
    message: 'persisted',
    at,
  });
  assert.deepEqual([event1.seq, event2.seq], [1, 2]);

  const remembered = {
    key: 'g|n|CLICK|https://shop.example/p/*|add bag',
    scope: 'g|n',
    origin: 'https://shop.example',
    pathTemplate: '/p/*',
    operation: 'CLICK' as const,
    role: 'button',
    label: 'Add to bag',
    ordinal: 0,
    source: 'human' as const,
    hits: 2,
    misses: 0,
    consecutiveMisses: 0,
    createdAt: at,
    lastSeen: at,
  };
  await store.putTargetMemory(remembered);
  await store.recordSiteBlock('https://www.google.com', 'browser_challenge', at);
  await store.recordSiteBlock('https://www.google.com', 'browser_challenge', at);

  store.close();
  store = createSqliteStore(path);
  await store.hydrate();
  assert.deepEqual(
    await store.getTargetMemory(remembered.key),
    remembered,
    'target memory persists',
  );
  assert.equal((await store.listTargetMemory('g|n')).length, 1);
  assert.equal((await store.listTargetMemory('other')).length, 0);
  assert.equal((await store.listSiteBlocks())[0]?.count, 2, 'site blocks accumulate and persist');
  await store.deleteTargetMemory(remembered.key);
  assert.equal(await store.getTargetMemory(remembered.key), null);

  assert.equal((await store.getRun(run.id))?.status, 'running');
  assert.deepEqual(
    (await store.listSteps(run.id)).map((step) => step.seq),
    [1, 2],
  );
  assert.equal(
    (await store.getMcpConnection(connection.id))?.headerEnv.Authorization,
    'TEST_MCP_AUTH',
  );
  assert.deepEqual(
    (await store.eventsSince(run.id, 0)).map((event) => event.seq),
    [1, 2],
  );

  const third = await store.appendEvent(run.id, {
    type: 'log',
    runId: run.id,
    level: 'info',
    message: 'monotonic after restart',
    at,
  });
  assert.equal(third.seq, 3);
  store.close();

  console.log('PASS: SQLite store persists state and preserves monotonic sequences.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
