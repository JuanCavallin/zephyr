import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DecisionAdapter, Json, ToolAction, ToolDescriptor } from '@htn/shared';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { ToolBroker, ToolBrokerError } from '../src/core/tools/broker.js';
import { RunToolApprovalGate, type ToolApprovalGate } from '../src/core/tools/approval.js';
import { registerDocumentTools } from '../src/core/tools/documents.js';
import { createMemoryStore } from '../src/store/memory.js';
import {
  ActionEvidenceStore,
  actionEvidenceStore,
  actionFingerprint,
  buildActionPreview,
  redactPreview,
} from '../src/services/actionEvidence.js';
import { pendingAction, settleApproval } from '../src/core/approvalGate.js';
import { pauseRun, resumeRun, clearPause } from '../src/core/pauseGate.js';
import { create as composio } from '../src/providers/composio/index.js';
import { ComposioToolCatalog } from '../src/providers/composio/register.js';

const root = await mkdtemp(join(tmpdir(), 'agentos-evidence-'));
const store = createMemoryStore();
const bus = new RunBus((id, event) => store.appendEvent(id, event));
const sessions = new SessionStateService(store, bus);
const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
const decisions = new DecisionService({
  id: 'jev',
  mode: 'mock',
  capabilities: ['decision'],
  recommendActionPolicy: async () => ({
    ok: true,
    data: { policy: 'auto', confidence: 1, probabilities: { auto: 1 }, reasonCodes: ['test'] },
    meta: { provider: 'jev', op: 'recommendActionPolicy', mode: 'mock', latencyMs: 0 },
  }),
} as unknown as DecisionAdapter);
registerDocumentTools(registry, executors, { root, mode: 'live' });
let approvals = 0;
let revision: Json | undefined;
const gate: ToolApprovalGate = {
  request: async () => {
    approvals++;
    return {
      approvalId: 'human-' + approvals,
      ...(revision === undefined ? {} : { revisedArguments: revision }),
    };
  },
};
const broker = new ToolBroker(registry, executors, decisions, sessions, bus, {
  approvalGate: gate,
});
const ids = [
  'agentos.document_read',
  'agentos.document_update',
  'agentos.spreadsheet_read',
  'agentos.spreadsheet_update',
];
async function session(runId: string) {
  const at = new Date().toISOString();
  await store.createRun({
    id: runId,
    kind: 'check',
    title: 'Evidence check',
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
  });
  await store.appendStep({
    id: runId + '_step',
    runId,
    parentStepId: null,
    kind: 'tool',
    label: 'Reviewed artifact',
    status: 'running',
    startedAt: at,
  });
  const s = await sessions.create({
    runId,
    stepId: runId + '_step',
    harness: 'graph',
    objective: 'Review a synthetic artifact',
    dataLabels: ['local_only'],
    budget: { stepsRemaining: 20 },
  });
  await sessions.beginTurn(s.id);
  await sessions.grantToolExposure(s.id, {
    modelCallId: 'check',
    selectedToolVersions: Object.fromEntries(ids.map((id) => [id, '1'])),
  });
  return s;
}
const syntheticRuns: string[] = [];
async function syntheticCase(name: string, effect: 'read' | 'write' = 'write') {
  const runId = 'evidence_synthetic_' + name;
  syntheticRuns.push(runId);
  const syntheticStore = createMemoryStore();
  const syntheticBus = new RunBus((id, event) => syntheticStore.appendEvent(id, event));
  const syntheticSessions = new SessionStateService(syntheticStore, syntheticBus);
  const syntheticRegistry = new InMemoryToolRegistry();
  const syntheticExecutors = new InMemoryToolExecutorRegistry();
  const descriptor: ToolDescriptor = {
    id: 'synthetic.' + name,
    version: '1',
    providerId: 'synthetic',
    family: 'document',
    description: 'Offline synthetic metadata check.',
    inputSchemaRef: 'synthetic://schema/' + name,
    transport: 'http',
    baselineEffect: effect,
    reversibility: effect === 'read' ? 'reversible' : 'recoverable',
    requiredScopes: ['synthetic.metadata'],
    allowedDataLabels: ['public', 'private'],
    availability: 'available',
    executorRef: 'synthetic://executor/' + name,
    credentialRef: 'synthetic:account',
    accountRef: 'synthetic:account-a',
    executionMode: 'mock',
    requiresChangeReview: effect === 'write',
  };
  const registration = {
    descriptor,
    inputSchema: {
      type: 'object',
      properties: { resource: { type: 'string' }, content: { type: 'string' } },
      required: ['resource'],
      additionalProperties: false,
    } as Json,
    grantedScopes: ['synthetic.metadata'],
  };
  syntheticRegistry.register(registration);
  const control = {
    gateCalls: 0,
    dispatches: 0,
    onApproval: undefined as ((action: ToolAction) => Promise<Json | void>) | undefined,
    onExecute: undefined as (() => Promise<void>) | undefined,
  };
  syntheticExecutors.register({
    ref: descriptor.executorRef,
    destinationFor: () => 'https://synthetic.invalid/fixed-resource',
    execute: async () => {
      control.dispatches++;
      await control.onExecute?.();
      return {
        output: { status: 'mock_completed' },
        summary: 'Offline synthetic executor completed; no external resource changed.',
        dataLabels: ['public'],
        verified: true,
        evidenceVerified: false,
        executionMode: 'mock',
      };
    },
  });
  const syntheticGate: ToolApprovalGate = {
    request: async ({ action }) => {
      control.gateCalls++;
      const revisedArguments = await control.onApproval?.(action);
      return {
        approvalId: 'synthetic-approval-' + name,
        ...(revisedArguments === undefined ? {} : { revisedArguments }),
      };
    },
  };
  const s = await syntheticSessions.create({
    runId,
    stepId: runId + '_step',
    harness: 'graph',
    objective: 'Verify an offline synthetic action.',
    sanitizedObjective: 'Verify an offline synthetic action.',
    dataLabels: ['public'],
    toolCeiling: [descriptor.id],
    budget: { stepsRemaining: 2 },
  });
  await syntheticSessions.beginTurn(s.id);
  await syntheticSessions.grantToolExposure(s.id, {
    modelCallId: 'synthetic-model-grant',
    selectedToolVersions: { [descriptor.id]: descriptor.version },
  });
  const syntheticBroker = new ToolBroker(
    syntheticRegistry,
    syntheticExecutors,
    decisions,
    syntheticSessions,
    syntheticBus,
    { approvalGate: syntheticGate },
  );
  return {
    descriptor,
    registration,
    registry: syntheticRegistry,
    sessions: syntheticSessions,
    session: s,
    control,
    execute: (forceApproval = false) =>
      syntheticBroker.execute({
        sessionStateId: s.id,
        toolId: descriptor.id,
        arguments: { resource: 'stable-resource', content: 'Synthetic proposal' },
        forceApproval,
      }),
    events: async () =>
      (await syntheticStore.eventsSince(runId, 0)).flatMap(({ event }) =>
        event.type === 'tool.lifecycle' ? [event.lifecycle] : [],
      ),
  };
}
try {
  const s = await session('evidence_live');
  const request = (toolId: string, args: Json) =>
    broker.execute({ sessionStateId: s.id, toolId, arguments: args });
  const body = 'Synthetic local document for independent readback.';
  const created = await request('agentos.document_update', {
    artifactId: 'draft',
    expectedVersion: 'new',
    content: body,
  });
  assert.equal(approvals, 1, 'recoverable edits require exact human review');
  assert.equal(created.authorization.allowed, true);
  assert.equal(
    await readFile(join(root, s.runId, 'draft.md'), 'utf8'),
    body,
    'independent filesystem read proves actual output',
  );
  assert.equal(created.executedPreview, undefined, 'human preview cannot enter model tool result');
  const evidence = actionEvidenceStore.list(s.runId, created.action.id);
  assert.equal(evidence.at(-1)?.evidenceLevel, 'readback_verified');
  assert.equal(evidence.at(-1)?.executionMode, 'live');
  assert.equal(actionEvidenceStore.preview('other-run', evidence[0]!.previewRef!), null);
  const rawTrace = JSON.stringify(await store.eventsSince(s.runId, 0));
  assert.ok(!rawTrace.includes(body), 'document content stays out of persisted lifecycle/SSE');
  const firstVersion = (created.output as Record<string, Json>).version;
  revision = {
    artifactId: 'draft',
    expectedVersion: firstVersion,
    content: 'Human revised this draft.',
  };
  const edited = await request('agentos.document_update', {
    artifactId: 'draft',
    expectedVersion: firstVersion,
    content: 'Agent suggested this draft.',
  });
  assert.equal(
    await readFile(join(root, s.runId, 'draft.md'), 'utf8'),
    'Human revised this draft.',
  );
  const actual = actionEvidenceStore.preview(
    s.runId,
    actionEvidenceStore.list(s.runId, edited.action.id).at(-1)!.previewRef!,
  );
  assert.equal(actual?.changes?.[0]?.before, body);
  assert.equal(actual?.changes?.[0]?.after, 'Human revised this draft.');
  const revisionHistory = actionEvidenceStore.list(s.runId, edited.action.id);
  const proposals = revisionHistory.filter((record) => record.phase === 'proposed');
  assert.equal(
    proposals.length,
    2,
    'the original and human revision each retain an evidence proposal',
  );
  assert.equal(
    new Set(revisionHistory.map((record) => record.resourceRef)).size,
    1,
    'proposal revision and execution retain one stable resource reference',
  );
  assert.notEqual(
    proposals[0]!.fingerprint,
    proposals[1]!.fingerprint,
    'human revision binds a new exact payload',
  );
  assert.notEqual(
    proposals[0]!.previewRef,
    proposals[1]!.previewRef,
    'revision does not overwrite the prior review preview',
  );
  revision = undefined;
  await assert.rejects(
    request('agentos.document_update', {
      artifactId: 'draft',
      expectedVersion: firstVersion,
      content: 'Stale edit',
    }),
    /RESOURCE_CONFLICT/,
  );
  assert.equal(
    await readFile(join(root, s.runId, 'draft.md'), 'utf8'),
    'Human revised this draft.',
  );
  revision = { artifactId: 'different', expectedVersion: 'new', content: 'Retarget' };
  await assert.rejects(
    request('agentos.document_update', {
      artifactId: 'other',
      expectedVersion: 'new',
      content: 'Original',
    }),
    /reviewed target/,
  );
  revision = undefined;
  const grid = await request('agentos.spreadsheet_update', {
    artifactId: 'grid',
    expectedVersion: 'new',
    values: [
      ['Product', 'Quantity'],
      ['Synthetic', 2],
    ],
  });
  assert.deepEqual(JSON.parse(await readFile(join(root, s.runId, 'grid.json'), 'utf8')), [
    ['Product', 'Quantity'],
    ['Synthetic', 2],
  ]);
  assert.equal(
    actionEvidenceStore.list(s.runId, grid.action.id).at(-1)?.evidenceLevel,
    'readback_verified',
  );
  const race = await Promise.allSettled([
    request('agentos.document_update', {
      artifactId: 'racing',
      expectedVersion: 'new',
      content: 'First',
    }),
    request('agentos.document_update', {
      artifactId: 'racing',
      expectedVersion: 'new',
      content: 'Second',
    }),
  ]);
  assert.equal(
    race.filter((r) => r.status === 'fulfilled').length,
    1,
    'version check under mutation lock prevents concurrent overwrite',
  );
  const concrete = new ToolBroker(registry, executors, decisions, sessions, bus, {
    approvalGate: new RunToolApprovalGate(store, bus, sessions),
  });
  const pending = concrete.execute({
    sessionStateId: s.id,
    toolId: 'agentos.document_update',
    arguments: { artifactId: 'rejected', expectedVersion: 'new', content: 'Never committed' },
  });
  const captured = pending.catch((error) => error);
  let approval = (await store.listApprovals(s.runId)).find((a) => a.status === 'pending');
  for (let i = 0; !approval && i < 30; i++) {
    await new Promise<void>((r) => setImmediate(r));
    approval = (await store.listApprovals(s.runId)).find((a) => a.status === 'pending');
  }
  assert.ok(approval);
  assert.ok(
    !JSON.stringify(approval).includes('Never committed'),
    'approval persistence contains metadata only',
  );
  assert.ok(pendingAction(approval.id));
  settleApproval(approval.id, { verdict: 'rejected', action: pendingAction(approval.id)! });
  assert.match(String(await captured), /rejected/);
  await assert.rejects(readFile(join(root, s.runId, 'rejected.md')), /ENOENT/);
  pauseRun(s.runId);
  const stopped = request('agentos.document_read', { artifactId: 'draft' }).catch((e) => e);
  await new Promise<void>((r) => setImmediate(r));
  await sessions.beginTurn(s.id);
  resumeRun(s.runId);
  assert.match(
    String(await stopped),
    /exposure grant|no longer active|not selected/i,
    'paused old turn cannot dispatch after turn changes',
  );

  const descriptor = (await registry.get('agentos.document_update'))!.descriptor;
  const huge: ToolAction = { ...created.action, arguments: { content: '界'.repeat(100_000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(buildActionPreview(huge, descriptor))) <= 64_000);
  assert.deepEqual(
    redactPreview({ api_key: 'hidden', nested: { access_token: 'hidden' }, content: 'shown' }),
    { api_key: '[redacted]', nested: { access_token: '[redacted]' }, content: 'shown' },
  );
  assert.notEqual(
    actionFingerprint(created.action),
    actionFingerprint({ ...created.action, destination: 'different' }),
  );
  const bounded = new ActionEvidenceStore();
  for (let i = 0; i < 505; i++) bounded.proposed({ ...created.action, id: 'a' + i }, descriptor);
  assert.equal(bounded.list(created.action.runId, 'a0').length, 0);

  const forced = await syntheticCase('forced_read', 'read');
  const forcedResult = await forced.execute(true);
  assert.equal(
    forced.control.gateCalls,
    1,
    'forced approval gates an otherwise auto-authorized read exactly once',
  );
  assert.equal(
    forced.control.dispatches,
    1,
    'the forced read dispatches exactly once after approval',
  );
  assert.equal(forcedResult.authorization.allowed, true);
  const forcedEvents = await forced.events();
  assert.equal(
    forcedEvents.find((event) => event.phase === 'policy_decided')?.authorization?.finalPolicy,
    'ask_user',
  );
  assert.equal(forcedEvents.filter((event) => event.phase === 'awaiting_approval').length, 1);
  assert.ok(
    forcedEvents.findIndex((event) => event.phase === 'approved') <
      forcedEvents.findIndex((event) => event.phase === 'executing'),
    'approval precedes dispatch',
  );

  const failedWrite = await syntheticCase('ambiguous_remote_write');
  failedWrite.control.onExecute = async () => {
    throw new Error('Synthetic connection lost after dispatch.');
  };
  await assert.rejects(
    failedWrite.execute(),
    (error: unknown) => error instanceof ToolBrokerError && error.code === 'TOOL_EXECUTION_UNKNOWN',
  );
  const failureEvents = await failedWrite.events();
  assert.equal(failureEvents.find((event) => event.phase === 'failed')?.outcome, 'unknown');
  assert.equal(
    failedWrite.control.dispatches,
    1,
    'ambiguous remote failure never blindly retries a write',
  );
  assert.equal(failedWrite.control.gateCalls, 1);
  assert.equal(failureEvents.filter((event) => event.phase === 'executing').length, 1);
  assert.equal(
    failureEvents.some((event) => event.phase === 'succeeded'),
    false,
    'unknown outcome cannot be displayed as a successful write',
  );

  for (const revocation of ['availability', 'scopes'] as const) {
    const revoked = await syntheticCase('revoked_' + revocation);
    revoked.control.onApproval = async () => {
      revoked.registry.register({
        ...revoked.registration,
        ...(revocation === 'availability'
          ? { descriptor: { ...revoked.descriptor, availability: 'unavailable' as const } }
          : { grantedScopes: [] }),
      });
    };
    await assert.rejects(revoked.execute(), /unavailable|missing required scopes/);
    assert.equal(revoked.control.gateCalls, 1);
    assert.equal(
      revoked.control.dispatches,
      0,
      'a connection revoked during review never dispatches',
    );
    assert.equal(
      (await revoked.events()).find((event) => event.phase === 'failed')?.outcome,
      'not_executed',
    );
  }

  const tightened = await syntheticCase('tightened_labels');
  tightened.control.onApproval = async () => {
    await tightened.sessions.patch(tightened.session.id, { dataLabels: ['public', 'private'] });
  };
  await assert.rejects(tightened.execute(), /privacy tightened/);
  assert.equal(
    tightened.control.dispatches,
    0,
    'review cannot authorize state whose privacy labels later tightened',
  );
  assert.equal(
    (await tightened.events()).find((event) => event.phase === 'failed')?.outcome,
    'not_executed',
  );

  const changedAccount = await syntheticCase('changed_account');
  changedAccount.control.onApproval = async (action) => {
    assert.equal(
      action.accountRef,
      changedAccount.descriptor.accountRef,
      'the reviewed account comes from the trusted descriptor',
    );
    assert.notEqual(
      actionFingerprint(action),
      actionFingerprint({ ...action, accountRef: 'synthetic:account-b' }),
      'the exact-action fingerprint binds the connected account',
    );
    // Replace an externally refreshed descriptor while keeping schema version
    // and executor fixed; this isolates the broker's account binding check.
    assert.equal(changedAccount.registry.unregister(changedAccount.descriptor.id), true);
    changedAccount.registry.register({
      ...changedAccount.registration,
      descriptor: { ...changedAccount.descriptor, accountRef: 'synthetic:account-b' },
    });
  };
  await assert.rejects(changedAccount.execute(), /descriptor changed after review/);
  assert.equal(changedAccount.control.gateCalls, 1);
  assert.equal(
    changedAccount.control.dispatches,
    0,
    'a reviewed action cannot dispatch after the connected account changes',
  );
  const accountEvents = await changedAccount.events();
  assert.equal(
    accountEvents.find((event) => event.phase === 'proposed')?.action.accountRef,
    changedAccount.descriptor.accountRef,
  );
  assert.equal(accountEvents.find((event) => event.phase === 'failed')?.outcome, 'not_executed');
  assert.equal(
    (await changedAccount.registry.get(changedAccount.descriptor.id))?.descriptor.accountRef,
    'synthetic:account-b',
  );

  const changedTurn = await syntheticCase('changed_turn');
  changedTurn.control.onApproval = async () => {
    await changedTurn.sessions.beginTurn(changedTurn.session.id);
  };
  await assert.rejects(changedTurn.execute(), /no longer active/);
  assert.equal(changedTurn.control.gateCalls, 1);
  assert.equal(
    changedTurn.control.dispatches,
    0,
    'review of a retired turn cannot dispatch in the next turn',
  );

  const mockRegistry = new InMemoryToolRegistry();
  const mockExecutors = new InMemoryToolExecutorRegistry();
  const cfg = { mode: 'mock' as const, keyVar: 'COMPOSIO_API_KEY' };
  await new ComposioToolCatalog(
    composio(cfg),
    cfg,
    mockRegistry,
    mockExecutors,
  ).bootstrapReviewed();
  for (const id of [
    'mail.send',
    'microsoft_word.update_document',
    'microsoft_excel.update_range',
  ]) {
    const tool = await mockRegistry.get(id);
    assert.ok(tool);
    assert.equal(tool.descriptor.executionMode, 'mock');
    assert.equal(tool.descriptor.requiresChangeReview, true);
  }
  const mockDoc = (await mockRegistry.get('microsoft_word.update_document'))!;
  const simulated = await mockExecutors.resolve(mockDoc.descriptor.executorRef)!.execute(
    {
      ...created.action,
      toolId: mockDoc.descriptor.id,
      arguments: { document_id: 'synthetic', expectedVersion: '1', content: 'Mock only' },
    },
    { runId: s.runId, policyRule: 'mock-executor-protocol-check' },
  );
  assert.equal(simulated.executionMode, 'mock');
  assert.equal(simulated.evidenceVerified, false);
  assert.ok(!JSON.stringify(simulated.output).includes('Mock only'));
  console.log(
    'PASS: reviewed local document/grid writes, independent readback, privacy, rejection, stable revision evidence, conflict, pause, forced read approval, unknown write outcomes without retry, review-time permission/account revocation, bounded evidence, and Composio mocks.',
  );
} finally {
  clearPause('evidence_live');
  actionEvidenceStore.clearRun('evidence_live');
  for (const runId of syntheticRuns) actionEvidenceStore.clearRun(runId);
  const absolute = resolve(root);
  if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('agentos-evidence-'))
    throw new Error('Unsafe temporary cleanup path.');
  await rm(absolute, { recursive: true, force: true });
}
