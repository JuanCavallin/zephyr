import type {
  ActionPolicy,
  ActionPolicyRecommendation,
  AuthorizationDecision,
  CompletionDecision,
  CompletionJudgment,
  DecisionAdapter,
  DecisionState,
  ModelRoute,
  ModelSelectionDecision,
  ProviderCallContext,
  SessionCheckpoint,
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

  private fallbackCompletion(checkpoint: SessionCheckpoint): 'continue' | 'blocked' {
    if (checkpoint.pendingApprovalIds.length > 0) return 'blocked';
    return checkpoint.budget.stepsRemaining > 0 ? 'continue' : 'blocked';
  }
}
