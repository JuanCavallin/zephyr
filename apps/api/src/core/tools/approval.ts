import type {
  AuthorizationDecision,
  Json,
  ProposedAction,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';
import type { Store } from '../../store/types.js';
import { newId, nowIso } from '../../lib/ids.js';
import { ApprovalRejectedError, waitForApproval } from '../approvalGate.js';
import type { RunBus } from '../bus.js';
import type { SessionStateService } from '../sessions/service.js';
import { actionForTrace } from '../../services/actionEvidence.js';

export interface ToolApprovalReceipt {
  approvalId: string;
  /**
   * Set only when the human edited the exact arguments. The broker must
   * revalidate these against the tool schema and run authorizeAction a SECOND
   * time before executing them — a revision is a new action, not a blessed
   * one.
   */
  revisedArguments?: Json;
}

export interface ToolApprovalGate {
  request(
    input: {
      action: ToolAction;
      descriptor: ToolDescriptor;
      authorization: AuthorizationDecision;
    },
    signal?: AbortSignal,
  ): Promise<ToolApprovalReceipt>;
}

/** Persists an exact-action approval and blocks the caller until it is resolved. */
export class RunToolApprovalGate implements ToolApprovalGate {
  constructor(
    private readonly store: Store,
    private readonly bus: RunBus,
    private readonly sessions: SessionStateService,
  ) {}

  async request(
    input: {
      action: ToolAction;
      descriptor: ToolDescriptor;
      authorization: AuthorizationDecision;
    },
    signal?: AbortSignal,
  ): Promise<ToolApprovalReceipt> {
    const { action, descriptor, authorization } = input;
    if (authorization.finalPolicy !== 'ask_user') {
      throw new Error('Tool approval requested for a non-gated action: ' + action.id);
    }

    const approval = {
      id: newId('apr'),
      runId: action.runId,
      stepId: action.stepId,
      question: approvalQuestion(descriptor, action),
      proposedAction: exactActionJson(action),
      reversibility: descriptor.reversibility,
      riskClass: 'ask_human' as const,
      policyRule: 'exact-tool-action-requires-approval',
      status: 'pending' as const,
      createdAt: nowIso(),
    };

    await this.store.createApproval(approval);
    const blockedStep = await this.store.patchStep(action.stepId, {
      status: 'blocked',
      approvalId: approval.id,
    });
    const run = await this.store.patchRun(action.runId, { status: 'awaiting_approval' });
    await this.sessions.setStatusForStep(action.runId, action.stepId, 'awaiting_approval');
    await this.bus.emit(action.runId, { type: 'step.upserted', step: blockedStep });
    await this.bus.emit(action.runId, { type: 'run.updated', run });
    await this.bus.emit(action.runId, { type: 'approval.requested', approval });

    // The exact action, in the shape the deterministic gate classifies. The
    // descriptor's reversibility is passed explicitly so a revision cannot
    // slide the action into a laxer class by changing its arguments.
    const proposed: ProposedAction = {
      kind: 'tool:' + descriptor.id,
      description: approval.question,
      reversibility: descriptor.reversibility,
      payload: approval.proposedAction,
    };
    const outcome = await waitForApproval(approval.id, proposed, signal);

    const resumedRun = await this.store.patchRun(action.runId, { status: 'running' });
    const step = await this.store.patchStep(action.stepId, { status: 'running' });
    await this.sessions.setStatusForStep(action.runId, action.stepId, 'running');
    await this.bus.emit(action.runId, { type: 'run.updated', run: resumedRun });
    await this.bus.emit(action.runId, { type: 'step.upserted', step });

    if (outcome.verdict === 'rejected') throw new ApprovalRejectedError(approval.id);

    if (outcome.verdict === 'revised') {
      return {
        approvalId: approval.id,
        revisedArguments: revisedArgumentsOf(outcome.action.payload, action),
      };
    }
    return { approvalId: approval.id };
  }
}

function approvalQuestion(descriptor: ToolDescriptor, action: ToolAction): string {
  const destination = action.destination ? ' to ' + action.destination : '';
  return 'Allow ' + descriptor.id + destination + '?';
}

function exactActionJson(action: ToolAction): Json {
  const trace = actionForTrace(action);
  return {
    actionId: action.id,
    toolId: action.toolId,
    descriptorVersion: action.descriptorVersion,
    operation: action.operation,
    arguments: trace.arguments,
    destination: action.destination ?? null,
    ...(action.accountRef ? { accountRef: action.accountRef } : {}),
    ...(action.review ? { review: action.review } : {}),
    dataLabels: action.dataLabels,
    ...(action.previewFingerprint ? { previewFingerprint: action.previewFingerprint } : {}),
  };
}

/**
 * Read the edited arguments back out of a revised exact-action payload.
 *
 * Only `arguments` is taken. The tool id, descriptor version and destination
 * are what the authorization was computed against, so accepting client edits to
 * them would let a revision retarget the call instead of narrowing it.
 */
function revisedArgumentsOf(payload: unknown, original: ToolAction): Json {
  if (payload && typeof payload === 'object' && 'arguments' in payload) {
    return (payload as { arguments: Json }).arguments;
  }
  return original.arguments;
}
