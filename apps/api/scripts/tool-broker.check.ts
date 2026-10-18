import assert from 'node:assert/strict';
import type {
  ActionPolicyRecommendation,
  DecisionAdapter,
  Json,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';
import { RunBus } from '../src/core/bus.js';
import { settleApproval } from '../src/core/approvalGate.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { RunToolApprovalGate, type ToolApprovalGate } from '../src/core/tools/approval.js';
import { ToolBroker, ToolBrokerError } from '../src/core/tools/broker.js';
import { InMemoryToolExecutorRegistry, type ToolExecutor } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { createMemoryStore } from '../src/store/memory.js';

const store = createMemoryStore();
const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
const sessions = new SessionStateService(store, bus);

const AUTO_RECOMMENDATION: ActionPolicyRecommendation = {
  policy: 'auto',
  confidence: 0.99,
  probabilities: { auto: 0.99 },
  reasonCodes: ['check-recommends-auto'],
};

let policyCalls = 0;
const decisionAdapter = {
  id: 'jev',
  mode: 'mock',
  capabilities: ['decision'],
  async recommendActionPolicy() {
    policyCalls += 1;
    return {
      ok: true,
      data: AUTO_RECOMMENDATION,
      meta: {
        provider: 'jev',
        op: 'recommendActionPolicy',
        mode: 'mock',
        latencyMs: 0,
        destination: 'mock://jev',
      },
    } as const;
  },
} as unknown as DecisionAdapter;

const decisions = new DecisionService(decisionAdapter);
const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();

const MAIL_SEND: ToolDescriptor = {
  id: 'mail.send',
  version: '2026-09-20',
  providerId: 'check',
  family: 'mail',
  description: 'Send one email to one exact recipient.',
  inputSchemaRef: 'agentos://schemas/mail.send/2026-09-20',
  transport: 'mcp',
  baselineEffect: 'write',
  reversibility: 'irreversible',
  requiredScopes: ['mail.send'],
  allowedDataLabels: ['public', 'private', 'secret'],
  availability: 'available',
  executorRef: 'check://mail.send',
};

const SIMULATED_SEND: ToolDescriptor = {
  ...MAIL_SEND,
  id: 'mail.simulated_send',
  inputSchemaRef: 'agentos://schemas/mail.simulated_send/1',
  executorRef: 'check://mail.simulated_send',
  version: '1',
  simulated: true,
};

const DISCONNECTED_SEND: ToolDescriptor = {
  ...MAIL_SEND,
  id: 'mail.disconnected_send',
  inputSchemaRef: 'agentos://schemas/mail.disconnected_send/1',
  executorRef: 'check://mail.send',
  version: '1',
};

const MAIL_SCHEMA: Json = {
  type: 'object',
  properties: {
    to: { type: 'string', minLength: 3 },
    subject: { type: 'string', minLength: 1 },
    body: { type: 'string', minLength: 1 },
  },
  required: ['to', 'subject', 'body'],
  additionalProperties: false,
};

registry.register({
  descriptor: MAIL_SEND,
  inputSchema: MAIL_SCHEMA,
  grantedScopes: ['mail.send'],
});
registry.register({ descriptor: SIMULATED_SEND, inputSchema: MAIL_SCHEMA });
registry.register({ descriptor: DISCONNECTED_SEND, inputSchema: MAIL_SCHEMA });
assert.throws(
  () =>
    registry.register({
      descriptor: MAIL_SEND,
      inputSchema: { type: 'object', additionalProperties: true },
      grantedScopes: ['mail.send'],
    }),
  /without a version bump/,
);

let executionCount = 0;
let lastAction: ToolAction | undefined;
const mailExecutor: ToolExecutor = {
  ref: 'check://mail.send',
  destinationFor({ arguments: args }) {
    return isRecord(args) && typeof args.to === 'string' ? 'mailto:' + args.to : undefined;
  },
  async execute(action) {
    executionCount += 1;
    lastAction = action;
    return {
      output: { messageId: 'msg_check_1', status: 'sent' },
      summary: 'Email sent and provider returned message id msg_check_1.',
      sanitizedSummary: 'Email sent and provider returned message id msg_check_1.',
      dataLabels: ['public'],
    };
  },
};
executors.register(mailExecutor);
executors.register({
  ...mailExecutor,
  ref: 'check://mail.simulated_send',
});

const approvals: ToolAction[] = [];
const approvalGate: ToolApprovalGate = {
  async request({ action }) {
    approvals.push(action);
    return { approvalId: 'apr_check_1' };
  },
};

const broker = new ToolBroker(registry, executors, decisions, sessions, bus, { approvalGate });

async function expectBrokerError(
  operation: () => Promise<unknown>,
  code: ToolBrokerError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ToolBrokerError);
    assert.equal(error.code, code);
    return true;
  });
}

