import type {
  ActionPolicy,
  Assignee,
  ActionPolicyRecommendation,
  AuthorizationDecision,
  CodingCompletionInput,
  CompletionDecision,
  CompletionJudgment,
  DecisionAdapter,
  DecisionState,
  FlakyTestInput,
  ModelRoute,
  ModelSelectionDecision,
  ProviderCallContext,
  RouteCandidateInput,
  SessionCheckpoint,
  Task,
  ToolAction,
  ToolDescriptor,
  ToolFamilySelectionDecision,
  ToolSelectionDecision,
} from '@htn/shared';
import {
  canSendToRemoteDecisionModel,
  completionDecisionState,
  completionVerificationFailures,
  eligibleModelRoutes,
  eligibleToolDescriptors,
  escalateLowConfidence,
  strictestActionPolicy,
} from './eligibility.js';
import { fallbackRoute, routeFeatures } from './routing.js';

export interface DecisionServiceOptions {
  /**
   * Below this, an action-policy recommendation is escalated one step towards a
   * human (never relaxed). It is the only confidence floor: model routes and
   * completion verdicts follow Jev at any confidence, because overriding them
   * re-ran agent turns that had already finished their work.
   */
  minimumConfidence?: number;
  maximumTools?: number;
  now?: () => string;
}

/**
 * Step 6 fallback rule on test status and budget. Never `done` while a test fails
 * or approval is pending; `done` needs a non-empty diff.
 */
export function fallbackCodingCompletion(input: CodingCompletionInput): 'done' | 'continue' | 'blocked' {
  if (input.pendingApprovals > 0) return 'blocked';
  const failing = input.tests !== null && input.tests.failed > 0;
  if (!failing && input.diff.files > 0) return 'done';
  return input.turns < input.maxTurns ? 'continue' : 'blocked';
}

/** What a coding `done` must have behind it. */
export function codingVerificationFailures(input: CodingCompletionInput): string[] {
  const failures: string[] = [];
  if (input.pendingApprovals > 0) failures.push('approvals-pending');
  if (input.diff.files === 0) failures.push('empty-diff');
  if (input.tests === null) failures.push('no-tests-ran');
  else if (input.tests.failed > 0) failures.push('tests-failing');
  return failures;
}

export class NoEligibleModelRouteError extends Error {
  constructor() {
    super('No policy-eligible model route is available.');
    this.name = 'NoEligibleModelRouteError';
  }
}

function deterministicModelFallback(candidates: ModelRoute[]): ModelRoute | undefined {
  const local = candidates.filter((candidate) => candidate.deployment === 'local');
  const pool = local.length > 0 ? local : candidates;
  const rank = { cheap: 0, standard: 1, frontier: 2 } as const;
  return [...pool].sort((a, b) => rank[a.costTier] - rank[b.costTier])[0];
}

function deterministicActionPolicy(descriptor: ToolDescriptor, action: ToolAction): ActionPolicy {
  if (
    descriptor.availability !== 'available' ||
    descriptor.baselineEffect === 'unknown' ||
    descriptor.simulated ||
    descriptor.id !== action.toolId ||
    descriptor.version !== action.descriptorVersion ||
    action.dataLabels.some((label) => !descriptor.allowedDataLabels.includes(label))
  ) {
    return 'deny';
  }
  if (
    action.dataLabels.some((label) => label === 'secret' || label === 'local_only') &&
    action.destination &&
    !action.destination.startsWith('local://')
  ) {
    return 'deny';
  }
  if (descriptor.requiresChangeReview || descriptor.baselineEffect === 'destructive' || descriptor.reversibility === 'irreversible') {
    return 'ask_user';
  }
  if (descriptor.baselineEffect === 'write' || descriptor.reversibility === 'recoverable') {
    return 'verify';
  }
  return 'auto';
}

function isPlainPublicRead(
  baseline: ActionPolicy,
  descriptor: ToolDescriptor,
  action: ToolAction,
): boolean {
  return (
    baseline === 'auto' &&
    descriptor.baselineEffect === 'read' &&
    descriptor.reversibility === 'reversible' &&
    !descriptor.requiresChangeReview &&
    descriptor.requiredScopes.length === 0 &&
    !action.accountRef &&
    action.dataLabels.every((label) => label === 'public')
  );
}

