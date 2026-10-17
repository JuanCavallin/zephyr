/**
 * Composition root. The ONLY place the layers are wired together.
 *
 * Order matters and is the reason there is no circular import:
 *   store -> bus (persists via store) -> ledger recorder (writes store + bus)
 *         -> provider registry (wrapped with that recorder)
 *         -> orchestrator (given store, bus, and the registry's accessor)
 */

import { RunBus } from '../core/bus.js';
import { isTerminal } from '@htn/shared';
import { config } from '../config.js';
import { buildEgressEvent } from '../core/ledger.js';
import { Orchestrator } from '../core/orchestrator.js';
import { DecisionService } from '../core/decisions/service.js';
import { modelRoutesFor } from '../core/modelGateway/catalog.js';
import { ModelGatewayService, textAdapterBackend } from '../core/modelGateway/service.js';
import { RunToolApprovalGate } from '../core/tools/approval.js';
import { ToolBroker } from '../core/tools/broker.js';
import { InMemoryToolExecutorRegistry } from '../core/tools/executors.js';
import { InMemoryToolRegistry } from '../core/tools/registry.js';
import { registerCoreLocalTools } from '../core/tools/local.js';
import { registerDocumentTools } from '../core/tools/documents.js';
import { registerBenchmarkFixture } from '../core/tools/benchmarkFixture.js';
import { registerSearchTool } from '../core/tools/search.js';
import { credentials } from './credentials.js';
import { resolveBrowserSessionProvider } from '../providers/withBrowserOwnership.js';
import { createTargetMemory, registerBrowserTools } from '../core/tools/index.js';
import { SessionStateService } from '../core/sessions/service.js';
import { nowIso } from '../lib/ids.js';
import { createProviderRegistry } from '../providers/registry.js';
import { createOllamaBackend, ollamaModelRoutes } from '../providers/ollama/backend.js';
import { createGeminiBackend, geminiModelRoutes } from '../providers/gemini/backend.js';
import { createAnthropicBackend, anthropicModelRoutes } from '../providers/anthropic/backend.js';
import type { RecordEgress } from '../providers/withEgress.js';
import { ComposioToolCatalog } from '../providers/composio/register.js';
import { McpConnectionManager } from '../core/mcp/connections.js';
import { store } from '../store/index.js';
import { invalidateToolCatalogCache } from './toolCatalog.js';
import { configureGraphCompile, recordCompiledDecision } from './graphCompile.service.js';

export const bus = new RunBus((runId, event) => store.appendEvent(runId, event));

/**
 * Every provider call lands here. Writes the ledger row, then streams it to the
 * UI so the egress table fills in live rather than only at the end.
 */
const recordEgress: RecordEgress = async (input) => {
  const event = buildEgressEvent(input, nowIso());
  await store.appendEgress(event);
  await bus.emit(event.runId, { type: 'egress.logged', egress: event });
};

