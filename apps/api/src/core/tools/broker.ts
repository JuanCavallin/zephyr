import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  AgentSessionState,
  AuthorizationDecision,
  ContentAnalysisAdapter,
  DataLabel,
  Json,
  ProviderCallContext,
  ToolAction,
  ToolDescriptor,
  ToolLifecycleEvent,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { RunBus } from '../bus.js';
import { baselineAuthorization, type DecisionService } from '../decisions/service.js';
import { decisionStateFromSession } from '../sessions/decisionState.js';
import type { SessionStateService } from '../sessions/service.js';
import type { ToolApprovalGate } from './approval.js';
import { checkOutboundText } from './contentCheck.js';
import type { ToolExecutorRegistry, ToolExecutionOutput } from './executors.js';
import { modelToolText, PreparedActionReviewRequiredError } from './executors.js';
import type { RegisteredTool, ToolRegistry } from './registry.js';
import {
  actionEvidenceStore,
  actionFingerprint,
  actionForTrace,
} from '../../services/actionEvidence.js';
import { KeyedLock } from '../locks.js';
import { waitWhilePaused } from '../pauseGate.js';

const mutationLocks = new KeyedLock();

export type ToolBrokerErrorCode =
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_NOT_SELECTED'
  | 'TOOL_VERSION_CHANGED'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_SCOPE_MISSING'
  | 'TOOL_SCHEMA_INVALID'
  | 'TOOL_ARGUMENTS_INVALID'
  | 'TOOL_EXECUTOR_UNAVAILABLE'
  | 'TOOL_DESTINATION_UNKNOWN'
  | 'TOOL_ACTION_DENIED'
  | 'TOOL_APPROVAL_UNAVAILABLE'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_EXECUTION_UNKNOWN'
  | 'TOOL_VERIFICATION_FAILED';

export class ToolBrokerError extends Error {
  constructor(
    readonly code: ToolBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolBrokerError';
  }
}

export interface ToolExecutionRequest {
  sessionStateId: string;
  /** Captured by the authenticated gateway, not by the model. */
  expectedTurn?: number;
  toolId: string;
  arguments: Json;
  /** Labels may be added for a particular payload, but session labels cannot be removed. */
  dataLabels?: DataLabel[];
  signal?: AbortSignal;
  /** Trusted graph author explicitly requested a submit/approval boundary. */
  forceApproval?: boolean;
}

export interface ToolBrokerResult extends ToolExecutionOutput {
  action: ToolAction;
  authorization: AuthorizationDecision;
  approvalId?: string;
}

export interface ToolBrokerOptions {
  approvalGate?: ToolApprovalGate;
  ajv?: Ajv;
  /**
   * Optional outbound-text authenticity check. Advisory and ESCALATE-ONLY:
   * see core/tools/contentCheck.ts. Omitting it disables the check entirely
   * rather than blocking, which is why it is not required to construct a broker.
   */
  contentCheck?: { analysis: ContentAnalysisAdapter; threshold?: number };
}

/**
 * The only sanctioned execution path for harness-requested tools. Every call is
 * checked against the selected descriptor and exact arguments immediately
 * before the registered executor runs. Every failure is fail-closed.
 */
