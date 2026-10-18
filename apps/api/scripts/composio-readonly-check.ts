import { config } from '../src/config.js';
import { createLiveComposio } from '../src/providers/composio/live.js';
import { ComposioToolCatalog } from '../src/providers/composio/register.js';
import { withEgress } from '../src/providers/withEgress.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { InMemoryToolExecutorRegistry, modelToolText } from '../src/core/tools/executors.js';
import { newId } from '../src/lib/ids.js';
import type { Json, ToolboxAdapter } from '@htn/shared';
import { ToolBroker } from '../src/core/tools/broker.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { RunBus } from '../src/core/bus.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { createMemoryStore } from '../src/store/memory.js';
import { createLiveJev } from '../src/providers/jev/live.js';
import { CredentialStore } from '../src/services/credentials.js';

// Explicit manual live validation: one bounded connected-account metadata read
// through the real broker. No connection creation, sends, document edits, or
// message/document-body reads. Secrets, account IDs and schemas are never printed.
const cfg = { ...config.providers.composio, mode: 'live' as const };
if (!cfg.apiKey) {
  console.log(
    JSON.stringify({
      product: 'Composio Platform',
      scope: 'read-only catalog bootstrap',
      status: 'blocked',
      reason: 'Existing project credentials are missing; no live pass claimed.',
    }),
  );
  process.exitCode = 2;
} else {
  const egress: { provider: string; operation: string; destination: string | null }[] = [];
  let resultFieldCount: number | null = null;
  const liveAdapter = createLiveComposio(cfg);
  const measuredAdapter: ToolboxAdapter = {
    ...liveAdapter,
    async callTool(input, ctx) {
      const result = await liveAdapter.callTool(input, ctx);
      if (result.ok && isRecord(result.data)) {
        const data = isRecord(result.data.data) ? result.data.data : result.data;
        resultFieldCount = Object.keys(data).length;
      }
      return result;
    },
  };
  const adapter = withEgress(
    measuredAdapter,
    async (entry) => {
      egress.push({
        provider: entry.providerId,
        operation: entry.op,
        destination: entry.destination,
      });
    },
    newId,
  ) as ToolboxAdapter;
  const health = await adapter.health();
  const registry = new InMemoryToolRegistry();
  const executors = new InMemoryToolExecutorRegistry();
  const catalog = new ComposioToolCatalog(adapter, cfg, registry, executors);
  const report = health.ok ? await catalog.bootstrapReviewed() : null;
  const discovery =
    health.ok && report && !report.warning
      ? await catalog.discoverForTask({
          query: 'get profile list labels',
          runId: 'sys_composio_readonly_check',
          limit: 8,
          signal: AbortSignal.timeout(30_000),
        })
      : null;
  const tools = await registry.list();
  const catalogPassed =
    health.ok && report !== null && !report.warning && discovery !== null && !discovery.warning;
  const candidate = tools.find(
    (tool) =>
      tool.descriptor.baselineEffect === 'read' &&
      tool.descriptor.availability === 'available' &&
      /\.(get_profile|list_labels)$/.test(tool.descriptor.id),
  );
  const args = candidate ? safeDefaults(candidate.inputSchema) : null;
  let executionLogId: string | null = null;
  let usefulModelResult = false;
  let canonicalPrivateLabel = false;
  let authorization: { allowed: boolean; policy: string; localDecision: boolean } | null = null;
  let executionError: string | null = null;
  if (catalogPassed && candidate && args) {
    const store = createMemoryStore();
    const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
    const sessions = new SessionStateService(store, bus);
    // Private session state forces the real deterministic policy path. This
    // must never send account metadata or proposed arguments to remote Jev.
    const decisions = new DecisionService(
      createLiveJev(
        { ...config.providers.jev, mode: 'live' },
        new CredentialStore({ source: 'user' }),
      ),
    );
    const session = await sessions.create({
      runId: newId('run'),
      stepId: newId('step'),
      harness: 'hermes',
      objective: 'Read connected profile metadata for the authorized integration check.',
      dataLabels: ['private'],
      budget: { stepsRemaining: 1 },
    });
    await sessions.beginTurn(session.id);
    await sessions.recordRouting(session.id, {
      candidateModelRouteIds: [],
      selectedModelRouteId: 'manual-read-only-check',
      candidateToolIds: [candidate.descriptor.id],
      selectedToolIds: [candidate.descriptor.id],
      selectedToolVersions: { [candidate.descriptor.id]: candidate.descriptor.version },
    });
    await sessions.grantToolExposure(session.id, {
      modelCallId: 'trusted-live-read-only-check',
      selectedToolVersions: { [candidate.descriptor.id]: candidate.descriptor.version },
    });
    try {
      const executed = await new ToolBroker(registry, executors, decisions, sessions, bus).execute({
        sessionStateId: session.id,
        toolId: candidate.descriptor.id,
        arguments: args,
        signal: AbortSignal.timeout(45_000),
      });
      authorization = {
        allowed: executed.authorization.allowed,
        policy: executed.authorization.finalPolicy,
        localDecision: executed.authorization.reasonCodes.includes(
          'deterministic-local-action-policy',
        ),
      };
      const wire: unknown = JSON.parse(modelToolText(executed));
      const payload = isRecord(wire) && isRecord(wire.result) ? wire.result : null;
      usefulModelResult =
        payload !== null && isRecord(payload.data) && Object.keys(payload.data).length > 0;
      canonicalPrivateLabel = Boolean(
        (await sessions.get(session.id))?.dataLabels.includes('private'),
      );
      if (isRecord(executed.output)) {
        const logId = executed.output.log_id ?? executed.output.execution_log_id;
        if (
          typeof logId === 'string' &&
          logId.length > 0 &&
          logId.length < 300 &&
          !logId.includes(cfg.apiKey!)
        )
          executionLogId = logId;
      }
    } catch {
      executionError =
        'The broker or upstream provider blocked the metadata read; no live pass claimed.';
    }
  } else if (catalogPassed) {
    executionError =
      'No connected bounded metadata read with schema-provided defaults was available; no arguments were guessed.';
  }
  const passed =
    catalogPassed &&
    authorization?.allowed === true &&
    executionLogId !== null &&
    usefulModelResult &&
    canonicalPrivateLabel;
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        product: 'Composio Platform',
        apiVersion: 'v3.1',
        mode: 'live',
        scope: 'authorized connected-account metadata read',
        status: passed ? 'passed' : 'failed',
        health: health.ok,
        registeredSchemas: tools.length,
        discoveredSchemas: discovery?.registered.length ?? 0,
        skippedSchemas: (report?.skipped.length ?? 0) + (discovery?.skipped.length ?? 0),
        requiresConnection: tools.filter(
          (tool) => tool.descriptor.availability === 'requires_connection',
        ).length,
        executableReadSchemas: tools.filter(
          (tool) =>
            tool.descriptor.baselineEffect === 'read' &&
            tool.descriptor.availability === 'available',
        ).length,
        toolId: candidate?.descriptor.id ?? null,
        authorization,
        resultFieldCount,
        usefulModelResult,
        canonicalPrivateLabel,
        ...(health.ok ? {} : { errorCode: health.error.code, message: health.error.message }),
        ...(report?.warning || discovery?.warning
          ? { message: report?.warning ?? discovery?.warning }
          : {}),
        requests: egress,
        executionLogId,
        ...(executionError
          ? { limitation: executionError }
          : !executionLogId
            ? {
                limitation:
                  'Provider execution did not return a usable log ID; no complete live pass claimed.',
              }
            : {}),
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Use only returned schema defaults; never invent a user/account/resource ID. */
function safeDefaults(schema: Json): Record<string, Json> | null {
  if (!isRecord(schema) || !isRecord(schema.properties)) return null;
  const args: Record<string, Json> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (isRecord(property) && property.default !== undefined) args[key] = property.default;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every((key) => typeof key === 'string' && key in args) ? args : null;
}
