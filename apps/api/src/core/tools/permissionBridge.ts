/**
 * Native tool permission bridge.
 *
 *   NativeToolRequest → mapNativeTool → ExactAction → authorize → verdict
 *
 * One path for every harness and every entry point (ACP `session/request_permission`,
 * Claude Code hooks, Hermes). Fails closed:
 *
 *   - an unmapped tool denies;
 *   - the final policy is the STRICTEST of the spec-table default and the
 *     authorizer's policy, so neither can loosen the other;
 *   - `ask_user` with no approval gate denies;
 *   - `git.publish` binds the approval to (branch, diff hash). A different hash is a
 *     different exact action, with a different fingerprint, and needs a new approval.
 *
 * Shell safety is never asked of Jev: the classifier decides; the authorizer only
 * sees the resulting descriptor.
 */

import type {
  ActionPolicy,
  AuthorizationDecision,
  HarnessId,
  Json,
  NativeToolRequest,
  PermissionVerdict,
  ToolAction,
  ToolDescriptor,
  ToolLifecycleEvent,
  ToolLifecyclePhase,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import { actionFingerprint } from '../../services/actionEvidence.js';
import { ApprovalRejectedError } from '../approvalGate.js';
import { baselineAuthorization } from '../decisions/service.js';
import { strictestActionPolicy } from '../decisions/eligibility.js';
import type { ToolApprovalGate } from './approval.js';
import { mapNativeTool, UnmappedToolError, type ExactAction } from './nativeDescriptors.js';
import { hostPlatform, type ShellPlatform } from './pathContainment.js';
import type { ShapedCommandKind } from './shellClassifier.js';

export type Authorizer = (
  descriptor: ToolDescriptor,
  action: ToolAction,
  signal?: AbortSignal,
) => AuthorizationDecision | Promise<AuthorizationDecision>;

export interface PublishBinding {
  branch: string;
  diffHash: string;
}

export interface BridgeDecision {
  verdict: PermissionVerdict;
  policy: ActionPolicy;
  reason: string;
  exact?: ExactAction;
  action?: ToolAction;
  authorization?: AuthorizationDecision;
  approvalId?: string;
  /** True when an earlier approval of the identical action was reused. */
  reusedGrant?: boolean;
}

export interface PermissionBridgeOptions {
  harness: HarnessId;
  worktree: string;
  platform?: ShellPlatform;
  /** Deny raw test/build/lint shell runs in favour of the shaped tools (Step 5 L1). */
  shapedTools?: readonly ShapedCommandKind[];
  /** Run binding. Without it actions carry a synthetic run id and approvals deny. */
  run?: { runId: string; stepId: string; sessionStateId?: string };
  authorize?: Authorizer;
  approvals?: ToolApprovalGate;
  /** Current (branch, diff hash) of the run worktree; required for `git.publish`. */
  publishBinding?: () => Promise<PublishBinding>;
  /** How long an approved exact action may be reused (Claude Code asks twice: hook + ACP). */
  grantTtlMs?: number;
  onLifecycle?: (event: ToolLifecycleEvent) => void | Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

export interface PermissionBridge {
  decide(req: NativeToolRequest, signal?: AbortSignal): Promise<BridgeDecision>;
  /** Classification only: no approval wait, no grants consumed. Used by hooks. */
  preview(req: NativeToolRequest, signal?: AbortSignal): Promise<BridgeDecision>;
  /** Shape usable as an ACP `onPermission` handler. */
  handler(req: NativeToolRequest, signal?: AbortSignal): Promise<PermissionVerdict>;
  /** Record an outcome reported after the fact (PostToolUse). */
  report(
    req: NativeToolRequest,
    phase: 'succeeded' | 'failed',
    detail?: { outputSummary?: string; error?: string },
  ): Promise<void>;
}

const DEFAULT_GRANT_TTL_MS = 2 * 60_000;

/** Inside `git push …`, the remote branch named last; falls back to the run branch. */
export function pushedBranch(command: string, fallback: string): string {
  const m = /\bpush\b(.*)$/.exec(command);
  if (!m) return fallback;
  const words = m[1]!.trim().split(/\s+/).filter((w) => w && !w.startsWith('-'));
  const ref = words[1];
  if (!ref) return fallback;
  return ref.includes(':') ? ref.split(':').pop()! || fallback : ref;
}

export function createPermissionBridge(opts: PermissionBridgeOptions): PermissionBridge {
  const platform = opts.platform ?? hostPlatform();
  const authorize: Authorizer = opts.authorize ?? ((d, a) => baselineAuthorization(d, a, nowIso()));
  const ttl = opts.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  const clock = opts.now ?? Date.now;
  const grants = new Map<string, { approvalId: string; expiresAt: number }>();
  const log = opts.log ?? (() => {});

  async function emit(
    phase: ToolLifecyclePhase,
    action: ToolAction,
    extra: Partial<ToolLifecycleEvent> = {},
  ): Promise<void> {
    if (!opts.onLifecycle || !opts.run) return;
    try {
      await opts.onLifecycle({
        id: newId('tle'),
        runId: action.runId,
        stepId: action.stepId,
        sessionStateId: opts.run.sessionStateId ?? '',
        phase,
        action,
        at: nowIso(),
        ...extra,
      });
    } catch (error) {
      log('lifecycle emit failed: ' + (error as Error).message);
    }
  }

  async function build(
    req: NativeToolRequest,
  ): Promise<{ exact: ExactAction; action: ToolAction } | BridgeDecision> {
    let exact: ExactAction;
    try {
      exact = mapNativeTool(req, {
        worktree: opts.worktree,
        platform,
        ...(opts.shapedTools?.length ? { shapedTools: opts.shapedTools } : {}),
      });
    } catch (error) {
      const reason =
        error instanceof UnmappedToolError ? error.message : 'mapping failed: ' + (error as Error).message;
      log('deny ' + req.toolName + ': ' + reason);
      return { verdict: 'deny', policy: 'deny', reason };
    }

    let args = exact.arguments as Record<string, Json>;
    if (exact.toolId === 'git.publish') {
      if (!opts.publishBinding) {
        return { verdict: 'deny', policy: 'deny', reason: 'git.publish without a workspace binding', exact };
      }
      let binding: PublishBinding;
      try {
        binding = await opts.publishBinding();
      } catch (error) {
        return {
          verdict: 'deny',
          policy: 'deny',
          reason: 'git.publish binding failed: ' + (error as Error).message,
          exact,
        };
      }
      const command = String(args.command ?? '');
      args = {
        ...args,
        branch: exact.operation === 'push' ? pushedBranch(command, binding.branch) : binding.branch,
        diffHash: binding.diffHash,
      };
      exact = { ...exact, arguments: args };
    }

    const action: ToolAction = {
      id: newId('act'),
      runId: opts.run?.runId ?? 'unbound',
      stepId: opts.run?.stepId ?? 'unbound',
      toolId: exact.toolId,
      descriptorVersion: exact.descriptor.version,
      operation: exact.operation,
      arguments: args,
      destination: exact.destination,
      dataLabels: exact.dataLabels,
      createdAt: nowIso(),
      ...(exact.toolId === 'git.publish'
        ? { review: { operation: exact.operation, branch: args.branch!, diffHash: args.diffHash! } }
        : {}),
    };
    action.previewFingerprint = actionFingerprint(action);
    return { exact, action };
  }

  async function classify(
    req: NativeToolRequest,
    signal?: AbortSignal,
  ): Promise<BridgeDecision> {
    const built = await build(req);
    if ('verdict' in built) return built;
    const { exact, action } = built;
    let authorization: AuthorizationDecision;
    try {
      authorization = await authorize(exact.descriptor, action, signal);
    } catch (error) {
      return {
        verdict: 'deny',
        policy: 'deny',
        reason: 'authorization failed: ' + (error as Error).message,
        exact,
        action,
      };
    }
    const policy = strictestActionPolicy(exact.defaultPolicy, authorization.finalPolicy);
    const final: AuthorizationDecision = {
      ...authorization,
      finalPolicy: policy,
      allowed: policy === 'auto' || policy === 'verify',
      reasonCodes: [...new Set([...exact.reasonCodes, ...authorization.reasonCodes])],
    };
    return {
      verdict: final.allowed ? 'allow' : 'deny',
      policy,
      reason: exact.reasonCodes.join(', '),
      exact,
      action,
      authorization: final,
    };
  }

  function liveGrant(fingerprint: string): string | undefined {
    const grant = grants.get(fingerprint);
    if (!grant) return undefined;
    if (grant.expiresAt <= clock()) {
      grants.delete(fingerprint);
      return undefined;
    }
    return grant.approvalId;
  }

  async function decide(
    req: NativeToolRequest,
    signal?: AbortSignal,
  ): Promise<BridgeDecision> {
    const decision = await classify(req, signal);
    const { action, exact, authorization } = decision;
    if (!action || !exact || !authorization) return decision;

    await emit('proposed', action);
    await emit('policy_decided', action, { authorization });

    if (decision.policy === 'deny') {
      await emit('blocked', action, {
        authorization,
        outcome: 'not_executed',
        error: { code: 'DENIED', message: decision.reason },
      });
      return decision;
    }
    if (decision.policy !== 'ask_user') return decision;

    const fingerprint = action.previewFingerprint!;
    const reused = liveGrant(fingerprint);
    if (reused) {
      await emit('approved', action, { authorization, approvalId: reused });
      return { ...decision, verdict: 'allow', approvalId: reused, reusedGrant: true };
    }

    if (!opts.approvals || !opts.run) {
      const reason = 'approval required but no approval gate is bound';
      await emit('blocked', action, {
        authorization,
        outcome: 'not_executed',
        error: { code: 'NO_APPROVAL_GATE', message: reason },
      });
      return { ...decision, verdict: 'deny', reason };
    }

    await emit('awaiting_approval', action, { authorization });
    try {
      const receipt = await opts.approvals.request({ action, descriptor: exact.descriptor, authorization }, signal);
      if (receipt.revisedArguments !== undefined) {
        // A revision is a new action; the harness re-proposes it and it is authorized
        // again from scratch. No grant is recorded for the original.
        await emit('approved', action, { authorization, approvalId: receipt.approvalId });
        return {
          ...decision,
          verdict: { revise: receipt.revisedArguments },
          approvalId: receipt.approvalId,
          reason: 'approved with revision',
        };
      }
      grants.set(fingerprint, { approvalId: receipt.approvalId, expiresAt: clock() + ttl });
      await emit('approved', action, { authorization, approvalId: receipt.approvalId });
      return { ...decision, verdict: 'allow', approvalId: receipt.approvalId, reason: 'approved' };
    } catch (error) {
      const rejected = error instanceof ApprovalRejectedError;
      const reason = rejected ? 'rejected by reviewer' : 'approval failed: ' + (error as Error).message;
      await emit('blocked', action, {
        authorization,
        outcome: 'not_executed',
        error: { code: rejected ? 'REJECTED' : 'APPROVAL_FAILED', message: reason },
      });
      return { ...decision, verdict: 'deny', reason };
    }
  }

  return {
    decide,
    async preview(req, signal) {
      const decision = await classify(req, signal);
      if (decision.policy === 'ask_user' && decision.action) {
        const reused = liveGrant(decision.action.previewFingerprint!);
        if (reused) return { ...decision, verdict: 'allow', approvalId: reused, reusedGrant: true };
      }
      return decision;
    },
    async handler(req, signal) {
      return (await decide(req, signal)).verdict;
    },
    async report(req, phase, detail = {}) {
      const built = await build(req);
      if ('verdict' in built) return;
      await emit(phase, built.action, {
        outcome: phase === 'succeeded' ? 'completed' : 'unknown',
        ...(detail.outputSummary ? { outputSummary: detail.outputSummary.slice(0, 500) } : {}),
        ...(detail.error ? { error: { code: 'TOOL_FAILED', message: detail.error.slice(0, 500) } } : {}),
      });
    },
  };
}
