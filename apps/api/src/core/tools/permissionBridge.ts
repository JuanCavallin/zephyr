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
  LeaseDecision,
  NativeToolRequest,
  PermissionBridgeSeam,
  PermissionVerdict,
  ToolAction,
  ToolDescriptor,
  ToolLifecycleEvent,
  ToolLifecyclePhase,
  VerifyPolicy,
} from '@htn/shared';
import { DEFAULT_VERIFY_POLICY } from '@htn/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId, nowIso } from '../../lib/ids.js';
import { actionFingerprint } from '../../services/actionEvidence.js';
import { ApprovalRejectedError } from '../approvalGate.js';
import { baselineAuthorization } from '../decisions/service.js';
import { strictestActionPolicy } from '../decisions/eligibility.js';
import type { ToolApprovalGate } from './approval.js';
import { mapNativeTool, nativeDescriptor, UnmappedToolError, type ExactAction } from './nativeDescriptors.js';
import { isTestPath, protectionOf } from '../verify/protectedPaths.js';
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
  /** The lease check's answer, for board-task writes. */
  lease?: LeaseDecision;
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
  /** Step 6 protected paths. Defaults to DEFAULT_VERIFY_POLICY (defaults guarded). */
  verifyPolicy?: Pick<VerifyPolicy, 'protectDefaults' | 'protectedGlobs'>;
  /**
   * Files this run created. The bridge adds new test files it allows; tests and
   * snapshots in the set stay editable without approval.
   */
  runCreated?: Set<string>;
  /** Current content of a worktree file, or null when it does not exist. */
  readWorktreeFile?: (relative: string) => string | null;
  /**
   * Step 7 write leases. When set and the request carries a `taskId` (a board task),
   * every native file write must fall inside that task's lease; a denial carries the
   * lease reason so the agent can request an extension or submit a hot-file intent.
   */
  leases?: PermissionBridgeSeam;
  /**
   * The board task this bridge serves, for requests that do not carry a `taskId`
   * themselves (Claude Code's ACP and hook requests never do).
   */
  taskId?: string;
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
  const verifyPolicy = opts.verifyPolicy ?? DEFAULT_VERIFY_POLICY;
  const runCreated = opts.runCreated ?? new Set<string>();
  const readFile =
    opts.readWorktreeFile ??
    ((relative: string): string | null => {
      try {
        return readFileSync(resolve(opts.worktree, relative), 'utf8');
      } catch {
        return null;
      }
    });

  /** Record a newly created test file once it is allowed, so later edits stay free. */
  function noteCreated(decision: BridgeDecision): void {
    const path = (decision.action?.arguments as Record<string, Json> | undefined)?.path;
    if (decision.verdict === 'allow' && decision.exact?.reasonCodes.includes('new-test-file') && typeof path === 'string') {
      runCreated.add(path.replace(/\\/g, '/'));
    }
  }

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
  ): Promise<{ exact: ExactAction; action: ToolAction; lease?: LeaseDecision } | BridgeDecision> {
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

    // Step 7: a board task writes only inside its lease. Checked before anything is
    // asked of a person: an out-of-lease write is denied, never escalated.
    let lease: LeaseDecision | undefined;
    const taskId = req.taskId ?? opts.taskId;
    if (
      opts.leases &&
      taskId &&
      exact.toolId === 'fs.write' &&
      exact.defaultPolicy !== 'deny' &&
      typeof args.path === 'string'
    ) {
      lease = opts.leases.checkLease(taskId, args.path.replace(/\\/g, '/'), 'write');
      if (!lease.allowed) {
        const reason = 'lease ' + lease.reason + ': ' + lease.message;
        log('deny ' + req.toolName + ': ' + reason);
        return {
          verdict: 'deny',
          policy: 'deny',
          reason,
          lease,
          exact: { ...exact, reasonCodes: [...exact.reasonCodes, 'lease-' + lease.reason] },
        };
      }
    }

    // Step 6: protected paths. An edit to one is irreversible and needs an approval
    // that carries the exact diff; a new test file is allowed and flagged.
    let protectedReview: Json | undefined;
    if (exact.toolId === 'fs.write' && exact.defaultPolicy !== 'deny' && typeof args.path === 'string') {
      const relative = args.path.replace(/\\/g, '/');
      const current = readFile(relative);
      // A file that does not exist yet is the run's own: only always-guarded paths
      // (lockfiles, CI, lint, policy globs) are protected for it.
      const created = current === null ? new Set([...runCreated, relative]) : runCreated;
      const protection = protectionOf(relative, verifyPolicy, created);
      if (protection) {
        exact = {
          ...exact,
          descriptor: nativeDescriptor('fs.write', {
            effect: 'write',
            reversibility: 'irreversible',
            requiresChangeReview: true,
          }),
          defaultPolicy: 'ask_user',
          reasonCodes: [...exact.reasonCodes, 'protected-path', 'protected-' + protection],
        };
        protectedReview = {
          protectedPath: relative,
          protection,
          ...(typeof args.contentSha256 === 'string' ? { contentSha256: args.contentSha256 } : {}),
          diff: protectedWriteDiff(relative, req.rawInput, current),
        };
      } else if (current === null && isTestPath(relative)) {
        exact = { ...exact, reasonCodes: [...exact.reasonCodes, 'new-test-file'] };
      }
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
      ...(protectedReview !== undefined ? { review: protectedReview } : {}),
    };
    action.previewFingerprint = actionFingerprint(action);
    return { exact, action, ...(lease ? { lease } : {}) };
  }

  async function classify(
    req: NativeToolRequest,
    signal?: AbortSignal,
  ): Promise<BridgeDecision> {
    const built = await build(req);
    if ('verdict' in built) return built;
    const { exact, action, lease } = built;
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
      ...(lease ? { lease } : {}),
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
    if (decision.policy !== 'ask_user') {
      noteCreated(decision);
      return decision;
    }

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

/** Review diffs above this are cut; `contentSha256` still binds the exact content. */
const MAX_REVIEW_DIFF_CHARS = 16_000;

function prefixed(text: string, mark: '-' | '+'): string[] {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n').map((line) => mark + line);
}

/**
 * The exact change a protected-path write makes, as a unified-style diff for the
 * reviewer: Edit (old/new string), MultiEdit (edits[]), Write (whole file against the
 * current content), or a raw patch.
 */
export function protectedWriteDiff(path: string, rawInput: unknown, current: string | null): string {
  const fields =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const header = [current === null ? '--- /dev/null' : '--- a/' + path, '+++ b/' + path];
  const body: string[] = [];
  const hunk = (oldText: string, newText: string): void => {
    body.push('@@', ...prefixed(oldText, '-'), ...prefixed(newText, '+'));
  };
  if (typeof fields.patch === 'string') {
    return clip(fields.patch);
  }
  if (typeof fields.old_string === 'string' && typeof fields.new_string === 'string') {
    hunk(fields.old_string, fields.new_string);
    if (fields.replace_all === true) body.push('(replace_all: every occurrence)');
  } else if (Array.isArray(fields.edits)) {
    for (const edit of fields.edits as Record<string, unknown>[]) {
      if (edit && typeof edit.old_string === 'string' && typeof edit.new_string === 'string') {
        hunk(edit.old_string, edit.new_string);
      }
    }
  } else if (typeof fields.content === 'string') {
    hunk(current ?? '', fields.content);
  } else if (typeof fields.new_source === 'string') {
    hunk('', fields.new_source);
  } else {
    body.push('(no textual change in the request: ' + JSON.stringify(Object.keys(fields)) + ')');
  }
  return clip([...header, ...body].join('\n'));
}

function clip(text: string): string {
  return text.length <= MAX_REVIEW_DIFF_CHARS
    ? text
    : text.slice(0, MAX_REVIEW_DIFF_CHARS) + '\n… (' + (text.length - MAX_REVIEW_DIFF_CHARS) + ' more chars; contentSha256 binds the full change)';
}
