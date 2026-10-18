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
import { requireLocalControl } from '../services/localControl.js';

export function mountRoutes(app: Express): void {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  api.use(credentialsRouter);
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
  // Graph vs baseline across stored runs; the Benchmarks page reads this.
  api.use(benchmarksRouter);
  api.use(approvalsRouter);
  // The chat that AUTHORS a graph. This is the workspace composer's endpoint --
  // without it the app's front door returns 404 and nothing can be created.
  api.use(conversationsRouter);
  api.use(streamRouter);
  api.use(toolsRouter);
  api.use(mcpConnectionsRouter);

  // Hermes uses this OpenAI-compatible endpoint. It is intentionally outside
  // /api because SDK clients append /chat/completions to a /v1 base URL.
  app.use('/v1', modelGatewayRouter);
  app.use('/mcp', mcpGatewayRouter);
  app.use('/api', api);
}
