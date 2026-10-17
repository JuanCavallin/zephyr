import type {
  BrowserAdapter,
  BrowserBackend,
  BrowserOperation,
  DataLabel,
  ElementTable,
  Json,
  ProviderCallContext,
  ToolAction,
} from '@htn/shared';
import { BROWSERBASE_API_DESTINATION, LOCAL_BROWSER_DESTINATION } from '@htn/shared';
import { config } from '../../config.js';
import type { BrowserDecider } from './browserDecision.js';
import type { BrowserDecision } from './browserDecision.js';
import { LOW_CONFIDENCE_THRESHOLD } from './browserDecision.js';
import {
  PreparedActionReviewRequiredError,
  type ToolExecutionOutput,
  type ToolExecutor,
} from './executors.js';
import { browserLocation } from '../../providers/browserSafety.js';
import { consequentialBrowserAction } from './browserRisk.js';

export const BROWSER_EXECUTOR_REF = 'native://browser';

/** Adapter refusals meaning "the page moved since the snapshot"; nothing was clicked. */
const STALE_TARGET = new Set([
  'stale_snapshot',
  'unknown_index',
  'wrong_operation',
  'detached',
  'not_interactable',
  'occluded',
]);

export interface BrowserExecutorDeps {
  byId?(providerId: BrowserBackend): BrowserAdapter;
  provider(capability: 'browser' | 'browser.local'): BrowserAdapter;
  decide: BrowserDecider;
  maxElements?: number;
  /**
   * Told when a session that outlives one tool call opens or closes: an
   * explicit `open`, or the pooled research session. The dashboard lists only
   * announced sessions, so without this a browser the agent drove was
   * invisible there. Sessions opened and closed inside one call are not sent.
   */
  onSession?(event: BrowserSessionEvent): void | Promise<void>;
}

export type BrowserSessionEvent =
  | {
      phase: 'opened';
      runId: string;
      stepId?: string;
      sessionId: string;
      providerId: BrowserBackend;
      interactive: boolean;
      mode: BrowserAdapter['mode'];
    }
  | { phase: 'closed'; runId: string; sessionId: string };

export interface BrowserToolExecutor extends ToolExecutor {
  closeRunSessions(runId: string, ctx: ProviderCallContext): Promise<void>;
}

interface BrowserSession {
  providerId: BrowserBackend;
  runId: string;
  interactive: boolean;
  url?: string;
  destination?: string;
}

interface PreparedBrowserAction {
  argumentsKey: string;
  sessionId: string;
  review: Json;
  requiresApproval: boolean;
  kind: 'target' | 'research' | 'handoff';
  table?: ElementTable;
  decision?: BrowserDecision;
  result?: ToolExecutionOutput;
  manualAction?: boolean;
}

class BrowserResearchBlockedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: 'empty_page' | 'browser_challenge',
  ) {
    super(
      reason === 'empty_page'
        ? 'The browser returned no readable page evidence.'
        : 'The browser page requires human interaction before research can continue.',
    );
  }
}

/**
 * Port of the teammate browser controller onto AgentOS's exact-action broker.
 * Authorization, approval, version pinning, and lifecycle events happen once
 * in ToolBroker; this executor owns only browser I/O and target resolution.
 */