/**
 * The descriptor-only policy, with no Jev call. Used where the full policy is
 * evaluated later with more information (a prepared browser target), so an
 * early hard deny stops preparation without spending a second Jev round trip.
 */
export function baselineAuthorization(
  descriptor: ToolDescriptor,
  action: ToolAction,
  at: string,
): AuthorizationDecision {
  const baseline = deterministicActionPolicy(descriptor, action);
  return {
    actionId: action.id,
    recommendation: fallbackRecommendation(baseline, 'deterministic-pre-review'),
    finalPolicy: baseline,
    allowed: baseline === 'auto' || baseline === 'verify',
    reasonCodes: ['descriptor-baseline-' + baseline, 'deterministic-pre-review'],
    at,
  };
}

function fallbackRecommendation(
  policy: ActionPolicy,
  reasonCode: string,
): ActionPolicyRecommendation {
  return {
    policy,
    confidence: 1,
    probabilities: { [policy]: 1 },
    reasonCodes: [reasonCode],
  };
}

export class DecisionService {
  private readonly minimumConfidence: number;
  private readonly maximumTools: number;
  private readonly now: () => string;

  constructor(
    private readonly adapter: DecisionAdapter,
    options: DecisionServiceOptions = {},
  ) {
    this.minimumConfidence = options.minimumConfidence ?? 0.7;
    this.maximumTools = options.maximumTools ?? 8;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async selectModel(
    state: DecisionState,
    candidates: ModelRoute[],
    ctx: ProviderCallContext,
  ): Promise<ModelSelectionDecision> {
    const eligible = eligibleModelRoutes(state, candidates);
    const fallback = deterministicModelFallback(eligible);
    if (!fallback) throw new NoEligibleModelRouteError();

    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(state)) {
      return {
        selectedRouteId: fallback.id,
        confidence: 1,
        probabilities: { [fallback.id]: 1 },
        reasonCodes: ['remote-jev-ineligible', 'deterministic-local-fallback'],
      };
    }

    const result = await this.adapter.selectModel({ state, candidates: eligible }, ctx);
    if (!result.ok) {
      return {
        selectedRouteId: fallback.id,
        confidence: 0,
        probabilities: { [fallback.id]: 1 },
        reasonCodes: ['jev-select-model-failed', 'deterministic-model-fallback'],
      };
    }
    if (!eligible.some((candidate) => candidate.id === result.data.selectedRouteId)) {
      return {
        selectedRouteId: fallback.id,
        confidence: 0,
        probabilities: { [fallback.id]: 1 },
        reasonCodes: ['jev-returned-ineligible-model', 'deterministic-model-fallback'],
      };
    }
    // An eligible pick stands at any confidence. Swapping a low-confidence pick
    // for the cheapest route changed the model mid-task for no policy reason.
    return result.data;
  }

