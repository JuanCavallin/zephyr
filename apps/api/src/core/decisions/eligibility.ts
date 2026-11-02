import type {
  ActionPolicy,
  DataLabel,
  DecisionState,
  ModelRoute,
  SessionCheckpoint,
  ToolDescriptor,
} from '@htn/shared';

const REMOTE_FORBIDDEN_LABELS = new Set<DataLabel>(['secret', 'local_only']);

export function canSendToRemoteDecisionModel(
  state: Pick<DecisionState, 'sanitizedForRemote' | 'dataLabels'>,
): boolean {
  return (
    state.sanitizedForRemote &&
    !state.dataLabels.some((label) => REMOTE_FORBIDDEN_LABELS.has(label))
  );
}

function permitsLabels(allowed: DataLabel[], requested: DataLabel[]): boolean {
  return requested.every((label) => allowed.includes(label));
}

export function eligibleModelRoutes(state: DecisionState, candidates: ModelRoute[]): ModelRoute[] {
  return candidates.filter((candidate) => {
    if (!candidate.enabled || !permitsLabels(candidate.allowedDataLabels, state.dataLabels)) {
      return false;
    }
    if (
      state.dataLabels.some((label) => REMOTE_FORBIDDEN_LABELS.has(label)) &&
      candidate.deployment !== 'local'
    ) {
      return false;
    }
    return true;
  });
}

export function eligibleToolDescriptors(
  state: DecisionState,
  candidates: ToolDescriptor[],
): ToolDescriptor[] {
  return candidates.filter(
    (candidate) =>
      candidate.availability === 'available' &&
      candidate.baselineEffect !== 'unknown' &&
      permitsLabels(candidate.allowedDataLabels, state.dataLabels),
  );
}

/** Builds remote state exclusively from fields explicitly marked sanitized. */
export function completionDecisionState(checkpoint: SessionCheckpoint): DecisionState {
  const sanitizedSummaries = [
    ...checkpoint.steps.map((step) => step.sanitizedSummary),
    ...checkpoint.artifacts.map((artifact) => artifact.sanitizedSummary),
  ].filter((summary): summary is string => Boolean(summary));
  const sanitizedForRemote =
    Boolean(checkpoint.sanitizedObjective) &&
    !checkpoint.dataLabels.some((label) => REMOTE_FORBIDDEN_LABELS.has(label));

  return {
    taskSummary: checkpoint.sanitizedObjective ?? 'Local-only objective withheld.',
    contextSummary:
      sanitizedSummaries.length > 0 ? sanitizedSummaries.join('\n').slice(0, 8_000) : undefined,
    dataLabels: checkpoint.dataLabels,
    sanitizedForRemote,
  };
}

export function completionVerificationFailures(checkpoint: SessionCheckpoint): string[] {
  const failures: string[] = [];
  if (checkpoint.pendingApprovalIds.length > 0) failures.push('pending-approval');
  if (checkpoint.outstandingRequirements.length > 0) failures.push('outstanding-requirement');
  if (checkpoint.steps.some((step) => step.required && step.status !== 'succeeded')) {
    failures.push('required-step-incomplete');
  }
  if (checkpoint.artifacts.some((artifact) => artifact.required && !artifact.verified)) {
    failures.push('required-artifact-unverified');
  }
  if (
    checkpoint.verifications.some((verification) => verification.required && !verification.passed)
  ) {
    failures.push('required-verification-failed');
  }
  return failures;
}

const POLICY_RANK: Record<ActionPolicy, number> = {
  auto: 0,
  verify: 1,
  ask_user: 2,
  deny: 3,
};

export function strictestActionPolicy(...policies: ActionPolicy[]): ActionPolicy {
  return policies.reduce<ActionPolicy>(
    (strictest, policy) => (POLICY_RANK[policy] > POLICY_RANK[strictest] ? policy : strictest),
    'auto',
  );
}

export function escalateLowConfidence(policy: ActionPolicy): ActionPolicy {
  if (policy === 'auto') return 'verify';
  if (policy === 'verify') return 'ask_user';
  return policy;
}