export function createBrowserExecutor(deps: BrowserExecutorDeps): BrowserToolExecutor {
  const sessions = new Map<string, BrowserSession>();
  const prepared = new Map<string, PreparedBrowserAction>();
  const researchBindings = new Map<
    string,
    { argumentsKey: string; sessionId: string; disposeAfter: boolean }
  >();
  const staleReviews = new Map<string, number>();
  const adapterFor = (id: BrowserBackend): BrowserAdapter => {
    const adapter =
      deps.byId?.(id) ?? deps.provider(id === 'localbrowser' ? 'browser.local' : 'browser');
    if (adapter.id !== id) throw new Error('Explicit browser provider is unavailable: ' + id);
    return adapter;
  };
  /**
   * One reusable session per run and backend for stateless public research.
   * A session per search/read cost a Browserbase session each (35 in one
   * 7-minute run, each billed at least a minute), which exhausted the plan.
   * Released with the run's other sessions by closeRunSessions.
   */
  const researchPool = new Map<string, string>();
  /** Serializes navigate+read on a pooled session so concurrent calls cannot interleave. */
  const poolTails = new Map<string, Promise<unknown>>();

  async function announce(event: BrowserSessionEvent): Promise<void> {
    try {
      await deps.onSession?.(event);
    } catch {
      // Showing a session is never a reason to fail the browser action.
    }
  }

  function withPoolLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = poolTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    poolTails.set(key, next);
    void next
      .finally(() => {
        if (poolTails.get(key) === next) poolTails.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  async function handoffReview(
    action: ToolAction,
    ctx: ProviderCallContext,
    sessionId: string,
    instruction: string,
    manualAction = false,
  ): Promise<PreparedBrowserAction> {
    const adapter = adapterFor(providerFor(action.toolId));
    if (!adapter.setOwnership)
      throw new Error('Browser backend cannot safely hand this page to a human.');
    await adapter.setOwnership(
      { sessionId, owner: 'human' },
      childContext(ctx, 'browser-review-manual-handoff'),
    );
    const value: PreparedBrowserAction = {
      kind: 'handoff',
      argumentsKey: JSON.stringify(action.arguments),
      sessionId,
      requiresApproval: true,
      manualAction,
      review: {
        kind: 'browser_handoff',
        sessionId,
        providerId: adapter.id,
        instruction,
        reason: manualAction ? 'target_requires_manual_action' : 'research_page_blocked',
        ...(!manualAction && /^https?:/.test(sessions.get(sessionId)?.url ?? '')
          ? { expectUrl: new URL(sessions.get(sessionId)!.url!).origin + '/' }
          : {}),
      },
    };
    prepared.set(action.id, value);
    return value;
  }

  async function prepareTarget(
    action: ToolAction,
    ctx: ProviderCallContext,
  ): Promise<PreparedBrowserAction> {
    const providerId = providerFor(action.toolId);
    const adapter = adapterFor(providerId);
    const args = asObject(action.arguments);
    const sessionId = requiredString(args, 'sessionId');
    assertSessionProvider(sessions, sessionId, providerId, action.runId);
    assertSensitiveDestination(action.dataLabels, sessions.get(sessionId)?.url);
    if ((staleReviews.get(action.id) ?? 0) >= 3)
      return handoffReview(
        action,
        ctx,
        sessionId,
        'The reviewed browser target kept changing. Complete this exact requested action manually on this page, then approve to continue. No automatic click will be replayed.',
        true,
      );
    const table = await snapshot(adapter, sessionId, deps.maxElements, ctx);
    const operation = action.toolId.split('.').at(-1);
    const allowedOperations: BrowserOperation[] =
      operation === 'type' ? ['TYPE_TEXT', 'SELECT'] : ['CLICK'];
    const typedValue = optionalString(args, 'text');
    const decision = await deps.decide({
      credentialRunId: ctx.runId,
      cacheScope: ctx.runId + ':' + providerId + ':' + sessionId,
      localOnly: action.dataLabels.some((label) => label !== 'public'),
      goal: requiredString(args, 'goal'),
      table,
      allowedOperations,
      ...(typedValue ? { typeText: typedValue } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const target = table.rows.find((row) => row.index === decision.index);
    if (
      !target ||
      !allowedOperations.includes(decision.operation) ||
      !(decision.operation === 'CLICK'
        ? target.clickable
        : decision.operation === 'TYPE_TEXT'
          ? target.editable
          : target.selectable)
    )
      return handoffReview(
        action,
        ctx,
        sessionId,
        'No unambiguous eligible control could be resolved for this exact action. Complete it manually on this same page, then approve to continue. No automatic click will be replayed.',
        true,
      );
    const confidence = Number.isFinite(decision.confidence)
      ? Math.max(0, Math.min(1, decision.confidence))
      : 0;
    // Jev's pick is followed at any confidence; what the click DOES decides
    // whether a person approves it. Jev's action policy sees this review too.
    const risk = consequentialBrowserAction(operation ?? '', decision.operation, target);
    const value: PreparedBrowserAction = {
      kind: 'target',
      argumentsKey: JSON.stringify(action.arguments),
      sessionId,
      table,
      decision: { ...decision, confidence },
      requiresApproval: risk !== null,
      review: {
        kind: 'browser_target',
        sessionId,
        providerId,
        operation: decision.operation,
        snapshotId: table.snapshotId,
        index: target.index,
        label: target.label,
        role: target.role,
        confidence,
        decisionSource: decision.source,
        pageUrl: browserLocation(table.url),
        consequential: risk !== null,
        ...(risk ? { risk } : {}),
        lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
        reason: risk
          ? 'consequential_target'
          : (staleReviews.get(action.id) ?? 0) > 0
            ? 'reviewed_target_changed'
            : 'resolved_target',
      },
    };
    prepared.set(action.id, value);
    return value;
  }

  async function prepareResearch(
    action: ToolAction,
    ctx: ProviderCallContext,
  ): Promise<PreparedBrowserAction> {
    const providerId = providerFor(action.toolId);
    const adapter = adapterFor(providerId);
    const args = asObject(action.arguments);
    const operation = action.toolId.split('.').at(-1)!;
    const argumentsKey = JSON.stringify(action.arguments);
    let binding = researchBindings.get(action.id);
    if (binding?.argumentsKey !== argumentsKey) binding = undefined;
    const url = requestedStartUrl(operation, args);
    assertSensitiveDestination(action.dataLabels, url);
    if (operation === 'search') requiredString(args, 'query');
    else requiredString(args, 'instruction');
    let result: ToolExecutionOutput;
    try {
      if (!binding) {
        const sessionId = optionalString(args, 'sessionId');
        if (sessionId) {
          assertSessionProvider(sessions, sessionId, providerId, action.runId);
          assertSensitiveDestination(action.dataLabels, sessions.get(sessionId)?.url);
          binding = { argumentsKey, sessionId, disposeAfter: false };
          researchBindings.set(action.id, binding);
        } else if (
          url &&
          action.dataLabels.every((label) => label === 'public') &&
          adapter.navigate
        ) {
          try {
            result = await pooledResearch(adapter, providerId, action, operation, url, ctx);
          } catch (error) {
            if (error instanceof BrowserResearchBlockedError) {
              binding = { argumentsKey, sessionId: error.sessionId, disposeAfter: false };
              researchBindings.set(action.id, binding);
            }
            throw error;
          }
          const pooledId = researchPool.get(action.runId + ':' + providerId)!;
          binding = { argumentsKey, sessionId: pooledId, disposeAfter: false };
          researchBindings.set(action.id, binding);
          const value: PreparedBrowserAction = {
            kind: 'research',
            argumentsKey,
            sessionId: pooledId,
            result,
            requiresApproval: false,
            review: { kind: 'browser_research', providerId, sessionId: pooledId, operation },
          };
          prepared.set(action.id, value);
          return value;
        } else {
          const opened = await adapter.openSession(
            url ? { startUrl: url } : {},
            childContext(ctx, 'browser-session-open'),
          );
          if (!opened.ok) throw new Error(opened.error.message);
          binding = { argumentsKey, sessionId: opened.data.sessionId, disposeAfter: true };
          researchBindings.set(action.id, binding);
          sessions.set(binding.sessionId, {
            providerId,
            runId: action.runId,
            url,
            interactive: opened.data.interactive === true,
            destination: opened.meta.destination ?? undefined,
          });
          await announce({
            phase: 'opened',
            runId: action.runId,
            ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
            sessionId: binding.sessionId,
            providerId,
            interactive: opened.data.interactive === true,
            mode: adapter.mode,
          });
        }
      }
      result = await researchOutput(adapter, binding.sessionId, action, operation, ctx);
      const value: PreparedBrowserAction = {
        kind: 'research',
        argumentsKey,
        sessionId: binding.sessionId,
        result,
        requiresApproval: false,
        review: { kind: 'browser_research', providerId, sessionId: binding.sessionId, operation },
      };
      prepared.set(action.id, value);
      return value;
    } catch (error) {
      if (!(error instanceof BrowserResearchBlockedError)) throw error;
      return handoffReview(
        action,
        ctx,
        error.sessionId,
        error.reason === 'empty_page'
          ? 'This page returned no readable evidence. Load the intended content in this same browser and approve to retry the read. Empty content will not be reported as success.'
          : 'This page is blocked by a challenge, sign-in, or access check. Resolve it manually in this same browser, then approve to read the resulting page. No challenge will be solved automatically.',
      );
    }
  }

  async function prepareReview(
    action: ToolAction,
    ctx: ProviderCallContext,
  ): Promise<{ review: Json; requiresApproval: boolean }> {
    ctx.signal?.throwIfAborted();
    const operation = action.toolId.split('.').at(-1);
    const value = ['click', 'type', 'submit'].includes(operation ?? '')
      ? await prepareTarget(action, ctx)
      : ['search', 'read', 'extract'].includes(operation ?? '')
        ? await prepareResearch(action, ctx)
        : undefined;
    return value
      ? { review: value.review, requiresApproval: value.requiresApproval }
      : {
          review: { kind: 'browser_action', operation: operation ?? 'unknown' },
          requiresApproval: false,
        };
  }

  async function executePrepared(
    action: ToolAction,
    ctx: ProviderCallContext,
  ): Promise<ToolExecutionOutput> {
    let value = prepared.get(action.id);
    if (!value || value.argumentsKey !== JSON.stringify(action.arguments)) {
      await prepareReview(action, ctx);
      value = prepared.get(action.id);
    }
    if (!value) throw new Error('Browser action preparation is unavailable.');
    const approved = ctx.policyRule === 'human-approved-exact-tool-action';
    const review = (action as ToolAction & { review?: Json }).review;
    if (
      (value.requiresApproval &&
        (!approved || JSON.stringify(review) !== JSON.stringify(value.review))) ||
      (review !== undefined && JSON.stringify(review) !== JSON.stringify(value.review))
    )
      throw new PreparedActionReviewRequiredError(
        'The exact browser target requires human review before it can execute.',
      );
    const adapter = adapterFor(providerFor(action.toolId));
    if (value.kind === 'handoff') {
      if (!adapter.setOwnership) throw new Error('Browser backend cannot safely resume.');
      await adapter.setOwnership(
        { sessionId: value.sessionId, owner: 'agent' },
        childContext(ctx, 'browser-review-resume'),
      );
      if (value.manualAction) {
        const table = await snapshot(adapter, value.sessionId, deps.maxElements, ctx);
        prepared.delete(action.id);
        return output(
          action,
          { sessionId: value.sessionId, manualCompletion: true, url: browserLocation(table.url) },
          'Human confirmed completion of the requested browser action; no automatic click was replayed.',
          undefined,
          adapter.mode,
        );
      }
      prepared.delete(action.id);
      const resumed = await prepareResearch(action, ctx);
      if (resumed.kind === 'handoff')
        throw new PreparedActionReviewRequiredError(
          'The same browser page still needs human interaction; research has not succeeded.',
        );
      value = resumed;
    }
    if (value.kind === 'research') {
      prepared.delete(action.id);
      const result = value.result!;
      const binding = researchBindings.get(action.id);
      if (binding?.disposeAfter) {
        const closed = await adapter.closeSession(
          value.sessionId,
          childContext(ctx, 'browser-session-release'),
        );
        if (!closed.ok) throw new Error('Browser research cleanup failed.');
        sessions.delete(value.sessionId);
        await announce({ phase: 'closed', runId: action.runId, sessionId: value.sessionId });
      }
      return result;
    }
    const table = value.table!;
    const decision = value.decision!;
    const target = table.rows.find((row) => row.index === decision.index)!;
    if (!adapter.perform) throw new Error('Browser backend lacks element-level execution.');
    ctx.signal?.throwIfAborted();
    const typed = optionalString(asObject(action.arguments), 'text');
    const performOn = (snapshotId: string, index: number) =>
      adapter.perform!(
        {
          sessionId: value!.sessionId,
          snapshotId,
          operation: decision.operation,
          index,
          ...(typed !== undefined ? { text: typed } : {}),
        },
        childContext(ctx, 'browser-reviewed-element-action'),
      );
    let performed = await performOn(table.snapshotId, decision.index!);
    // An APPROVED target whose page re-rendered (a new snapshot id, or the
    // element moved) is the same element if exactly one control with the
    // reviewed role and label is on the same page. The approval was for that
    // element, so it is clicked without asking again; anything ambiguous is
    // reviewed afresh below.
    if (
      !performed.ok &&
      value.requiresApproval &&
      approved &&
      STALE_TARGET.has(performed.error.message)
    ) {
      const fresh = await snapshot(adapter, value.sessionId, deps.maxElements, ctx);
      const same = fresh.rows.filter(
        (row) => row.role === target.role && row.label === target.label,
      );
      if (same.length === 1 && browserLocation(fresh.url) === browserLocation(table.url))
        performed = await performOn(fresh.snapshotId, same[0]!.index);
    }
    if (!performed.ok) {
      if (performed.error.code === 'BAD_INPUT' && STALE_TARGET.has(performed.error.message)) {
        prepared.delete(action.id);
        staleReviews.set(action.id, (staleReviews.get(action.id) ?? 0) + 1);
        throw new PreparedActionReviewRequiredError(
          'The reviewed browser target changed or is occluded. A fresh review is required; nothing was clicked or typed.',
        );
      }
      throw new Error(performed.error.message);
    }
    prepared.delete(action.id);
    sessions.set(value.sessionId, {
      ...sessions.get(value.sessionId),
      providerId: providerFor(action.toolId),
      url: performed.data.url,
      runId: action.runId,
      interactive: sessions.get(value.sessionId)?.interactive ?? false,
    });
    return output(
      action,
      {
        ...performed.data,
        target: target.label,
        decisionSource: decision.source,
        confidence: decision.confidence,
        rationale: decision.rationale,
      },
      'Completed ' +
        action.toolId.split('.').at(-1) +
        ' on reviewed browser target "' +
        target.label +
        '"' +
        (decision.confidence < LOW_CONFIDENCE_THRESHOLD
          ? ' (a low-confidence pick, ' + decision.confidence.toFixed(2) + ': check the page)'
          : '') +
        '.',
      undefined,
      adapter.mode,
    );
  }

  async function pooledResearch(
    adapter: BrowserAdapter,
    providerId: BrowserSession['providerId'],
    action: ToolAction,
    operation: string,
    url: string,
    ctx: ProviderCallContext,
  ): Promise<ToolExecutionOutput> {
    const key = action.runId + ':' + providerId;
    return withPoolLock(key, async () => {
      let sessionId = researchPool.get(key);
      if (sessionId && adapter.navigate) {
        const moved = await adapter.navigate(
          { sessionId, url },
          childContext(ctx, 'browser-research-navigate'),
        );
        if (!moved.ok) {
          // Expired or broken (Browserbase times idle sessions out): replace it.
          await adapter
            .closeSession(sessionId, childContext(ctx, 'browser-session-release'))
            .catch(() => undefined);
          sessions.delete(sessionId);
          researchPool.delete(key);
          await announce({ phase: 'closed', runId: action.runId, sessionId });
          sessionId = undefined;
        }
      }
      if (!sessionId) {
        const opened = await adapter.openSession(
          { startUrl: url },
          childContext(ctx, 'browser-session-open'),
        );
        if (!opened.ok) throw new Error('Could not open browser session: ' + opened.error.message);
        sessionId = opened.data.sessionId;
        researchPool.set(key, sessionId);
        await announce({
          phase: 'opened',
          runId: action.runId,
          ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
          sessionId,
          providerId,
          interactive: opened.data.interactive === true,
          mode: adapter.mode,
        });
      }
      sessions.set(sessionId, {
        providerId,
        url,
        runId: action.runId,
        interactive: false,
      });
      return researchOutput(adapter, sessionId, action, operation, ctx);
    });
  }

  return {
    ref: BROWSER_EXECUTOR_REF,
    prepareReview,
    discardPrepared(actionId) {
      prepared.delete(actionId);
      researchBindings.delete(actionId);
      staleReviews.delete(actionId);
    },

    async closeRunSessions(runId, ctx) {
      for (const [id, value] of prepared)
        if (sessions.get(value.sessionId)?.runId === runId) {
          prepared.delete(id);
          researchBindings.delete(id);
          staleReviews.delete(id);
        }
      // The pooled sessions are in `sessions` too and are closed below.
      for (const key of [...researchPool.keys()]) {
        if (key.startsWith(runId + ':')) researchPool.delete(key);
      }
      const owned = [...sessions.entries()].filter(([, session]) => session.runId === runId);
      await Promise.all(
        owned.map(async ([sessionId, session]) => {
          const adapter = adapterFor(session.providerId);
          try {
            const closed = await adapter.closeSession(
              sessionId,
              childContext(ctx, 'browser-run-release'),
            );
            if (!closed.ok) throw new Error(closed.error.message);
          } catch (error) {
            // Graph teardown and orchestrator teardown are intentionally both
            // best-effort. A graph may already have released this same browser
            // through the provider wrapper; that is an idempotent close, not a
            // resource leak or a run failure.
            if (
              !(error instanceof Error) ||
              !error.message.includes('Browser session is not owned by this run')
            ) {
              throw error;
            }
          } finally {
            sessions.delete(sessionId);
            await announce({ phase: 'closed', runId, sessionId });
          }
        }),
      );
    },

    destinationFor({ descriptor, arguments: args }) {
      const sessionId =
        args && typeof args === 'object' && !Array.isArray(args) ? args.sessionId : undefined;
      if (typeof sessionId === 'string' && sessions.get(sessionId)?.destination)
        return sessions.get(sessionId)!.destination;
      if (descriptor.providerId === 'localbrowser') return LOCAL_BROWSER_DESTINATION;
      if (descriptor.providerId === 'browserbase') return BROWSERBASE_API_DESTINATION;
      if (descriptor.providerId === 'browserless')
        return new URL(config.providers.browserless.baseUrl!).origin;
      return undefined;
    },

    async execute(action, ctx) {
      const providerId = providerFor(action.toolId);
      const adapter = adapterFor(providerId);
      const args = asObject(action.arguments);
      const operation = action.toolId.split('.').at(-1);
      if (!operation) throw new Error('Browser operation is missing.');
      if (['click', 'type', 'submit', 'search', 'read', 'extract'].includes(operation))
        return executePrepared(action, ctx);

      if (operation === 'close') {
        const sessionId = requiredString(args, 'sessionId');
        assertSessionProvider(sessions, sessionId, providerId, action.runId);
        const closed = await adapter.closeSession(sessionId, ctx);
        if (!closed.ok) throw new Error(closed.error.message);
        sessions.delete(sessionId);
        for (const [key, pooled] of researchPool)
          if (pooled === sessionId) researchPool.delete(key);
        await announce({ phase: 'closed', runId: action.runId, sessionId });
        return output(
          action,
          { closed: sessionId },
          'Closed browser session.',
          undefined,
          adapter.mode,
        );
      }

      const suppliedSessionId = optionalString(args, 'sessionId');
      const stateful = ['inspect', 'click', 'type', 'submit'].includes(operation);
      if (stateful && !suppliedSessionId) {
        throw new Error(operation + ' requires an existing sessionId; open a page first.');
      }
      const requestedUrl = requestedStartUrl(operation, args);
      assertSensitiveDestination(action.dataLabels, requestedUrl);

      let sessionId = suppliedSessionId;
      let ownsSession = false;
      if (sessionId) {
        assertSessionProvider(sessions, sessionId, providerId, action.runId);
        assertSensitiveDestination(action.dataLabels, sessions.get(sessionId)?.url);
      } else {
        const opened = await adapter.openSession(
          requestedUrl ? { startUrl: requestedUrl } : {},
          childContext(ctx, 'browser-session-open'),
        );
        if (!opened.ok) throw new Error('Could not open browser session: ' + opened.error.message);
        sessionId = opened.data.sessionId;
        ownsSession = true;
        sessions.set(sessionId, {
          providerId,
          url: requestedUrl,
          runId: action.runId,
          interactive: opened.data.interactive === true,
          destination: opened.meta.destination ?? undefined,
        });
      }

      try {
        if (operation === 'open') {
          ownsSession = false;
          await announce({
            phase: 'opened',
            runId: action.runId,
            ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
            sessionId,
            providerId,
            interactive: openedInteractive(sessions, sessionId),
            mode: adapter.mode,
          });
          // The session ID MUST reach the model: inspect/click/type/extract all
          // require it. The bare "Opened a session." summary left the model to
          // guess ("default"), every follow-up failed with "not owned by this
          // run", and it opened sessions until BROWSER_MAX_SESSIONS stopped it.
          // The ID is an opaque handle; the broker still checks run ownership.
          return output(
            action,
            {
              sessionId,
              liveViewUrl: null,
              interactive: openedInteractive(sessions, sessionId),
              backend: providerId,
            },
            'Opened a ' +
              providerId +
              ' browser session with sessionId "' +
              sessionId +
              '". Pass that sessionId to the other browser tools.',
            { sessionId, backend: providerId },
            adapter.mode,
          );
        }

        const table = await snapshot(adapter, sessionId, deps.maxElements, ctx);
        if (operation === 'inspect') {
          return output(
            action,
            table as unknown as Json,
            'Inspected ' + table.rows.length.toString() + ' interactive browser controls.',
            undefined,
            adapter.mode,
          );
        }

        throw new Error('Unknown browser operation: ' + action.toolId);
      } finally {
        if (ownsSession) {
          await adapter
            .closeSession(sessionId, childContext(ctx, 'browser-session-release'))
            .catch(() => undefined);
          sessions.delete(sessionId);
        }
      }
    },
  };
}

function providerFor(toolId: string): BrowserSession['providerId'] {
  if (toolId.startsWith('localbrowser.')) return 'localbrowser';
  if (toolId.startsWith('browserbase.')) return 'browserbase';
  if (toolId.startsWith('browserless.')) return 'browserless';
  throw new Error('Unknown browser provider for tool: ' + toolId);
}

/** CSS scope of the result list on the search page requestedStartUrl opens. */
const SEARCH_RESULTS_SCOPE = '#links';
/** Below this, a scoped read is treated as missing and the whole page is read instead. */
const MIN_SCOPED_EVIDENCE_CHARS = 200;

/**
 * Read a research page as bounded evidence. The agent's natural-language
 * `instruction` is validated but NOT forwarded: adapter.extract reads it as a
 * CSS scope, and natural language there threw inside the page ("Uncaught").
 *
 * The focused region is tried first (search results, then <main>), whole page
 * second. Whole-page text on a store spent the evidence budget on site
 * navigation, so prices never reached the agent and it searched product
 * after product looking for them.
 */
async function researchOutput(
  adapter: BrowserAdapter,
  sessionId: string,
  action: ToolAction,
  operation: string,
  ctx: ProviderCallContext,
): Promise<ToolExecutionOutput> {
  const scopes = operation === 'search' ? [SEARCH_RESULTS_SCOPE, ''] : ['main', ''];
  let extracted: Awaited<ReturnType<BrowserAdapter['extract']>> | undefined;
  for (const scope of scopes) {
    extracted = await adapter.extract<Json>(
      { sessionId, instruction: scope },
      childContext(ctx, 'browser-read'),
    );
    if (extracted.ok && evidenceTextLength(extracted.data) >= MIN_SCOPED_EVIDENCE_CHARS) break;
  }
  if (!extracted?.ok) throw new Error(extracted?.error.message ?? 'Browser read failed.');
  const issue = browserResearchIssue(extracted.data);
  if (issue) throw new BrowserResearchBlockedError(sessionId, issue);
  const publicOnly = action.dataLabels.every((label) => label === 'public');
  const evidence = publicOnly ? boundedEvidence(extracted.data as Json) : { available: true };
  return output(
    action,
    evidence,
    operation === 'search'
      ? 'Completed stateless browser research search.'
      : operation === 'read'
        ? 'Read a page as bounded stateless research evidence.'
        : 'Extracted bounded evidence from the existing browser page.',
    publicOnly ? evidence : undefined,
    adapter.mode,
  );
}

/** Challenge text is evidence of a blocked read, never a completed search. */
export function browserResearchIssue(
  value: unknown,
): 'empty_page' | 'browser_challenge' | undefined {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const text = (
    typeof value === 'string' ? value : typeof source?.text === 'string' ? source.text : ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'empty_page';
  const title = typeof source?.title === 'string' ? source.title : '';
  if (
    /^(?:access denied|just a moment|attention required|verify you are human|robot check|security check)/i.test(
      title.trim(),
    ) ||
    /verify (?:that )?(?:you are|you're) (?:a )?human|prove (?:that )?(?:you are|you're) not a robot|unusual traffic|access denied|complete (?:the|this) (?:captcha|security check)|enable javascript and cookies to continue|bots use duckduckgo too|checking (?:your browser|if the site connection is secure)|challenge-platform/i.test(
      text,
    )
  )
    return 'browser_challenge';
  return undefined;
}

function evidenceTextLength(value: unknown): number {
  if (typeof value === 'string') return value.trim().length;
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim().length : 0;
  }
  return 0;
}

function requestedStartUrl(operation: string, args: Record<string, Json>): string | undefined {
  const explicit = optionalString(args, 'url');
  if (explicit) return normalizeBrowserUrl(explicit);
  if (operation === 'read') throw new Error('read requires a URL.');
  if (operation === 'extract' && !optionalString(args, 'sessionId')) {
    throw new Error('extract requires an existing sessionId or an explicit URL.');
  }
  if (operation !== 'search') return undefined;
  const query = requiredString(args, 'query');
  // Google bot-checks automated browsers (measured on Browserbase: an empty
  // results page or 'Verifying your request'). DuckDuckGo's HTML endpoint is
  // server-rendered and answered reliably; its results live in #links.
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
}

function normalizeBrowserUrl(value: string): string {
  if (value === 'about:blank') return value;
  const parsed = new URL(value);
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error('Browser URLs must use http, https, file, or about:blank.');
  }
  return parsed.toString();
}

function assertSensitiveDestination(labels: DataLabel[], url: string | undefined): void {
  if (!labels.some((label) => label === 'secret' || label === 'local_only')) return;
  if (!url) throw new Error('Sensitive browser work requires a known local destination.');
  if (url === 'about:blank' || url.startsWith('file:')) return;
  const hostname = new URL(url).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('Secret or local-only browser data cannot be sent to a remote website.');
  }
}

function assertSessionProvider(
  sessions: Map<string, BrowserSession>,
  sessionId: string,
  providerId: BrowserSession['providerId'],
  runId: string,
): void {
  const known = sessions.get(sessionId);
  if (known && known.runId !== runId) {
    throw new Error('Browser session is unknown or belongs to a different run.');
  }
  if (known && known.providerId !== providerId) {
    throw new Error('Browser session belongs to a different backend.');
  }
}

async function snapshot(
  adapter: BrowserAdapter,
  sessionId: string,
  maxElements: number | undefined,
  ctx: ProviderCallContext,
): Promise<ElementTable> {
  if (!adapter.snapshot) throw new Error('Browser backend lacks element snapshots.');
  const result = await adapter.snapshot(
    { sessionId, ...(maxElements ? { maxElements } : {}) },
    childContext(ctx, 'browser-snapshot'),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function output(
  action: ToolAction,
  value: Json,
  summary: string,
  modelOutput?: Json,
  mode?: BrowserAdapter['mode'],
): ToolExecutionOutput {
  const publicOnly = action.dataLabels.every((label) => label === 'public');
  const visibleSummary = mode === 'mock' ? 'Simulated: ' + summary : summary;
  const labelMock = (item: Json): Json =>
    mode === 'mock'
      ? item && typeof item === 'object' && !Array.isArray(item)
        ? { ...item, simulated: true }
        : { result: item, simulated: true }
      : item;
  return {
    output: labelMock(value),
    summary: visibleSummary,
    ...(mode === 'mock' || mode === 'live' ? { executionMode: mode } : {}),
    ...(publicOnly ? { sanitizedSummary: visibleSummary } : {}),
    ...(publicOnly && modelOutput !== undefined ? { modelOutput: labelMock(modelOutput) } : {}),
    dataLabels: [...action.dataLabels],
    verified: true,
  };
}

function openedInteractive(sessions: Map<string, BrowserSession>, sessionId: string): boolean {
  // Interactivity is trusted adapter metadata, never inferred from a URL.
  return sessions.get(sessionId)?.interactive ?? false;
}

/** Whitelist short evidence fields; never pass a provider's whole document through. */
function boundedEvidence(value: Json): Json {
  if (typeof value === 'string') return { text: value.slice(0, 2400) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { available: true };
  }
  const source = value as Record<string, Json>;
  const evidence: Record<string, Json> = {};
  for (const key of ['title', 'text', 'snippet', 'summary', 'description']) {
    const field = source[key];
    if (typeof field === 'string' && field.trim()) evidence[key] = field.slice(0, 1800);
  }
  for (const key of ['url', 'sourceUrl']) {
    const field = source[key];
    if (typeof field !== 'string') continue;
    try {
      const url = new URL(field);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        evidence.url = url.toString().slice(0, 500);
        break;
      }
    } catch {
      // Unparseable provider URLs are excluded from the model-visible artifact.
    }
  }
  const results = source.results;
  if (Array.isArray(results)) {
    evidence.results = results.slice(0, 5).map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return {};
      const result = item as Record<string, Json>;
      return Object.fromEntries(
        ['title', 'url', 'snippet', 'description']
          .filter((key) => typeof result[key] === 'string')
          .map((key) => [key, (result[key] as string).slice(0, key === 'url' ? 500 : 800)]),
      ) as Json;
    });
  }
  return Object.keys(evidence).length ? evidence : { available: true };
}

function childContext(ctx: ProviderCallContext, policyRule: string): ProviderCallContext {
  return { ...ctx, policyRule };
}

function asObject(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser tool arguments must be an object.');
  }
  return value;
}

function requiredString(value: Record<string, Json>, key: string): string {
  const result = optionalString(value, key);
  if (!result) throw new Error('Browser argument "' + key + '" is required.');
  return result;
}

function optionalString(value: Record<string, Json>, key: string): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.trim() ? item.trim() : undefined;
}