export const providers = createProviderRegistry(recordEgress);
export const decisionService = new DecisionService(providers.provider('decision'));
export const sessionStateService = new SessionStateService(store, bus);
export const toolRegistry = new InMemoryToolRegistry();
/** Compatibility name retained for teammates already importing the gateway catalog. */
export const toolDescriptorCatalog = toolRegistry;
export const toolExecutors = new InMemoryToolExecutorRegistry();
export const toolApprovalGate = new RunToolApprovalGate(store, bus, sessionStateService);
export const toolBroker = new ToolBroker(
  toolRegistry,
  toolExecutors,
  decisionService,
  sessionStateService,
  bus,
  {
    approvalGate: toolApprovalGate,
    // Escalate-only: it can stop an outbound send for a human, never permit one.
    contentCheck: {
      analysis: providers.provider('content.analysis'),
      threshold: config.contentCheck.escalationThreshold,
    },
  },
);
registerCoreLocalTools(toolRegistry, toolExecutors, sessionStateService);
registerBenchmarkFixture(toolRegistry, toolExecutors);
registerDocumentTools(toolRegistry, toolExecutors, { mode: config.mock.all ? 'mock' : 'live' });
registerSearchTool(toolRegistry, toolExecutors, {
  browser: () => providers.provider('browser'),
  recordEgress,
});
export const browserTools = registerBrowserTools(toolRegistry, toolExecutors, {
  targetMemory: createTargetMemory(store),
  // Scope comes from the server's own run and step records: a graph node
  // remembers its own pages; ad-hoc runs share one scope per run kind.
  memoryScope: async ({ runId, stepId }) => {
    const run = await store.getRun(runId);
    if (!run) return undefined;
    if (!run.graphId || run.kind !== 'graph') return 'adhoc:' + run.kind;
    const step = stepId ? await store.getStep(stepId) : null;
    return run.graphId + '|' + (step?.nodeId ?? 'run');
  },
  onSiteBlocked: async (origin, reason) => {
    await store.recordSiteBlock(origin, reason, nowIso());
  },
  provider: (capability) => providers.provider(capability),
  byId: (id) => providers.byId(id) as import('@htn/shared').BrowserAdapter,
  // Sessions an agent opens through its tools reach the run's browser panel
  // the same way a graph node's do.
  onSession: async (event) => {
    if (event.phase === 'closed') {
      await bus.emit(event.runId, {
        type: 'browser.session.closed',
        runId: event.runId,
        sessionId: event.sessionId,
        at: nowIso(),
      });
      return;
    }
    await bus.emit(event.runId, {
      type: 'browser.session.opened',
      session: {
        runId: event.runId,
        sessionId: event.sessionId,
        ...(event.stepId ? { stepId: event.stepId } : {}),
        providerId: event.providerId,
        interactive: event.interactive,
        mode: event.mode,
        openedAt: nowIso(),
      },
    });
  },
});
export const composioToolCatalog = new ComposioToolCatalog(
  providers.provider('toolbox'),
  config.providers.composio,
  toolRegistry,
  toolExecutors,
);
export const mcpConnections = new McpConnectionManager(
  store,
  toolRegistry,
  toolExecutors,
  recordEgress,
  [config.mcpGateway.url],
);
const boundTextModel = providers.provider('text.model');
export const modelGateway = new ModelGatewayService(
  decisionService,
  sessionStateService,
  boundTextModel,
  toolRegistry,
  bus,
  {
    routeAvailable: (route, ctx) => {
      if (
        !config.mock.all &&
        config.providers.hermes.mode === 'live' &&
        route.modelId.startsWith('mock-')
      )
        return false;
      return (
        config.mock.all ||
        route.deployment === 'local' ||
        credentials.available({ runId: ctx.runId, providerId: route.providerId, purpose: 'model' })
      );
    },
    maxToolCallsPerTurn: config.agent.maxToolCallsPerTurn,
    modelRoutes: (adapter) => [
      ...modelRoutesFor(adapter),
      ...anthropicModelRoutes(config.providers.anthropic),
      ...geminiModelRoutes(config.providers.gemini),
      ...ollamaModelRoutes(config.providers.ollama),
    ],
    // Each backend handles only its own route and delegates the rest.
    backend: createOllamaBackend(
      config.providers.ollama,
      recordEgress,
      createGeminiBackend(
        config.providers.gemini,
        recordEgress,
        createAnthropicBackend(
          config.providers.anthropic,
          recordEgress,
          textAdapterBackend(boundTextModel),
          credentials,
        ),
        credentials,
      ),
    ),
  },
);

/** Extra candidates every agent task is offered, at run time and at compile time. */
async function localToolCandidates(): Promise<string[]> {
  const [mcpToolIds, registered] = await Promise.all([
    mcpConnections.candidateToolIds(),
    toolRegistry.list(),
  ]);
  const browserToolIds = registered
    .filter(
      (tool) =>
        tool.descriptor.availability === 'available' &&
        (tool.descriptor.id === 'web.search' ||
          tool.descriptor.transport === 'local' ||
          tool.descriptor.providerId === 'browserbase' ||
          tool.descriptor.providerId === 'browserless'),
    )
    .map((tool) => tool.descriptor.id);
  return [...new Set([...mcpToolIds, ...browserToolIds])];
}

export const orchestrator = new Orchestrator({
  store,
  bus,
  agentCeilings: {
    maxDurationMs: config.agent.maxDurationMs,
    networkRetries: config.agent.networkRetries,
  },
  provider: (capability) => providers.provider(capability),
  providerFor: (capability) => providers.bindings()[capability],
  browserForSession: (sessionId, runId) =>
    providers.byId(
      resolveBrowserSessionProvider(sessionId, runId),
    ) as import('@htn/shared').BrowserAdapter,
  decisionService,
  sessionStateService,
  toolRegistry,
  // Graph tool nodes execute through the SAME broker a harness turn does.
  toolBroker,
  toolDiscovery: composioToolCatalog,
  localToolCandidates,
  recordCompiledDecision,
  releaseRunResources: async ({ runId, stepId }) => {
    const ctx = { runId, stepId, policyRule: 'agent-task-resource-release' };
    await browserTools.closeRunSessions(runId, ctx);
    await Promise.all(
      (['browserbase', 'browserless', 'localbrowser'] as const).map(async (id) => {
        const browser = providers.byId(id) as import('@htn/shared').BrowserAdapter;
        if (browser.releaseRun) await browser.releaseRun(runId, ctx);
      }),
    );
  },
});