export class ToolBroker {
  private readonly approvalGate?: ToolApprovalGate;
  private readonly contentCheck?: ToolBrokerOptions['contentCheck'];
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executors: ToolExecutorRegistry,
    private readonly decisions: DecisionService,
    private readonly sessions: SessionStateService,
    private readonly bus: RunBus,
    options: ToolBrokerOptions = {},
  ) {
    this.approvalGate = options.approvalGate;
    this.contentCheck = options.contentCheck;
    this.ajv = options.ajv ?? new Ajv({ allErrors: true, strict: true });
  }

  async execute(request: ToolExecutionRequest): Promise<ToolBrokerResult> {
    const session = await this.sessions.get(request.sessionStateId);
    if (!session) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'Agent session state not found: ' + request.sessionStateId,
      );
    }
    await waitWhilePaused(session.runId, request.signal);
    if (request.signal?.aborted)
      throw new ToolBrokerError('TOOL_ACTION_DENIED', 'Tool call cancelled.');
    if (request.expectedTurn !== undefined && request.expectedTurn !== session.turn) {
      throw new ToolBrokerError('TOOL_NOT_SELECTED', 'Stale gateway turn.');
    }

    const registered = await this.registry.get(request.toolId);
    if (!registered) {
      throw new ToolBrokerError('TOOL_NOT_REGISTERED', 'Unknown tool: ' + request.toolId);
    }
    const exactArguments = deepFreeze(
      bindBrowserResource(session, registered.descriptor.id, request.arguments),
    );
    if (Buffer.byteLength(JSON.stringify(exactArguments)) > 128_000)
      throw new ToolBrokerError(
        'TOOL_ARGUMENTS_INVALID',
        'Tool payload exceeds the bounded action budget.',
      );
    this.assertSelected(session, registered.descriptor);
    this.assertAvailable(registered.descriptor);
    this.assertScopes(registered);
    this.validateArguments(registered, exactArguments);

    const executor = this.executors.resolve(registered.descriptor.executorRef);
    if (!executor) {
      throw new ToolBrokerError(
        'TOOL_EXECUTOR_UNAVAILABLE',
        'No executor is registered for ' + registered.descriptor.executorRef,
      );
    }
    const destination = executor.destinationFor({
      descriptor: registered.descriptor,
      arguments: exactArguments,
    });
    if (!destination) {
      throw new ToolBrokerError(
        'TOOL_DESTINATION_UNKNOWN',
        'The exact destination could not be resolved before authorization.',
      );
    }

    // Reassigned when a human revises the payload; the revision replaces this
    // and is reauthorized before anything executes.
    let action = deepFreeze<ToolAction>({
      id: newId('act'),
      runId: session.runId,
      stepId: session.stepId,
      toolId: registered.descriptor.id,
      descriptorVersion: registered.descriptor.version,
      operation: registered.descriptor.id,
      arguments: exactArguments,
      destination,
      ...(registered.descriptor.accountRef ? { accountRef: registered.descriptor.accountRef } : {}),
      dataLabels: mergeLabels(session.dataLabels, request.dataLabels ?? []),
      createdAt: nowIso(),
    });
    const callContext: ProviderCallContext = {
      runId: session.runId,
      stepId: session.stepId,
      policyRule: 'exact-tool-action-authorization',
      signal: request.signal,
    };
    // An executor that prepares a review (a browser target) is authorized by
    // Jev once, AFTER preparation, when the exact target is known. Before it,
    // only the descriptor policy runs, so a hard deny still skips preparation.
    let authorization = executor.prepareReview
      ? baselineAuthorization(registered.descriptor, action, nowIso())
      : await this.decisions.authorizeAction(
          decisionStateFromSession(session),
          action,
          registered.descriptor,
          callContext,
        );
    try {
      for (;;) {
        let preparedRequiresApproval = false;
        if (executor.prepareReview && authorization.finalPolicy !== 'deny') {
          // An independent read authorization covers observation for review, not
          // the pending write. The preparation contract forbids side effects.
          const readDescriptor = {
            ...registered.descriptor,
            baselineEffect: 'read' as const,
            reversibility: 'reversible' as const,
            requiresChangeReview: false,
          };
          const readAction = {
            ...action,
            id: newId('act'),
            operation: action.operation + '.review_read',
          };
          const readPolicy = await this.decisions.authorizeAction(
            { ...decisionStateFromSession(session), sanitizedForRemote: false },
            readAction,
            readDescriptor,
            { ...callContext, policyRule: 'prepare-exact-action-review' },
          );
          if (readPolicy.finalPolicy === 'deny')
            throw new ToolBrokerError(
              'TOOL_ACTION_DENIED',
              'Page observation for review is not permitted.',
            );
          if (!readPolicy.allowed) {
            if (!this.approvalGate || readPolicy.finalPolicy !== 'ask_user')
              throw new ToolBrokerError(
                'TOOL_APPROVAL_UNAVAILABLE',
                'Human review is required before page observation.',
              );
            await this.approvalGate.request(
              { action: readAction, descriptor: readDescriptor, authorization: readPolicy },
              request.signal,
            );
          }
          const prepared = await executor.prepareReview(action, callContext);
          action = deepFreeze({ ...action, review: prepared.review });
          preparedRequiresApproval = prepared.requiresApproval;
          authorization = await this.decisions.authorizeAction(
            decisionStateFromSession(session),
            action,
            registered.descriptor,
            callContext,
          );
        }
        action = deepFreeze({ ...action, previewFingerprint: actionFingerprint(action) });
        const proposedEvidence = actionEvidenceStore.proposed(action, registered.descriptor);
        if (
          (registered.descriptor.requiresChangeReview || request.forceApproval) &&
          actionEvidenceStore.preview(action.runId, proposedEvidence.previewRef!)?.truncated
        ) {
          actionEvidenceStore.retireExactAction(action.runId, action.id);
          throw new ToolBrokerError(
            'TOOL_ARGUMENTS_INVALID',
            'The proposed change exceeds the complete preview budget. Narrow the edit before requesting approval.',
          );
        }
        await this.emit(session, action, 'proposed', { evidence: proposedEvidence });
        await this.bus.emit(session.runId, {
          type: 'harness.turn',
          turn: {
            id: newId('turn'),
            runId: session.runId,
            sessionId: session.harnessSessionId ?? session.id,
            turnId: (session.harnessSessionId ?? session.id) + ':' + session.turn,
            phase: 'tool_proposed',
            payload: { actionId: action.id, toolId: action.toolId },
            at: nowIso(),
          },
        });

        if (
          (request.forceApproval || preparedRequiresApproval) &&
          authorization.finalPolicy !== 'deny'
        )
          authorization = {
            ...authorization,
            allowed: false,
            finalPolicy: 'ask_user',
            reasonCodes: [
              ...authorization.reasonCodes,
              preparedRequiresApproval
                ? 'prepared-target-requires-approval'
                : 'explicit-submit-requires-approval',
            ],
          };
        await this.emit(session, action, 'policy_decided', { authorization });
        await this.bus.emit(session.runId, {
          type: 'control.decided',
          decision: {
            id: newId('ctl'),
            runId: session.runId,
            stepId: session.stepId,
            operation: 'recommend_action_policy',
            candidateIds: ['auto', 'verify', 'ask_user', 'deny'],
            selectedIds: [authorization.finalPolicy],
            confidence: authorization.recommendation.confidence,
            reasonCodes: authorization.reasonCodes,
            source: 'deterministic',
            at: nowIso(),
          },
        });

        // Outbound-text authenticity. Runs AFTER authorization because it is not an
        // authorization: it can only take a policy the gate already settled on and
        // make it stricter. A failure here leaves the policy untouched, so a GPTZero
        // outage cannot block an action the gate permitted. See contentCheck.ts.
        if (this.contentCheck) {
          const checked = await checkOutboundText(
            this.contentCheck.analysis,
            action,
            registered.descriptor,
            authorization.finalPolicy,
            callContext,
            { threshold: this.contentCheck.threshold },
          );

          if (checked.outcome !== 'skipped') {
            await this.bus.emit(session.runId, {
              type: 'control.decided',
              decision: {
                id: newId('ctl'),
                runId: session.runId,
                stepId: session.stepId,
                operation: 'check_outbound_text',
                candidateIds: ['passed', 'escalated', 'unavailable'],
                selectedIds: [checked.outcome],
                // The score IS the confidence here: P(ai) is what the check measured.
                confidence: checked.score ?? 0,
                reasonCodes: checked.reasonCodes,
                source: 'deterministic',
                at: nowIso(),
              },
            });
          }

          if (checked.policy !== authorization.finalPolicy) {
            authorization = {
              ...authorization,
              finalPolicy: checked.policy,
              reasonCodes: [...authorization.reasonCodes, ...checked.reasonCodes],
            };
            await this.emit(session, action, 'policy_decided', { authorization });
          }
        }

        if (authorization.finalPolicy === 'deny') {
          await this.emit(session, action, 'blocked', {
            authorization,
            error: { code: 'TOOL_ACTION_DENIED', message: 'Exact tool action was denied.' },
          });
          throw new ToolBrokerError('TOOL_ACTION_DENIED', 'Exact tool action was denied.');
        }

        let approvalId: string | undefined;
        if (authorization.finalPolicy === 'ask_user') {
          if (!this.approvalGate) {
            await this.emit(session, action, 'blocked', {
              authorization,
              error: {
                code: 'TOOL_APPROVAL_UNAVAILABLE',
                message: 'No approval gate is configured.',
              },
            });
            throw new ToolBrokerError(
              'TOOL_APPROVAL_UNAVAILABLE',
              'No approval gate is configured; refusing tool execution.',
            );
          }
          await this.emit(session, action, 'awaiting_approval', { authorization });
          let receipt;
          try {
            receipt = await this.approvalGate.request(
              { action, descriptor: registered.descriptor, authorization },
              request.signal,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Tool approval failed.';
            await this.emit(session, action, 'blocked', {
              authorization,
              error: { code: 'TOOL_ACTION_DENIED', message },
            });
            throw error;
          }
          approvalId = receipt.approvalId;

          // A revision is a DIFFERENT action, so it goes through the same gate the
          // original did: schema validation, destination resolution, and a second
          // authorizeAction. Skipping any of these would make "revise" the one way
          // to get an unauthorized payload executed.
          if (receipt.revisedArguments !== undefined) {
            const revisedArguments = deepFreeze(structuredClone(receipt.revisedArguments));
            this.validateArguments(registered, revisedArguments);
            assertRevisionTargetUnchanged(action.arguments, revisedArguments);

            const revisedDestination = executor.destinationFor({
              descriptor: registered.descriptor,
              arguments: revisedArguments,
            });
            if (revisedDestination !== destination) {
              const message =
                'A revision may not change the destination (' +
                destination +
                ' -> ' +
                String(revisedDestination) +
                ').';
              await this.emit(session, action, 'blocked', {
                authorization,
                approvalId,
                error: { code: 'TOOL_ACTION_DENIED', message },
              });
              throw new ToolBrokerError('TOOL_ACTION_DENIED', message);
            }

            action = deepFreeze<ToolAction>({ ...action, arguments: revisedArguments });
            if (executor.prepareReview) {
              const prepared = await executor.prepareReview(action, callContext);
              // A changed prepared target must be reviewed again, never blessed by
              // the old argument revision's receipt.
              if (JSON.stringify(prepared.review) !== JSON.stringify(action.review)) {
                action = deepFreeze({ ...action, review: prepared.review });
                authorization = { ...authorization, allowed: false, finalPolicy: 'ask_user' };
                continue;
              }
            }
            action = deepFreeze({ ...action, previewFingerprint: actionFingerprint(action) });
            const revisedEvidence = actionEvidenceStore.proposed(action, registered.descriptor);
            await this.emit(session, action, 'proposed', {
              authorization,
              approvalId,
              evidence: revisedEvidence,
            });

            if (actionEvidenceStore.preview(action.runId, revisedEvidence.previewRef!)?.truncated)
              throw new ToolBrokerError(
                'TOOL_ARGUMENTS_INVALID',
                'Revised change exceeds the complete preview budget.',
              );
            authorization = await this.decisions.authorizeAction(
              decisionStateFromSession(session),
              action,
              registered.descriptor,
              { ...callContext, policyRule: 'revised-tool-action-reauthorization' },
            );
            await this.emit(session, action, 'policy_decided', { authorization, approvalId });

            // The human just approved this edited payload; policy may still require
            // that receipt. Deterministic denials and missing authorization block.
            if (
              authorization.finalPolicy === 'deny' ||
              (!authorization.allowed && authorization.finalPolicy !== 'ask_user')
            ) {
              const message = 'The revised tool action was not authorized.';
              await this.emit(session, action, 'blocked', {
                authorization,
                approvalId,
                error: { code: 'TOOL_ACTION_DENIED', message },
              });
              throw new ToolBrokerError('TOOL_ACTION_DENIED', message);
            }
            authorization = {
              ...authorization,
              allowed: true,
              reasonCodes: [...authorization.reasonCodes, 'human-approved-revised-exact-action'],
            };
          }
          authorization = {
            ...authorization,
            allowed: true,
            reasonCodes: [...authorization.reasonCodes, 'human-approved-exact-action'],
          };
          await this.emit(session, action, 'approved', { authorization, approvalId });
        } else if (!authorization.allowed) {
          throw new ToolBrokerError(
            'TOOL_ACTION_DENIED',
            'Authorization did not explicitly allow execution.',
          );
        }

        await waitWhilePaused(session.runId, request.signal);
        const currentSession = await this.sessions.get(session.id);
        if (
          !currentSession ||
          currentSession.turn !== session.turn ||
          !['created', 'running', 'awaiting_approval'].includes(currentSession.status)
        ) {
          throw new ToolBrokerError(
            'TOOL_NOT_SELECTED',
            'The authorized turn is no longer active.',
          );
        }
        this.assertSelected(currentSession, registered.descriptor);
        if (request.signal?.aborted)
          throw new ToolBrokerError('TOOL_ACTION_DENIED', 'Tool call cancelled.');
        await this.emit(session, action, 'executing', { authorization, approvalId });
        let executed: ToolExecutionOutput;
        const release =
          registered.descriptor.baselineEffect !== 'read'
            ? await mutationLocks.acquire(
                registered.descriptor.credentialRef + ':' + destination,
                request.signal,
              )
            : undefined;
        let dispatched = false;
        try {
          await waitWhilePaused(session.runId, request.signal);
          const dispatchSession = await this.sessions.get(session.id);
          if (
            !dispatchSession ||
            dispatchSession.turn !== session.turn ||
            !['created', 'running', 'awaiting_approval'].includes(dispatchSession.status)
          )
            throw new Error('The authorized turn is no longer active.');
          this.assertSelected(dispatchSession, registered.descriptor);
          const currentTool = await this.registry.get(action.toolId);
          if (
            !currentTool ||
            currentTool.descriptor.version !== action.descriptorVersion ||
            currentTool.descriptor.executorRef !== registered.descriptor.executorRef ||
            currentTool.descriptor.accountRef !== action.accountRef
          )
            throw new Error('Tool descriptor changed after review; request a fresh action.');
          this.assertAvailable(currentTool.descriptor);
          this.assertScopes(currentTool);
          if (dispatchSession.dataLabels.some((label) => !action.dataLabels.includes(label)))
            throw new Error('Session privacy tightened after review; request fresh authorization.');
          if (action.previewFingerprint !== actionFingerprint(action))
            throw new Error('Reviewed payload changed before execution.');
          if (executor.validateResourceVersion)
            await executor.validateResourceVersion(action, callContext);
          dispatched = true;
          executed = await executor.execute(action, {
            ...callContext,
            sessionStateId: session.id,
            policyRule: approvalId ? 'human-approved-exact-tool-action' : 'authorized-tool-action',
          });
        } catch (error) {
          if (
            error instanceof PreparedActionReviewRequiredError &&
            executor.prepareReview &&
            !request.signal?.aborted
          ) {
            authorization = {
              ...authorization,
              allowed: false,
              finalPolicy: 'ask_user',
              reasonCodes: [...authorization.reasonCodes, 'prepared-target-changed'],
            };
            // The executor certifies no mutation occurred. Stay inside the SAME
            // tool call and await a fresh human decision, avoiding model retries.
            continue;
          }
          const message = error instanceof Error ? error.message : 'Tool executor failed.';
          const unknown =
            dispatched &&
            registered.descriptor.baselineEffect !== 'read' &&
            registered.descriptor.transport !== 'local';
          const code = unknown ? 'TOOL_EXECUTION_UNKNOWN' : 'TOOL_EXECUTION_FAILED';
          await this.emit(session, action, 'failed', {
            authorization,
            approvalId,
            outcome: unknown ? 'unknown' : dispatched ? 'partial' : 'not_executed',
            error: {
              code,
              message: unknown
                ? 'Provider write outcome is unknown. Check the resource before retrying. ' +
                  message
                : message,
            },
          });
          throw new ToolBrokerError(code, message);
        } finally {
          release?.();
        }

        if (authorization.finalPolicy === 'verify' && executed.verified !== true) {
          await this.emit(session, action, 'failed', {
            authorization,
            approvalId,
            error: {
              code: 'TOOL_VERIFICATION_FAILED',
              message: 'Executor did not verify a policy-required result.',
            },
          });
          throw new ToolBrokerError(
            'TOOL_VERIFICATION_FAILED',
            'Executor did not verify a policy-required result.',
          );
        }

        const outputSummary = compactSummary(executed.summary);
        const outputLabels = mergeLabels(action.dataLabels, executed.dataLabels);
        executed = { ...executed, dataLabels: outputLabels };
        const sanitizedSummary =
          executed.sanitizedSummary && outputLabels.every((label) => label === 'public')
            ? compactSummary(modelToolText(executed))
            : undefined;
        await this.sessions.appendContext(session.id, [
          {
            role: 'tool',
            summary: outputSummary,
            sanitizedSummary,
            dataLabels: outputLabels,
          },
        ]);
        await this.emit(session, action, 'succeeded', {
          authorization,
          approvalId,
          outputSummary,
          evidence: actionEvidenceStore.completed(
            { ...action, dataLabels: outputLabels },
            executed,
          ),
          outcome: 'completed',
        });
        const { executedPreview: _humanOnlyPreview, ...modelResult } = executed;
        return { ...modelResult, action, authorization, approvalId };
      }
    } finally {
      executor.discardPrepared?.(action.id);
    }
  }

  private assertSelected(session: AgentSessionState, descriptor: ToolDescriptor): void {
    if (session.toolCeiling !== undefined && !session.toolCeiling.includes(descriptor.id)) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'Tool exceeds this context capability ceiling.',
      );
    }
    const grant = session.activeToolExposureGrant;
    if (!grant || grant.sessionStateId !== session.id || grant.turn !== session.turn) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'No active tool exposure grant exists for this turn: ' + descriptor.id,
      );
    }
    const selectedVersion = grant.selectedToolVersions[descriptor.id];
    if (!selectedVersion) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'Tool was not selected by the active model call: ' + descriptor.id,
      );
    }
    if (!selectedVersion || selectedVersion !== descriptor.version) {
      throw new ToolBrokerError(
        'TOOL_VERSION_CHANGED',
        'Tool descriptor version is not the version selected for this session.',
      );
    }
  }

  private assertAvailable(descriptor: ToolDescriptor): void {
    if (
      descriptor.availability !== 'available' ||
      descriptor.baselineEffect === 'unknown' ||
      descriptor.simulated
    ) {
      throw new ToolBrokerError(
        'TOOL_UNAVAILABLE',
        'Tool is unavailable, unclassified, or simulated: ' + descriptor.id,
      );
    }
  }

  private assertScopes(registered: RegisteredTool): void {
    const missing = registered.descriptor.requiredScopes.filter(
      (scope) => !registered.grantedScopes.includes(scope),
    );
    if (missing.length > 0) {
      throw new ToolBrokerError(
        'TOOL_SCOPE_MISSING',
        'Tool connection is missing required scopes: ' + missing.join(', '),
      );
    }
  }

  private validateArguments(registered: RegisteredTool, value: Json): void {
    const key = registered.descriptor.id + '@' + registered.descriptor.version;
    let validate = this.validators.get(key);
    if (!validate) {
      try {
        validate = this.ajv.compile(structuredClone(registered.inputSchema) as AnySchema);
        this.validators.set(key, validate);
      } catch (error) {
        throw new ToolBrokerError(
          'TOOL_SCHEMA_INVALID',
          'Trusted schema is invalid for ' +
            registered.descriptor.id +
            ': ' +
            (error instanceof Error ? error.message : 'unknown schema error'),
        );
      }
    }
    if (!validate(value)) {
      throw new ToolBrokerError(
        'TOOL_ARGUMENTS_INVALID',
        'Tool arguments failed validation: ' + summarizeValidationErrors(validate.errors),
      );
    }
  }

  private async emit(
    session: AgentSessionState,
    action: ToolAction,
    phase: ToolLifecycleEvent['phase'],
    details: Pick<
      ToolLifecycleEvent,
      'authorization' | 'approvalId' | 'outputSummary' | 'error' | 'evidence' | 'outcome'
    > = {},
  ): Promise<void> {
    if (phase === 'blocked' || phase === 'failed')
      actionEvidenceStore.retireExactAction(action.runId, action.id);
    await this.bus.emit(session.runId, {
      type: 'tool.lifecycle',
      lifecycle: {
        id: newId('tool_evt'),
        runId: session.runId,
        stepId: session.stepId,
        sessionStateId: session.id,
        phase,
        action: actionForTrace(action),
        ...details,
        at: nowIso(),
      },
    });
  }
}