async function createSession(
  runId: string,
  labels: ('public' | 'private' | 'secret' | 'local_only')[] = ['public'],
) {
  const state = await sessions.create({
    runId,
    stepId: runId + '_step',
    harness: 'hermes',
    objective: 'Send an email after approval.',
    sanitizedObjective: labels.every((label) => label === 'public')
      ? 'Send an email after approval.'
      : undefined,
    dataLabels: labels,
    budget: { stepsRemaining: 2 },
  });
  await sessions.beginTurn(state.id);
  return state;
}

async function main(): Promise<void> {
  const session = await createSession('tool_broker_check');
  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_tool_broker_check',
    selectedToolVersions: { [MAIL_SEND.id]: MAIL_SEND.version },
  });

  const args: Json = {
    to: 'alex@example.com',
    subject: 'AgentOS check',
    body: 'This is an exact-action approval check.',
  };
  const result = await broker.execute({
    sessionStateId: session.id,
    toolId: MAIL_SEND.id,
    arguments: args,
  });

  assert.equal(result.authorization.finalPolicy, 'ask_user');
  assert.equal(result.approvalId, 'apr_check_1');
  assert.equal(executionCount, 1);
  assert.equal(approvals.length, 1);
  assert.equal(lastAction?.destination, 'mailto:alex@example.com');
  assert.deepEqual(lastAction?.arguments, args);

  const phases = (await store.eventsSince(session.runId, 0)).flatMap((stored) =>
    stored.event.type === 'tool.lifecycle' ? [stored.event.lifecycle.phase] : [],
  );
  assert.deepEqual(phases, [
    'proposed',
    'policy_decided',
    'awaiting_approval',
    'approved',
    'executing',
    'succeeded',
  ]);

  await expectBrokerError(
    () =>
      broker.execute({
        sessionStateId: session.id,
        toolId: MAIL_SEND.id,
        arguments: { to: 'alex@example.com' },
      }),
    'TOOL_ARGUMENTS_INVALID',
  );
  assert.equal(executionCount, 1, 'invalid arguments must never reach the executor');

  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_empty_grant',
    selectedToolVersions: {},
  });
  await expectBrokerError(
    () => broker.execute({ sessionStateId: session.id, toolId: MAIL_SEND.id, arguments: args }),
    'TOOL_NOT_SELECTED',
  );

  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_old_version',
    selectedToolVersions: { [MAIL_SEND.id]: 'older-version' },
  });
  await expectBrokerError(
    () => broker.execute({ sessionStateId: session.id, toolId: MAIL_SEND.id, arguments: args }),
    'TOOL_VERSION_CHANGED',
  );

  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_simulated',
    selectedToolVersions: { [SIMULATED_SEND.id]: SIMULATED_SEND.version },
  });
  await expectBrokerError(
    () =>
      broker.execute({ sessionStateId: session.id, toolId: SIMULATED_SEND.id, arguments: args }),
    'TOOL_UNAVAILABLE',
  );

  const disconnected = await registry.resolve([DISCONNECTED_SEND.id]);
  assert.equal(disconnected[0]?.availability, 'requires_connection');
  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_disconnected',
    selectedToolVersions: { [DISCONNECTED_SEND.id]: DISCONNECTED_SEND.version },
  });
  await expectBrokerError(
    () =>
      broker.execute({
        sessionStateId: session.id,
        toolId: DISCONNECTED_SEND.id,
        arguments: args,
      }),
    'TOOL_SCOPE_MISSING',
  );

  const secretSession = await createSession('tool_broker_secret_check', ['secret']);
  await sessions.grantToolExposure(secretSession.id, {
    modelCallId: 'chatcmpl_secret',
    selectedToolVersions: { [MAIL_SEND.id]: MAIL_SEND.version },
  });
  await expectBrokerError(
    () =>
      broker.execute({
        sessionStateId: secretSession.id,
        toolId: MAIL_SEND.id,
        arguments: args,
      }),
    'TOOL_ACTION_DENIED',
  );
  assert.equal(executionCount, 1, 'secret remote action must never reach the executor');

  await checkConcreteApprovalGate(args);
  await checkJevPolicyRoundTrips();

  console.log(
    'PASS: tool broker enforces trusted selection, pinned versions, schemas, privacy, approval, and exact-action execution.',
  );
}

