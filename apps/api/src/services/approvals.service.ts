/**
 * Approval decisions — the client->server half of the risk gate.
 *
 * Deliberately a plain POST rather than a WebSocket message: it gets zod
 * validation, HTTP status codes, and idempotency through the same middleware as
 * every other route.
 */

import type { Approval, ApprovalDecision, Json } from '@htn/shared';
import { pendingAction, settleApproval } from '../core/approvalGate.js';
import { reauthorizeRevision } from '../core/risk.js';
import { nowIso } from '../lib/ids.js';
import { bus, store } from './runtime.js';
import {
  actionEvidenceStore,
  actionFingerprint,
  actionForTrace,
  buildActionPreview,
} from './actionEvidence.js';
import { browserTools, toolRegistry, toolExecutors } from './runtime.js';
import Ajv, { type AnySchema } from 'ajv';
import { KeyedLock } from '../core/locks.js';
import { prepareBrowserHandoffApproval } from '../providers/withBrowserOwnership.js';
import { isTerminal } from '@htn/shared';

const approvalLocks = new KeyedLock();

/** The client sent a revision the gate refuses. Distinct from a conflict. */
export class ApprovalRevisionError extends Error {
  readonly code = 'APPROVAL_REVISION_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRevisionError';
  }
}

function toJson(value: unknown): Json {
  return (JSON.parse(JSON.stringify(value ?? null)) ?? null) as Json;
}