function mergeLabels(base: DataLabel[], additions: DataLabel[]): DataLabel[] {
  return [...new Set<DataLabel>([...base, ...additions])];
}

/**
 * A graph can bind one browser resource to an agent task. This is a server-side
 * capability binding: it is injected into the exact action before validation
 * and authorization, so a model cannot omit it, replace it, or open a second
 * browser and silently continue there.
 */
function bindBrowserResource(
  session: AgentSessionState,
  toolId: string,
  argumentsValue: Json,
): Json {
  const bound = session.boundBrowserSessionId;
  const isBrowser =
    toolId.startsWith('browserbase.') ||
    toolId.startsWith('localbrowser.') ||
    toolId.startsWith('browserless.');
  if (bound === undefined || !isBrowser) {
    return structuredClone(argumentsValue);
  }
  if (bound.trim().length === 0) {
    throw new ToolBrokerError('TOOL_NOT_SELECTED', 'The browser resource binding is empty.');
  }

  const operation = toolId.slice(toolId.lastIndexOf('.') + 1);
  if (operation === 'open' || operation === 'search' || operation === 'read') {
    throw new ToolBrokerError(
      'TOOL_NOT_SELECTED',
      'This agent task is bound to an existing browser session; ' +
        operation +
        ' cannot create or use a separate session.',
    );
  }
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new ToolBrokerError(
      'TOOL_ARGUMENTS_INVALID',
      'Bound browser actions require object arguments.',
    );
  }

  const args = structuredClone(argumentsValue) as Record<string, Json>;
  const supplied = args.sessionId;
  if (supplied !== undefined && supplied !== bound) {
    throw new ToolBrokerError(
      'TOOL_NOT_SELECTED',
      'Browser action attempted to use a session outside the task resource binding.',
    );
  }
  args.sessionId = bound;
  return args;
}

function compactSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(tool completed without a summary)';
  return normalized.length <= 320 ? normalized : normalized.slice(0, 317) + '...';
}

function summarizeValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'unknown validation error';
  return errors
    .slice(0, 3)
    .map((error) => {
      const additionalProperty =
        error.keyword === 'additionalProperties' &&
        typeof error.params.additionalProperty === 'string'
          ? ' "' + error.params.additionalProperty + '"'
          : '';
      return (error.instancePath || '/') + ' ' + error.message + additionalProperty;
    })
    .join('; ');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRevisionTargetUnchanged(original: Json, revised: Json): void {
  if (
    !original ||
    typeof original !== 'object' ||
    Array.isArray(original) ||
    !revised ||
    typeof revised !== 'object' ||
    Array.isArray(revised)
  )
    return;
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
    if (JSON.stringify(original[key]) !== JSON.stringify(revised[key]))
      throw new ToolBrokerError(
        'TOOL_ACTION_DENIED',
        'Revision cannot change the reviewed target or version (' + key + ').',
      );
  }
}
