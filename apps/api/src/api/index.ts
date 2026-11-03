/**
 * Route mounting. WRITTEN ONCE, fully populated — add a router here only when
 * you add a genuinely new resource. Keeping this file stable is what stops four
 * people conflicting on it.
 */

import type { Express } from 'express';
import { Router } from 'express';
import { approvalsRouter } from './approvals.routes.js';
import { benchmarksRouter } from './benchmarks.routes.js';
import { conversationsRouter } from './conversations.routes.js';
import { graphsRouter } from './graphs.routes.js';
import { providersRouter } from './providers.routes.js';
import { runsRouter } from './runs.routes.js';
import { streamRouter } from './stream.routes.js';
import { toolsRouter } from './tools.routes.js';
import { modelGatewayRouter } from './modelGateway.routes.js';
import { mcpGatewayRouter } from './mcp.routes.js';
import { mcpConnectionsRouter } from './mcpConnections.routes.js';
import { actionEvidenceRouter } from './actionEvidence.routes.js';
import { credentialsRouter } from './credentials.routes.js';
import { browserRouter } from './browser.routes.js';
import { tasksRouter } from './tasks.routes.js';
import { learningRouter } from './learning.routes.js';
import { runWorkspaceRouter } from './runWorkspace.routes.js';
import { requireLocalControl } from '../services/localControl.js';
import { createHarnessCallbackRouter, createObservedRouter } from './hooks.routes.js';
import { hookTokens } from '../core/hooks/hookTokens.js';
import { bus, modelGateway, store } from '../services/runtime.js';
import { createGatewayLedgerRouter } from './anthropicMessages.routes.js';
import { config } from '../config.js';

export function mountRoutes(app: Express): void {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  api.use(credentialsRouter);
  // Claude Code's HTTP hooks and OTel exporter call back from the harness process,
  // not the dashboard: no Origin, no local capability. The run-scoped token in the
  // path is their credential (401 when unknown, expired or for another harness).
  const harnessDeps = { tokens: hookTokens, store, emit: bus.emit.bind(bus) };
  api.use(createHarnessCallbackRouter(harnessDeps));
  // Every dashboard mutation shares the local capability/origin boundary,
  // including graph authoring and OAuth/MCP setup that can spend credentials.
  // Credential setup establishes that capability and validates Origin itself.
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) next();
    else requireLocalControl(req, res, next);
  });
  api.use(providersRouter);
  api.use(actionEvidenceRouter);
  api.use(browserRouter);
  api.use(graphsRouter);
  api.use(runsRouter);
  // The run page Workspace panel: diff, checkpoints, rewind.
  api.use(runWorkspaceRouter);
  // Graph vs baseline across stored runs; the Benchmarks page reads this.
  api.use(benchmarksRouter);
  api.use(approvalsRouter);
  // Coding-agent task board (dev-only seeded demo for now).
  api.use(tasksRouter);
  // Learning loop: the "What Zephyr learned" feed, signals, export and delete.
  api.use(learningRouter);
  // The chat that AUTHORS a graph. This is the workspace composer's endpoint --
  // without it the app's front door returns 404 and nothing can be created.
  api.use(conversationsRouter);
  api.use(streamRouter);
  api.use(toolsRouter);
  api.use(mcpConnectionsRouter);
  // Per-run /v1/messages accounting (tokens incl. cache reads/writes, hit rate).
  api.use(createGatewayLedgerRouter(() => modelGateway.messages));
  // Observed mode: mint a token + settings snippet for an unmodified Claude Code.
  api.use(createObservedRouter({ ...harnessDeps, apiBaseUrl: `http://127.0.0.1:${config.port}` }));

  // Hermes uses this OpenAI-compatible endpoint. It is intentionally outside
  // /api because SDK clients append /chat/completions to a /v1 base URL.
  app.use('/v1', modelGatewayRouter);
  app.use('/mcp', mcpGatewayRouter);
  app.use('/api', api);
}