// Freeze the Jev decisions a saved graph can make once (see core/graph/compile.ts).
configureGraphCompile(
  {
    decider: () => providers.provider('decision'),
    resolveTools: (ids) => toolRegistry.resolve(ids),
    localToolCandidates,
  },
  { enabled: config.graphCompile.enabled },
);

let providersInitialized = false;

/** Discover provider schemas once, then register only tools in AgentOS's reviewed table. */
export async function initializeRuntimeProviders(): Promise<void> {
  if (providersInitialized) return;
  providersInitialized = true;
  await mcpConnections.initialize();
  await refreshComposioTools();
}

/**
 * A persisted run cannot resume its in-memory Hermes task or approval promise
 * after this process exits. Close that stale state explicitly on startup so the
 * API never presents a run as active when no worker exists to advance it.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const interrupted = (await store.listRuns({ limit: 100_000 })).filter(
    (run) => !isTerminal(run.status),
  );

  for (const run of interrupted) {
    const at = nowIso();
    for (const step of await store.listSteps(run.id)) {
      if (!['pending', 'running', 'blocked'].includes(step.status)) continue;
      const next = await store.patchStep(step.id, {
        status: step.status === 'pending' ? 'skipped' : 'failed',
        error:
          step.status === 'pending'
            ? undefined
            : { code: 'PROCESS_RESTART', message: 'Execution stopped when the API restarted.' },
        endedAt: at,
      });
      await bus.emit(run.id, { type: 'step.upserted', step: next });
    }

    for (const approval of await store.listApprovals(run.id)) {
      if (approval.status !== 'pending') continue;
      const next = await store.patchApproval(approval.id, {
        status: 'expired',
        decidedAt: at,
        note: 'Expired because the API restarted before a decision was received.',
      });
      await bus.emit(run.id, { type: 'approval.resolved', approval: next });
    }

    for (const session of await store.listSessionStates(run.id)) {
      if (['completed', 'failed', 'cancelled'].includes(session.status)) continue;
      const next = await store.patchSessionState(session.id, { status: 'cancelled' });
      await bus.emit(run.id, { type: 'session.updated', session: next });
    }

    const next = await store.patchRun(run.id, {
      status: 'cancelled',
      summary: 'Interrupted by an API restart; start a new run to continue.',
      error: {
        code: 'PROCESS_RESTART',
        message: 'The in-memory harness task could not be resumed after the API restarted.',
      },
    });
    await bus.emit(run.id, { type: 'run.updated', run: next });
  }

  // A session left ACTIVE on a run that already finished is never reached by
  // the loop above, because that loop only walks non-terminal runs. It is still
  // debris, and it is not harmless: resolveActiveHarnessSession requires
  // exactly one active session per harness and throws "multiple active
  // sessions are ambiguous" otherwise, so a single leaked session can break
  // every later agent task in the process -- and it survives restarts, because
  // it is persisted.
  const orphanedSessions = (await store.listSessionStates()).filter(
    (session) => !['completed', 'failed', 'cancelled'].includes(session.status),
  );
  for (const session of orphanedSessions) {
    const run = await store.getRun(session.runId);
    if (run && !isTerminal(run.status)) continue; // handled above
    const next = await store.patchSessionState(session.id, { status: 'cancelled' });
    await bus.emit(session.runId, { type: 'session.updated', session: next });
  }
  if (orphanedSessions.length > 0) {
    console.warn(
      '[store] cancelled ' +
        orphanedSessions.length.toString() +
        ' session(s) left active on already-finished runs',
    );
  }

  if (interrupted.length > 0) {
    console.warn('[store] reconciled ' + interrupted.length.toString() + ' interrupted run(s)');
  }
  return interrupted.length;
}

/** Re-read connection state after the user completes Composio OAuth. */
export async function refreshComposioTools(): Promise<
  Awaited<ReturnType<ComposioToolCatalog['bootstrapReviewed']>>
> {
  const report = await composioToolCatalog.bootstrapReviewed();
  invalidateToolCatalogCache();
  if (report.registered.length > 0) {
    console.log('[composio] registered: ' + report.registered.join(', '));
  }
  if (report.skipped.length > 0) {
    console.warn('[composio] skipped unreviewed/unavailable tools: ' + report.skipped.join(', '));
  }
  if (report.warning) console.warn('[composio] startup warning: ' + report.warning);
  return report;
}

export { store };
