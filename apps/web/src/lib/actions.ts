import type {
  ActionEvidence,
  ActionPreview,
  Approval,
  Json,
  ToolLifecycleEvent,
} from '@htn/shared';

export interface LoadedActionPreview {
  evidence: ActionEvidence;
  preview: ActionPreview;
}

export interface WorkspaceAction {
  id: string;
  events: ToolLifecycleEvent[];
  latest: ToolLifecycleEvent;
  approval?: Approval;
}

/** SSE arrival order is authoritative; timestamps can be equal or drift. */
export function groupActions(
  events: readonly ToolLifecycleEvent[],
  approvals: readonly Approval[] = [],
): WorkspaceAction[] {
  const groups = new Map<string, ToolLifecycleEvent[]>();
  for (const event of events) {
    const group = groups.get(event.action.id) ?? [];
    const duplicate = group.findIndex((item) => item.id === event.id);
    if (duplicate >= 0) group[duplicate] = event;
    else group.push(event);
    groups.set(event.action.id, group);
  }
  return [...groups].map(([id, history]) => {
    const latest = history.at(-1)!;
    const approvalId = [...history].reverse().find((event) => event.approvalId)?.approvalId;
    const approval = approvals.find((item) => {
      if (approvalId && item.id === approvalId) return true;
      const proposal = item.proposedAction;
      return (
        proposal &&
        typeof proposal === 'object' &&
        !Array.isArray(proposal) &&
        proposal.actionId === id
      );
    });
    return { id, events: history, latest, ...(approval ? { approval } : {}) };
  });
}

export function actionStatus(
  action: WorkspaceAction,
  evidence: readonly ActionEvidence[] = [],
): string {
  const receipts = [
    ...evidence,
    ...action.events.flatMap((event) => (event.evidence ? [event.evidence] : [])),
  ];
  if (action.approval?.status === 'rejected') return 'Rejected';
  if (action.latest.outcome === 'partial') return 'Partially completed';
  if (action.latest.outcome === 'unknown') return 'Outcome unknown';
  switch (action.latest.phase) {
    case 'succeeded':
      if (receipts.some((item) => item.phase === 'executed' && item.executionMode === 'mock'))
        return 'Simulated completion';
      return receipts.some(
        (item) => item.phase === 'executed' && item.evidenceLevel === 'readback_verified',
      )
        ? 'Verified changes'
        : 'Provider reported success';
    case 'failed':
      return /timeout|unknown/i.test(action.latest.error?.code ?? '')
        ? 'Outcome unknown'
        : 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'executing':
      return 'Executing';
    case 'approved':
      return 'Approved';
    default:
      return 'Proposed';
  }
}

/** Match the exact reviewed capability; an older proposal cannot enable a newer approval. */
export function approvalPreviewReady(
  action: WorkspaceAction,
  previews: readonly LoadedActionPreview[],
): boolean {
  const proposed = action.approval?.proposedAction;
  const payload =
    proposed && typeof proposed === 'object' && !Array.isArray(proposed) ? proposed : undefined;
  const args = payload?.arguments ?? action.latest.action.arguments;
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    typeof args.previewRef !== 'string'
  )
    return true;
  const fingerprint =
    typeof payload?.previewFingerprint === 'string' ? payload.previewFingerprint : args.fingerprint;
  return previews.some(
    (item) =>
      item.evidence.phase === 'proposed' &&
      item.evidence.previewRef === args.previewRef &&
      (typeof fingerprint !== 'string' || item.evidence.fingerprint === fingerprint) &&
      !item.preview.truncated,
  );
}

export function actionFailureConsequence(action: WorkspaceAction): string {
  if (action.latest.outcome === 'not_executed' || action.approval?.status === 'rejected')
    return 'This proposed action did not execute. Earlier completed actions remain.';
  if (action.latest.outcome === 'partial')
    return 'Some effects completed. Review the receipts before retrying.';
  return 'The resource may have changed. Inspect the result before retrying.';
}

/** Credential-only fields are never a reviewable part of an action. Content and recipients remain visible. */
export function redactCredentialFields(value: unknown): Json {
  if (Array.isArray(value)) return value.map(redactCredentialFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|client[_-]?secret|credential)$/i.test(
          key,
        )
          ? '[credential redacted]'
          : redactCredentialFields(item),
      ]),
    );
  }
  return value === undefined ? null : (value as Json);
}

/** Resource links must be actual web URLs. Never interpret provider HTML as markup. */
export function safeResourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
