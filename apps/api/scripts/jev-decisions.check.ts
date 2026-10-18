import assert from 'node:assert/strict';
import type {
  DecisionAdapter,
  DecisionState,
  ModelRoute,
  ProviderCallContext,
  SessionCheckpoint,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';
import { DecisionService } from '../src/core/decisions/service.js';
import { eligibleModelRoutes } from '../src/core/decisions/eligibility.js';
import { decisionStateFromSession } from '../src/core/sessions/decisionState.js';
import { create } from '../src/providers/jev/index.js';

const ctx: ProviderCallContext = {
  runId: 'decision_check',
  stepId: 'decision_check_step',
  policyRule: 'synthetic-decision-check',
};

const mock = create({ mode: 'mock', keyVar: 'JEV_API_KEY' });
const service = new DecisionService(mock, {
  minimumConfidence: 0.7,
  maximumTools: 3,
  now: () => '2026-01-01T00:00:00.000Z',
});

const publicState: DecisionState = {
  taskSummary: 'Search public company websites and summarize the findings.',
  contextSummary: 'Use public sources only.',
  dataLabels: ['public'],
  sanitizedForRemote: true,
};

/** Test-only candidates. The tool-registry team owns the production catalog. */
const MODEL_ROUTE_FIXTURES: ModelRoute[] = [
  {
    id: 'cloud-cheap',
    providerId: 'test-cloud',
    modelId: 'test/cheap',
    costTier: 'cheap',
    deployment: 'cloud',
    contextScope: 'public',
    supportsTools: true,
    allowedDataLabels: ['public'],
    enabled: true,
  },
  {
    id: 'local-private',
    providerId: 'test-local',
    modelId: 'test/local',
    costTier: 'standard',
    deployment: 'local',
    contextScope: 'local_only',
    supportsTools: true,
    allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
    enabled: true,
  },
];

const TOOL_DESCRIPTOR_FIXTURES: ToolDescriptor[] = [
  {
    id: 'browser.search',
    version: '1',
    providerId: 'test-tools',
    family: 'browser',
    description: 'Search public pages.',
    inputSchemaRef: 'test://browser.search',
    transport: 'fixture',
    baselineEffect: 'read',
    reversibility: 'reversible',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: 'available',
    executorRef: 'test://browser.search',
    simulated: true,
  },
  {
    id: 'mail.send',
    version: '1',
    providerId: 'test-tools',
    family: 'mail',
    description: 'Send an external message.',
    inputSchemaRef: 'test://mail.send',
    transport: 'fixture',
    baselineEffect: 'write',
    reversibility: 'irreversible',
    requiredScopes: ['mail.send'],
    allowedDataLabels: ['public'],
    availability: 'available',
    executorRef: 'test://mail.send',
    simulated: true,
  },
  {
    id: 'vendor.unclassified',
    version: '1',
    providerId: 'test-tools',
    family: 'unknown',
    description: 'Unclassified test operation.',
    inputSchemaRef: 'test://unknown',
    transport: 'fixture',
    baselineEffect: 'unknown',
    reversibility: 'irreversible',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: 'available',
    executorRef: 'test://unknown',
    simulated: true,
  },
];

function checkpoint(patch: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
  return {
    runId: 'decision_check',
    objective: 'Prepare a verified public company brief.',
    sanitizedObjective: 'Prepare a verified public company brief.',
    steps: [
      {
        id: 'research',
        label: 'Research company',
        status: 'succeeded',
        required: true,
        sanitizedSummary: 'Public research completed.',
      },
    ],
    artifacts: [
      {
        id: 'brief',
        kind: 'report',
        required: true,
        verified: true,
        dataLabels: ['public'],
        sanitizedSummary: 'Verified brief created.',
      },
    ],
    verifications: [{ id: 'brief-schema', passed: true, required: true, reasonCode: 'valid' }],
    outstandingRequirements: [],
    pendingApprovalIds: [],
    dataLabels: ['public'],
    budget: { stepsRemaining: 3 },
    at: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function action(toolId: string): ToolAction {
  return {
    id: `action_${toolId}`,
    runId: 'decision_check',
    stepId: 'decision_check_step',
    toolId,
    descriptorVersion: '1',
    operation: toolId,
    arguments: {},
    destination: 'https://example.test',
    dataLabels: ['public'],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function main(): Promise<void> {
  const sanitizedPrivateState = decisionStateFromSession({
    id: 'private_session',
    runId: 'private_run',
    stepId: 'private_step',
    harness: 'hermes',
    objective: 'Email private.person@example.test.',
    sanitizedObjective: 'Email [[PII_1]].',
    dataLabels: ['private'],
    status: 'running',
    turn: 1,
    contextVersion: 1,
    context: [
      {
        id: 'private_context',
        role: 'user',
        summary: 'Email private.person@example.test.',
        sanitizedSummary: 'Email [[PII_1]].',
        dataLabels: ['private'],
        tokenEstimate: 8,
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
    candidateModelRouteIds: [],
    candidateToolIds: [],
    selectedToolIds: [],
    selectedToolVersions: {},
    budget: { stepsRemaining: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(sanitizedPrivateState.sanitizedForRemote, true);
  assert.equal(sanitizedPrivateState.taskSummary, 'Email [[PII_1]].');
  assert.equal(sanitizedPrivateState.contextSummary, 'Email [[PII_1]].');
  assert.deepEqual(sanitizedPrivateState.dataLabels, ['private']);

  const model = await service.selectModel(publicState, MODEL_ROUTE_FIXTURES, ctx);
  assert.ok(MODEL_ROUTE_FIXTURES.some((candidate) => candidate.id === model.selectedRouteId));

  const tools = await service.selectTools(publicState, TOOL_DESCRIPTOR_FIXTURES, ctx);
  assert.ok(tools.selectedToolIds.length <= 3);
  assert.ok(tools.selectedToolIds.every((id) => id !== 'vendor.unclassified'));
  assert.ok(
    tools.selectedToolIds.every((id) =>
      TOOL_DESCRIPTOR_FIXTURES.some((descriptor) => descriptor.id === id),
    ),
  );

  let remoteCalls = 0;
  const liveSpy: DecisionAdapter = {
    ...mock,
    mode: 'live',
    async selectModel() {
      remoteCalls += 1;
      throw new Error('Remote Jev must not receive local-only state.');
    },
    async selectTools() {
      remoteCalls += 1;
      throw new Error('Remote Jev must not receive local-only state.');
    },
  };
  const privateService = new DecisionService(liveSpy);
  const localState: DecisionState = {
    taskSummary: 'Sensitive contents must remain local.',
    dataLabels: ['local_only'],
    sanitizedForRemote: false,
  };
  const localModel = await privateService.selectModel(localState, MODEL_ROUTE_FIXTURES, ctx);
  assert.equal(
    MODEL_ROUTE_FIXTURES.find((candidate) => candidate.id === localModel.selectedRouteId)
      ?.deployment,
    'local',
  );
  const localTools = await privateService.selectTools(localState, TOOL_DESCRIPTOR_FIXTURES, ctx);
  assert.deepEqual(localTools.selectedToolIds, []);
  assert.equal(remoteCalls, 0);

  const inventedAdapter: DecisionAdapter = {
    ...mock,
    async selectTools(_input, callContext) {
      return {
        ok: true,
        data: {
          selectedToolIds: ['browser.search', 'invented.root_access'],
          confidences: { 'browser.search': 0.9, 'invented.root_access': 0.99 },
          reasonCodes: ['synthetic-hostile-result'],
        },
        meta: {
          provider: 'jev',
          op: 'select_tools',
          mode: 'mock',
          latencyMs: 0,
          destination: 'mock://jev',
        },
      };
    },
  };
  const bounded = await new DecisionService(inventedAdapter).selectTools(
    publicState,
    TOOL_DESCRIPTOR_FIXTURES,
    ctx,
  );
  assert.deepEqual(bounded.selectedToolIds, ['browser.search']);
  assert.ok(bounded.reasonCodes.includes('removed-ineligible-tool'));

  const unknownDescriptor = TOOL_DESCRIPTOR_FIXTURES.find(
    (descriptor) => descriptor.id === 'vendor.unclassified',
  );
  assert.ok(unknownDescriptor);
  const unknownAuthorization = await service.authorizeAction(
    publicState,
    action(unknownDescriptor.id),
    unknownDescriptor,
    ctx,
  );
  assert.equal(unknownAuthorization.finalPolicy, 'deny');
  assert.equal(unknownAuthorization.allowed, false);

  const mailDescriptor = TOOL_DESCRIPTOR_FIXTURES.find(
    (descriptor) => descriptor.id === 'mail.send',
  );
  assert.ok(mailDescriptor);
  const mailAuthorization = await service.authorizeAction(
    publicState,
    action(mailDescriptor.id),
    { ...mailDescriptor, simulated: false, transport: 'mcp', executorRef: 'mcp://mail.send' },
    ctx,
  );
  assert.equal(mailAuthorization.finalPolicy, 'ask_user');
  assert.equal(mailAuthorization.allowed, false);

  const alwaysDoneAdapter: DecisionAdapter = {
    ...mock,
    async judgeCompletion() {
      return {
        ok: true,
        data: {
          status: 'done',
          confidence: 0.99,
          probabilities: { done: 0.99 },
          reasonCodes: ['synthetic-always-done'],
        },
        meta: {
          provider: 'jev',
          op: 'judge_completion',
          mode: 'mock',
          latencyMs: 0,
          destination: 'mock://jev',
        },
      };
    },
  };
  // Jev's verdict is never rewritten: a failed deterministic check is reported
  // beside it (verified: false), it does not turn `done` into another turn.
  const unverifiedCompletion = await new DecisionService(alwaysDoneAdapter).judgeCompletion(
    checkpoint({ pendingApprovalIds: ['approval_1'] }),
    ctx,
  );
  assert.equal(unverifiedCompletion.status, 'done');
  assert.equal(unverifiedCompletion.verified, false);
  assert.ok(unverifiedCompletion.verificationFailures.includes('pending-approval'));
  assert.ok(unverifiedCompletion.reasonCodes.includes('done-unverified'));

  // ...and it stands at any confidence. A 0.41 `done` used to become
  // `continue`, which re-ran an agent turn that had already finished.
  const unsureDoneAdapter: DecisionAdapter = {
    ...alwaysDoneAdapter,
    async judgeCompletion() {
      return {
        ok: true,
        data: {
          status: 'done',
          confidence: 0.41,
          probabilities: { done: 0.41, continue: 0.33, blocked: 0.26 },
          reasonCodes: ['synthetic-unsure-done'],
        },
        meta: {
          provider: 'jev',
          op: 'judge_completion',
          mode: 'mock',
          latencyMs: 0,
          destination: 'mock://jev',
        },
      };
    },
    async selectModel(input) {
      const pick = input.candidates.at(-1)!;
      return {
        ok: true,
        data: {
          selectedRouteId: pick.id,
          confidence: 0.35,
          probabilities: { [pick.id]: 0.35 },
          reasonCodes: ['synthetic-unsure-route'],
        },
        meta: {
          provider: 'jev',
          op: 'select_model',
          mode: 'mock',
          latencyMs: 0,
          destination: 'mock://jev',
        },
      };
    },
  };
  const unsureService = new DecisionService(unsureDoneAdapter);
  const unsureDone = await unsureService.judgeCompletion(checkpoint(), ctx);
  assert.equal(unsureDone.status, 'done');
  assert.equal(unsureDone.verified, true);
  const unsureRoute = await unsureService.selectModel(publicState, MODEL_ROUTE_FIXTURES, ctx);
  assert.equal(
    unsureRoute.selectedRouteId,
    eligibleModelRoutes(publicState, MODEL_ROUTE_FIXTURES).at(-1)?.id,
    'an eligible low-confidence route pick is followed, not swapped for a fallback',
  );

  const completed = await service.judgeCompletion(checkpoint(), ctx);
  assert.equal(completed.status, 'done');
  assert.equal(completed.verified, true);

  console.log(
    'PASS: Jev decision kernel is candidate-bounded, fail-closed, and completion-verified.',
  );
}

main().catch((error) => {
  console.error('Jev decision check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
