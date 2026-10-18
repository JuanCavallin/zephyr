/**
 * The blocking half of the risk gate.
 *
 * The orchestrator awaits a promise; POST /api/approvals/:id/decide resolves it.
 * Waiters live in memory only — that is correct, because a pending approval is
 * meaningless once the process that was waiting on it is gone. On restart the
 * approval is marked 'expired' rather than silently resuming.
 */

import type { ProposedAction } from '@htn/shared';

export type ApprovalVerdict = 'approved' | 'rejected' | 'revised';

/**
 * What the waiting orchestrator gets back.
 *
 * `action` is the action as finally authorized. For a plain approval that is
 * the action the agent proposed; for a revision it is the human's edit, already
 * put back through `classify()`. The caller executes THIS, never the original —
 * that is the whole point of a revision.
 */
export interface ApprovalOutcome {
  verdict: ApprovalVerdict;
  action: ProposedAction;
}

export class ApprovalRejectedError extends Error {
  readonly code = 'APPROVAL_REJECTED';
  constructor(
    readonly approvalId: string,
    readonly note?: string,
  ) {
    super('Approval ' + approvalId + ' was rejected' + (note ? ': ' + note : ''));
    this.name = 'ApprovalRejectedError';
  }
}

interface Waiter {
  cleanup: () => void;
  resolve: (outcome: ApprovalOutcome) => void;
  reject: (err: Error) => void;
  /**
   * The action exactly as the agent proposed it. Kept here rather than on the
   * stored Approval because reauthorizing a revision needs the classifier's
   * INPUT (kind, amountCents, declared reversibility), not the rendered payload
   * the panel shows. It lives with the waiter because a revision is only
   * meaningful while the orchestrator that proposed it is still waiting.
   */
  action: ProposedAction;
}

const waiters = new Map<string, Waiter>();

/** Block until someone decides this approval, or the run is aborted. */
export function waitForApproval(
  approvalId: string,
  action: ProposedAction,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Run aborted before approval'));
      return;
    }

    const abort = () => {
      waiters.delete(approvalId);
      signal?.removeEventListener('abort', abort);
      reject(new Error('Run aborted while awaiting approval'));
    };
    waiters.set(approvalId, {
      resolve,
      reject,
      action,
      cleanup: () => signal?.removeEventListener('abort', abort),
    });
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Resolve a waiting orchestrator.
 * Returns false when nobody is waiting — a stale decision after a restart, which
 * the caller should surface rather than swallow.
 */
export function settleApproval(approvalId: string, outcome: ApprovalOutcome): boolean {
  const waiter = waiters.get(approvalId);
  if (!waiter) return false;
  waiters.delete(approvalId);
  waiter.cleanup();
  waiter.resolve(outcome);
  return true;
}

/** The originally proposed action, while someone is still waiting on it. */
export function pendingAction(approvalId: string): ProposedAction | null {
  return waiters.get(approvalId)?.action ?? null;
}

export function isAwaiting(approvalId: string): boolean {
  return waiters.has(approvalId);
}

export function pendingCount(): number {
  return waiters.size;
}