export class ApprovalConflictError extends Error {
  readonly code = 'APPROVAL_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

export async function listPendingApprovals(runId: string): Promise<Approval[]> {
  const all = await store.listApprovals(runId);
  return all.filter((a) => a.status === 'pending');
}

export async function getApproval(id: string): Promise<Approval | null> {
  return store.getApproval(id);
}

/**
 * Record the decision, tell the UI, then release the blocked orchestrator.
 *
 * Order matters: persist and emit BEFORE settling, so that by the time the run
 * resumes, any client watching has already seen the resolution.
 */
/**
 * A person picked a different element on a pending browser-target review.
 *
 * The choice is remembered for this graph node and page, then the approval is
 * resolved as an unchanged revision, which makes the broker prepare the action
 * again: that preparation resolves to the corrected element and asks for
 * approval of IT. Nothing is clicked by this call.
 */
export async function correctBrowserTarget(id: string, index: number): Promise<Approval> {
  const approval = await store.getApproval(id);
  if (!approval) throw new ApprovalConflictError('Approval not found.');
  if (approval.status !== 'pending')
    throw new ApprovalConflictError('This approval was already decided.');
  const proposed = approval.proposedAction;
  const review = isRecord(proposed) && isRecord(proposed.review) ? proposed.review : undefined;
  if (
    !isRecord(proposed) ||
    typeof proposed.actionId !== 'string' ||
    review?.kind !== 'browser_target'
  )
    throw new ApprovalRevisionError('Only a pending browser-target review can be corrected.');
  if (!(await browserTools.correctTarget(proposed.actionId, index)))
    throw new ApprovalRevisionError(
      'That element cannot be used for this action, or this page is not remembered (private data).',
    );
  return decideApproval(id, {
    decision: 'revised',
    revisedPayload: proposed,
    note: 'Browser target corrected by a person to element [' + index.toString() + '].',
  });
}

export async function decideApproval(id: string, body: ApprovalDecision): Promise<Approval> {
  const release = await approvalLocks.acquire(id);
  try {
    return await decideApprovalLocked(id, body);
  } finally {
    release();
  }
}

async function decideApprovalLocked(id: string, body: ApprovalDecision): Promise<Approval> {
  const { decision, note } = body;
  const existing = await store.getApproval(id);
  if (!existing) throw new ApprovalConflictError('Approval ' + id + ' not found');

  if (existing.status !== 'pending') {
    throw new ApprovalConflictError(
      'Approval ' + id + ' is already ' + existing.status + ' and cannot be changed',
    );
  }

  // A revision is reauthorized BEFORE anything is persisted or released, so a
  // refused revision leaves the approval exactly as it was: still pending, still
  // decidable. Nothing half-applied.
  let patch: Partial<Approval> = { status: decision, decidedAt: nowIso(), note };
  let outcomeAction = pendingAction(id);
  const currentRun = await store.getRun(existing.runId);
  if (!outcomeAction || !currentRun || isTerminal(currentRun.status))
    throw new ApprovalConflictError(
      'This run is no longer waiting on the approval. Start a new action.',
    );
  const proposed = existing.proposedAction;
  const handoff =
    isRecord(proposed) && isRecord(proposed.review) && proposed.review.kind === 'browser_handoff'
      ? proposed.review
      : proposed;
  if (
    isRecord(handoff) &&
    (handoff.kind === 'human_handoff' || handoff.kind === 'browser_handoff')
  ) {
    if (decision === 'revised')
      throw new ApprovalRevisionError(
        'A browser handoff cannot be revised into a different target or continuation.',
      );
    if (decision === 'approved') {
      if (
        typeof handoff.sessionId !== 'string' ||
        (handoff.resumeWhen === 'url_matches' &&
          (typeof handoff.expectUrl !== 'string' || !handoff.expectUrl))
      )
        throw new ApprovalConflictError('Handoff verification target is missing.');
      try {
        await prepareBrowserHandoffApproval({
          runId: existing.runId,
          sessionId: handoff.sessionId,
          ...(typeof handoff.expectUrl === 'string' ? { expectUrl: handoff.expectUrl } : {}),
        });
      } catch {
        throw new ApprovalConflictError(
          'Could not safely revoke browser control or verify the handoff. Approval remains pending. Retry verification or return to manual control.',
        );
      }
    }
  }

  if (decision === 'revised') {
    const original = pendingAction(id);
    if (!original) {
      throw new ApprovalConflictError(
        'Approval ' + id + ' can no longer be revised — nothing is waiting on it',
      );
    }

    await validateExactToolRevision(existing, body.revisedPayload);
    const authorization = reauthorizeRevision(original, {
      payload: body.revisedPayload,
      amountCents: body.revisedAmountCents,
    });
    if (!authorization.ok) throw new ApprovalRevisionError(authorization.reason);

    outcomeAction = authorization.action;
    patch = {
      ...patch,
      // Both survive: what was asked for, and what actually runs.
      revisedAction: await privateRevisionMetadata(authorization.action.payload, existing),
      reversibility: authorization.decision.reversibility,
      riskClass: authorization.decision.riskClass,
      reauthorizedRule: authorization.decision.rule,
    };
  }

  // Verification can await remote browser I/O. Cancellation/timeout may have
  // expired the waiter while it was in flight; never revive that action.
  const latestRun = await store.getRun(existing.runId);
  const latestApproval = await store.getApproval(id);
  if (
    !pendingAction(id) ||
    !latestRun ||
    isTerminal(latestRun.status) ||
    latestApproval?.status !== 'pending'
  ) {
    throw new ApprovalConflictError(
      'This run stopped waiting while the action was being verified. Start a new action.',
    );
  }
  const updated = await store.patchApproval(id, patch);

  await bus.emit(updated.runId, { type: 'approval.resolved', approval: updated });

  const released =
    outcomeAction !== null && settleApproval(id, { verdict: decision, action: outcomeAction });
  if (!released) {
    // Nobody was waiting — the process restarted while this approval was pending.
    // Surface it instead of leaving a run stuck in awaiting_approval forever.
    const run = await store.patchRun(updated.runId, {
      status: 'failed',
      summary: 'The run was no longer waiting on this approval (server restarted).',
      error: {
        code: 'APPROVAL_ORPHANED',
        message: 'No orchestrator was awaiting approval ' + id,
      },
    });
    await bus.emit(run.id, { type: 'run.updated', run });
  }

  return updated;
}

async function privateRevisionMetadata(payload: unknown, approval: Approval): Promise<Json> {
  const value = toJson(payload);
  const proposed = approval.proposedAction;
  if (
    !proposed ||
    typeof proposed !== 'object' ||
    Array.isArray(proposed) ||
    typeof proposed.actionId !== 'string'
  )
    return value;
  const evidence = actionEvidenceStore
    .list(approval.runId, proposed.actionId)
    .findLast((e) => e.phase === 'proposed');
  if (
    !evidence ||
    !['document', 'spreadsheet', 'presentation'].includes(evidence.kind) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return value;
  const original = actionEvidenceStore.exactAction(approval.runId, proposed.actionId);
  const registered = original ? await toolRegistry.get(original.toolId) : null;
  if (!original || !registered)
    throw new ApprovalRevisionError('Exact proposal expired; request a fresh action.');
  const next = { ...original, arguments: value.arguments };
  next.previewFingerprint = actionFingerprint(next);
  actionEvidenceStore.proposed(next, registered.descriptor);
  return {
    ...value,
    arguments: actionForTrace(next).arguments,
    previewFingerprint: next.previewFingerprint,
  };
}

/** Reject retargeting/schema errors while the original approval is still pending. */
async function validateExactToolRevision(approval: Approval, revised: unknown): Promise<void> {
  const proposed = approval.proposedAction;
  if (!isRecord(proposed) || typeof proposed.actionId !== 'string') return;
  const original = actionEvidenceStore.exactAction(approval.runId, proposed.actionId);
  if (!original) throw new ApprovalRevisionError('Exact proposal expired; request a fresh action.');
  if (!isRecord(revised) || !('arguments' in revised))
    throw new ApprovalRevisionError(
      'Revision requires the complete exact-action envelope and arguments.',
    );
  for (const key of [
    'actionId',
    'toolId',
    'descriptorVersion',
    'operation',
    'destination',
    'dataLabels',
    'previewFingerprint',
    'accountRef',
    'review',
  ]) {
    if (JSON.stringify(proposed[key]) !== JSON.stringify(revised[key]))
      throw new ApprovalRevisionError('Revision cannot change ' + key + '.');
  }
  const args = revised.arguments as Json;
  if (isRecord(original.arguments) && isRecord(args))
    for (const key of [
      'artifactId',
      'document_id',
      'spreadsheet_id',
      'file_id',
      'connectedAccountId',
      'account_id',
      'expectedVersion',
      'baseVersion',
      'etag',
      'range',
      'sheet',
    ]) {
      if (JSON.stringify(original.arguments[key]) !== JSON.stringify(args[key]))
        throw new ApprovalRevisionError(
          'Revision cannot change reviewed target/version (' + key + ').',
        );
    }
  const registered = await toolRegistry.get(original.toolId);
  if (!registered || registered.descriptor.version !== original.descriptorVersion)
    throw new ApprovalRevisionError('Tool metadata changed; request fresh approval.');
  const validate = new Ajv({ allErrors: true, strict: true }).compile(
    registered.inputSchema as AnySchema,
  );
  if (!validate(args))
    throw new ApprovalRevisionError('Revised arguments do not satisfy the trusted tool schema.');
  if (buildActionPreview({ ...original, arguments: args }, registered.descriptor).truncated)
    throw new ApprovalRevisionError(
      'Revised change exceeds the complete preview budget; narrow the edit.',
    );
  const executor = toolExecutors.resolve(registered.descriptor.executorRef);
  if (
    !executor ||
    executor.destinationFor({ descriptor: registered.descriptor, arguments: args }) !==
      original.destination
  )
    throw new ApprovalRevisionError('Revision cannot change the reviewed destination.');
}

function isRecord(value: unknown): value is Record<string, Json> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