  async selectToolFamilies(
    state: DecisionState,
    candidateFamilies: string[],
    ctx: ProviderCallContext,
  ): Promise<ToolFamilySelectionDecision> {
    const uniqueFamilies = [...new Set(candidateFamilies)];
    if (uniqueFamilies.length === 0) {
      return { selectedFamilies: [], confidences: {}, reasonCodes: ['no-tool-families'] };
    }
    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(state)) {
      return {
        selectedFamilies: [],
        confidences: {},
        reasonCodes: ['remote-jev-ineligible', 'fail-closed-no-tool-families'],
      };
    }
    const result = await this.adapter.selectToolFamilies(
      { state, candidateFamilies: uniqueFamilies },
      ctx,
    );
    if (!result.ok) {
      return {
        selectedFamilies: [],
        confidences: {},
        reasonCodes: ['jev-select-tool-families-failed', 'fail-closed-no-tool-families'],
      };
    }
    const allowed = new Set(uniqueFamilies);
    return {
      ...result.data,
      selectedFamilies: result.data.selectedFamilies.filter((family) => allowed.has(family)),
      reasonCodes: result.data.selectedFamilies.some((family) => !allowed.has(family))
        ? [...result.data.reasonCodes, 'removed-unknown-tool-family']
        : result.data.reasonCodes,
    };
  }

  async selectTools(
    state: DecisionState,
    candidates: ToolDescriptor[],
    ctx: ProviderCallContext,
  ): Promise<ToolSelectionDecision> {
    const eligible = eligibleToolDescriptors(state, candidates);
    if (eligible.length === 0) {
      return { selectedToolIds: [], confidences: {}, reasonCodes: ['no-eligible-tools'] };
    }
    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(state)) {
      return {
        selectedToolIds: [],
        confidences: {},
        reasonCodes: ['remote-jev-ineligible', 'fail-closed-no-tools'],
      };
    }
    const result = await this.adapter.selectTools(
      { state, candidates: eligible, maxTools: this.maximumTools },
      ctx,
    );
    if (!result.ok) {
      return {
        selectedToolIds: [],
        confidences: {},
        reasonCodes: ['jev-select-tools-failed', 'fail-closed-no-tools'],
      };
    }
    const allowed = new Set(eligible.map((tool) => tool.id));
    const selectedToolIds = result.data.selectedToolIds
      .filter((toolId) => allowed.has(toolId))
      .slice(0, this.maximumTools);
    return {
      ...result.data,
      selectedToolIds,
      reasonCodes: result.data.selectedToolIds.some((toolId) => !allowed.has(toolId))
        ? [...result.data.reasonCodes, 'removed-ineligible-tool']
        : result.data.reasonCodes,
    };
  }

  async authorizeAction(
    state: DecisionState,
    action: ToolAction,
    descriptor: ToolDescriptor,
    ctx: ProviderCallContext,
  ): Promise<AuthorizationDecision> {
    const baseline = deterministicActionPolicy(descriptor, action);
    let recommendation: ActionPolicyRecommendation;

    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(state)) {
      recommendation = fallbackRecommendation(baseline, 'deterministic-local-action-policy');
    } else if (isPlainPublicRead(baseline, descriptor, action)) {
      // Jev can only make a policy stricter, and a public, reversible,
      // scope-free read is already `auto` with nothing to protect. Skipping
      // the round trip keeps authorization deterministic, not absent.
      recommendation = fallbackRecommendation(baseline, 'deterministic-public-read');
    } else {
      const result = await this.adapter.recommendActionPolicy({ state, action, descriptor }, ctx);
      recommendation = result.ok
        ? result.data
        : fallbackRecommendation('deny', 'jev-action-policy-failed');
    }

    // Model uncertainty/risk is a human-review boundary, not a retryable tool
    // rejection. Deterministic privacy/permission denials and failed policy
    // evaluation still cannot be overridden by a receipt.
    const failedPolicy = recommendation.reasonCodes.includes('jev-action-policy-failed');
    const confidencePolicy = failedPolicy ? 'deny'
      : recommendation.confidence < this.minimumConfidence || recommendation.policy === 'deny'
        ? 'ask_user' : recommendation.policy;
    const finalPolicy = strictestActionPolicy(baseline, confidencePolicy);
    return {
      actionId: action.id,
      recommendation,
      finalPolicy,
      allowed: finalPolicy === 'auto' || finalPolicy === 'verify',
      reasonCodes: [
        `descriptor-baseline-${baseline}`,
        ...recommendation.reasonCodes,
        ...(recommendation.confidence < this.minimumConfidence
          ? ['low-confidence-escalation']
          : []),
      ],
      at: this.now(),
    };
  }

  async judgeCompletion(
    checkpoint: SessionCheckpoint,
    ctx: ProviderCallContext,
  ): Promise<CompletionDecision> {
    const verificationFailures = completionVerificationFailures(checkpoint);
    const state = completionDecisionState(checkpoint);
    let judgment: CompletionJudgment;

    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(state)) {
      judgment = {
        status: verificationFailures.length === 0 ? 'done' : this.fallbackCompletion(checkpoint),
        confidence: 1,
        probabilities: {},
        reasonCodes: ['deterministic-local-completion'],
      };
    } else {
      const result = await this.adapter.judgeCompletion({ checkpoint, sanitizedState: state }, ctx);
      judgment = result.ok
        ? result.data
        : {
            status:
              verificationFailures.length === 0 ? 'done' : this.fallbackCompletion(checkpoint),
            confidence: 0,
            probabilities: {},
            reasonCodes: ['jev-completion-failed', 'deterministic-completion-fallback'],
          };
    }

    // Jev's verdict stands at any confidence and is never rewritten. Rewriting
    // a low-confidence or unverified `done` into `continue` bought another full
    // agent turn that redid finished work. A failed deterministic check is
    // reported beside the verdict (`verified: false`), not substituted for it.
    const unverifiedDone = judgment.status === 'done' && verificationFailures.length > 0;
    return {
      ...judgment,
      verified: judgment.status === 'done' && verificationFailures.length === 0,
      verificationFailures,
      ...(unverifiedDone ? { reasonCodes: [...judgment.reasonCodes, 'done-unverified'] } : {}),
    };
  }

  /**
   * Step 5 L2: Jev's relevance score per candidate file, or `null` when the
   * caller must use its deterministic rank (adapter lacks the operation, state is
   * not remote-eligible, or the call failed). Scores for paths that were not
   * candidates are dropped; a missing candidate counts as 0.
   */
  async scoreFiles(
    eligibility: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>,
    input: { task: string; files: { path: string; summary: string }[] },
    ctx: ProviderCallContext,
  ): Promise<{ scores: Record<string, number> | null; reasonCodes: string[] }> {
    if (!this.adapter.scoreFiles) {
      return { scores: null, reasonCodes: ['jev-score-files-unsupported', 'deterministic-rank-fallback'] };
    }
    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(eligibility)) {
      return { scores: null, reasonCodes: ['remote-jev-ineligible', 'deterministic-rank-fallback'] };
    }
    if (input.files.length === 0) return { scores: {}, reasonCodes: ['no-candidate-files'] };
    const result = await this.adapter.scoreFiles(input, ctx);
    if (!result.ok) {
      return { scores: null, reasonCodes: ['jev-score-files-failed', 'deterministic-rank-fallback'] };
    }
    const scores: Record<string, number> = {};
    for (const file of input.files) {
      const value = result.data.scores[file.path];
      scores[file.path] = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    }
    return { scores, reasonCodes: result.data.reasonCodes };
  }

  /**
   * Step 6: Jev's relevance score per candidate test, or `null` when the caller
   * must run every candidate (adapter lacks the operation, state is not
   * remote-eligible, or the call failed). Mirrors `scoreFiles`.
   */
  async scoreTests(
    eligibility: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>,
    input: { task: string; changed: string[]; tests: { id: string; summary: string }[] },
    ctx: ProviderCallContext,
  ): Promise<{ scores: Record<string, number> | null; reasonCodes: string[] }> {
    if (!this.adapter.scoreTests) {
      return { scores: null, reasonCodes: ['jev-score-tests-unsupported', 'run-every-candidate'] };
    }
    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(eligibility)) {
      return { scores: null, reasonCodes: ['remote-jev-ineligible', 'run-every-candidate'] };
    }
    if (input.tests.length === 0) return { scores: {}, reasonCodes: ['no-candidate-tests'] };
    const result = await this.adapter.scoreTests(input, ctx);
    if (!result.ok) {
      return { scores: null, reasonCodes: ['jev-score-tests-failed', 'run-every-candidate'] };
    }
    const scores: Record<string, number> = {};
    for (const test of input.tests) {
      const value = result.data.scores[test.id];
      scores[test.id] = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    }
    return { scores, reasonCodes: result.data.reasonCodes };
  }

  /**
   * Step 6: a coding run's completion verdict. Jev judges from the test digest,
   * diff stat and turn count; without Jev the fallback rule decides, and that rule
   * never says `done` while a test fails. As with `judgeCompletion`, Jev's verdict
   * is not rewritten: `verified` reports whether the evidence backs a `done`.
   */
  async completionVerdict(
    eligibility: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>,
    input: CodingCompletionInput,
    ctx: ProviderCallContext,
  ): Promise<CompletionDecision & { source: 'jev' | 'fallback' }> {
    const verificationFailures = codingVerificationFailures(input);
    let judgment: CompletionJudgment | undefined;
    let fallbackReason: string | undefined;
    if (!this.adapter.judgeCodingCompletion) fallbackReason = 'jev-coding-completion-unsupported';
    else if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(eligibility)) {
      fallbackReason = 'remote-jev-ineligible';
    } else {
      const result = await this.adapter.judgeCodingCompletion(input, ctx);
      if (result.ok) judgment = result.data;
      else fallbackReason = 'jev-coding-completion-failed';
    }
    const source = judgment ? ('jev' as const) : ('fallback' as const);
    judgment ??= {
      status: fallbackCodingCompletion(input),
      confidence: 1,
      probabilities: {},
      reasonCodes: [fallbackReason!, 'deterministic-completion-fallback'],
    };
    const unverifiedDone = judgment.status === 'done' && verificationFailures.length > 0;
    return {
      ...judgment,
      verified: judgment.status === 'done' && verificationFailures.length === 0,
      verificationFailures,
      ...(unverifiedDone ? { reasonCodes: [...judgment.reasonCodes, 'done-unverified'] } : {}),
      source,
    };
  }

  /**
   * Step 6: is a failing test flaky? Jev's probability from the test's history;
   * without Jev, or on any failure, the failure is treated as real.
   */
  async flakyVerdict(
    eligibility: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>,
    input: FlakyTestInput,
    ctx: ProviderCallContext,
  ): Promise<{ flaky: boolean; probability: number; reasonCodes: string[]; source: 'jev' | 'fallback' }> {
    const real = (reason: string) => ({
      flaky: false,
      probability: 0,
      reasonCodes: [reason, 'treat-failure-as-real'],
      source: 'fallback' as const,
    });
    if (!this.adapter.judgeFlaky) return real('jev-flaky-unsupported');
    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(eligibility)) {
      return real('remote-jev-ineligible');
    }
    const result = await this.adapter.judgeFlaky(input, ctx);
    if (!result.ok || !Number.isFinite(result.data.flakyProbability)) return real('jev-flaky-failed');
    const probability = Math.max(0, Math.min(1, result.data.flakyProbability));
    return { flaky: probability >= 0.5, probability, reasonCodes: result.data.reasonCodes, source: 'jev' };
  }

  /**
   * Step 7: who runs a board task. A user pin wins outright and Jev is not asked.
   * Otherwise Jev picks one candidate key (followed at any confidence); without Jev,
   * when the task may not leave the machine, or when Jev's choice is not a
   * candidate, the deterministic rules in `routing.ts` decide.
   */
  async routeTask(
    eligibility: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>,
    task: Pick<Task, 'title' | 'acceptance' | 'writeScope' | 'assignee' | 'pinned'>,
    candidates: RouteCandidateInput[],
    ctx: ProviderCallContext,
    failures = 0,
  ): Promise<{
    assignee: Assignee;
    source: 'pin' | 'jev' | 'fallback';
    confidence: number;
    probabilities: Record<string, number>;
    reasonCodes: string[];
  }> {
    if (task.pinned && task.assignee) {
      return { assignee: task.assignee, source: 'pin', confidence: 1, probabilities: {}, reasonCodes: ['user-pin'] };
    }
    const input = routeFeatures(task, candidates, failures);
    const fallback = (reason: string) => {
      const rule = fallbackRoute(input, task.assignee);
      return {
        assignee: rule.assignee,
        source: 'fallback' as const,
        confidence: 1,
        probabilities: {},
        reasonCodes: [reason, 'route-rule-' + rule.rule],
      };
    };
    if (candidates.length === 0) return fallback('no-candidates');
    if (!this.adapter.routeTask) return fallback('jev-route-task-unsupported');
    if (this.adapter.mode === 'live' && !canSendToRemoteDecisionModel(eligibility)) {
      return fallback('remote-jev-ineligible');
    }
    const result = await this.adapter.routeTask(input, ctx);
    if (!result.ok) return fallback('jev-route-task-failed');
    const chosen = candidates.find((c) => c.key === result.data.choice);
    if (!chosen) return fallback('jev-route-task-unknown-choice');
    return {
      assignee: chosen.assignee,
      source: 'jev',
      confidence: result.data.confidence,
      probabilities: result.data.probabilities,
      reasonCodes: result.data.reasonCodes,
    };
  }

  private fallbackCompletion(checkpoint: SessionCheckpoint): 'continue' | 'blocked' {
    if (checkpoint.pendingApprovalIds.length > 0) return 'blocked';
    return checkpoint.budget.stepsRemaining > 0 ? 'continue' : 'blocked';
  }
}