/** Jev is asked only where it can change the outcome, and at most once per action. */
async function checkJevPolicyRoundTrips(): Promise<void> {
  const READ: ToolDescriptor = {
    ...MAIL_SEND,
    id: 'page.read',
    version: '1',
    family: 'browser',
    description: 'Read one public page.',
    inputSchemaRef: 'agentos://schemas/page.read/1',
    baselineEffect: 'read',
    reversibility: 'reversible',
    requiredScopes: [],
    executorRef: 'check://page.read',
  };
  const CLICK: ToolDescriptor = {
    ...READ,
    id: 'page.click',
    description: 'Click one element.',
    inputSchemaRef: 'agentos://schemas/page.click/1',
    baselineEffect: 'write',
    reversibility: 'recoverable',
    executorRef: 'check://page.click',
  };
  const schema: Json = { type: 'object', properties: {}, additionalProperties: false };
  registry.register({ descriptor: READ, inputSchema: schema });
  registry.register({ descriptor: CLICK, inputSchema: schema });
  const done = {
    output: { ok: true },
    summary: 'done',
    sanitizedSummary: 'done',
    dataLabels: ['public' as const],
    verified: true,
  };
  let prepared = 0;
  executors.register({
    ref: READ.executorRef,
    destinationFor: () => 'https://example.com',
    execute: async () => done,
  });
  executors.register({
    ref: CLICK.executorRef,
    destinationFor: () => 'https://example.com',
    async prepareReview() {
      prepared += 1;
      return { review: { kind: 'browser_target', index: 1 }, requiresApproval: false };
    },
    execute: async () => done,
  });
  const session = await createSession('tool_broker_policy_calls');
  await sessions.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_policy_calls',
    selectedToolVersions: { [READ.id]: READ.version, [CLICK.id]: CLICK.version },
  });

  const beforeRead = policyCalls;
  const read = await broker.execute({ sessionStateId: session.id, toolId: READ.id, arguments: {} });
  assert.equal(read.authorization.finalPolicy, 'auto');
  assert.equal(policyCalls, beforeRead, 'a public reversible read needs no Jev policy call');

  const beforeClick = policyCalls;
  const click = await broker.execute({
    sessionStateId: session.id,
    toolId: CLICK.id,
    arguments: {},
  });
  assert.equal(prepared, 1);
  assert.ok(click.authorization.allowed);
  assert.equal(policyCalls - beforeClick, 1, 'a prepared action is authorized by Jev exactly once');
}

async function checkConcreteApprovalGate(args: Json): Promise<void> {
  const approvalStore = createMemoryStore();
  const approvalBus = new RunBus((runId, event) => approvalStore.appendEvent(runId, event));
  const approvalSessions = new SessionStateService(approvalStore, approvalBus);
  const runId = 'tool_approval_gate_check';
  const stepId = runId + '_step';
  const at = new Date().toISOString();
  await approvalStore.createRun({
    id: runId,
    kind: 'check',
    title: 'Tool approval gate check',
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
  });
  await approvalStore.appendStep({
    id: stepId,
    runId,
    parentStepId: null,
    kind: 'agent_task',
    label: 'Run exact tool action',
    status: 'running',
    startedAt: at,
  });
  const state = await approvalSessions.create({
    runId,
    stepId,
    harness: 'hermes',
    objective: 'Send an email after approval.',
    sanitizedObjective: 'Send an email after approval.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 1 },
  });
  await approvalSessions.beginTurn(state.id);
  await approvalSessions.grantToolExposure(state.id, {
    modelCallId: 'chatcmpl_concrete_approval',
    selectedToolVersions: { [MAIL_SEND.id]: MAIL_SEND.version },
  });

  const concreteGate = new RunToolApprovalGate(approvalStore, approvalBus, approvalSessions);
  const approvalBroker = new ToolBroker(
    registry,
    executors,
    decisions,
    approvalSessions,
    approvalBus,
    { approvalGate: concreteGate },
  );
  const pendingExecution = approvalBroker.execute({
    sessionStateId: state.id,
    toolId: MAIL_SEND.id,
    arguments: args,
  });

  let pending = (await approvalStore.listApprovals(runId)).find(
    (approval) => approval.status === 'pending',
  );
  for (let attempt = 0; !pending && attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending = (await approvalStore.listApprovals(runId)).find(
      (approval) => approval.status === 'pending',
    );
  }
  assert.ok(pending, 'broker must persist an approval before waiting');
  assert.equal((await approvalStore.getRun(runId))?.status, 'awaiting_approval');
  assert.equal((await approvalStore.getStep(stepId))?.status, 'blocked');
  assert.deepEqual(
    isRecord(pending.proposedAction) ? pending.proposedAction.arguments : undefined,
    args,
  );

  const approved = await approvalStore.patchApproval(pending.id, {
    status: 'approved',
    decidedAt: new Date().toISOString(),
  });
  await approvalBus.emit(runId, { type: 'approval.resolved', approval: approved });
  assert.equal(
    settleApproval(pending.id, {
      verdict: 'approved',
      action: { kind: 'tool:' + MAIL_SEND.id, description: pending.question },
    }),
    true,
  );
  const completed = await pendingExecution;

  assert.equal(completed.approvalId, pending.id);
  assert.equal((await approvalStore.getRun(runId))?.status, 'running');
  assert.equal((await approvalStore.getStep(stepId))?.status, 'running');
  assert.equal((await approvalSessions.get(state.id))?.status, 'running');
}

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

await main();
