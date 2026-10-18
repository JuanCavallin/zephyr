/**
 * The tool catalog, for the graph editor's per-node tool picker.
 *
 * Served from AgentOS's reviewed registry. Provider-native slugs and unreviewed
 * tools never become graph/harness candidates merely because Composio lists them.
 */

import { Router } from 'express';
import { composioToolCatalog, toolRegistry } from '../services/runtime.js';

export const toolsRouter: Router = Router();

toolsRouter.get('/tools', async (_req, res) => {
  const tools = (await toolRegistry.list()).map((tool) => ({
    name: tool.descriptor.id,
    description: tool.descriptor.description,
    availability: tool.descriptor.availability,
    // Additive: lets a client say WHICH provider owns a tool (Composio, browser, MCP)
    // without guessing from the id.
    providerId: tool.descriptor.providerId,
    family: tool.descriptor.family,
    effect: tool.descriptor.baselineEffect,
    reversibility: tool.descriptor.reversibility,
    // Additive: lets a client mark simulated tools (a mocked backend) as such.
    ...(tool.descriptor.executionMode ? { executionMode: tool.descriptor.executionMode } : {}),
  }));
  // Startup and connection lifecycle operations populate this registry; a
  // catalog read never performs provider discovery itself.
  res.json({ tools, cached: true });
});

/** Preview/register task-relevant catalog entries for the dashboard tool picker. */
toolsRouter.post('/tools/discover', async (req, res) => {
  const query = req.body && typeof req.body.query === 'string' ? req.body.query.trim() : '';
  if (!query) {
    res.status(400).json({ error: { code: 'BAD_INPUT', message: 'query is required' } });
    return;
  }
  const toolkits = Array.isArray(req.body?.toolkits)
    ? req.body.toolkits.filter((item: unknown): item is string => typeof item === 'string')
    : undefined;
  const limit =
    typeof req.body?.limit === 'number' && Number.isInteger(req.body.limit)
      ? req.body.limit
      : undefined;
  const report = await composioToolCatalog.discoverForTask({
    query,
    runId: 'sys_tool_catalog_search',
    toolkits,
    limit,
  });
  const registered = await toolRegistry.resolve(report.registered);
  res.status(report.warning ? 502 : 200).json({
    ...report,
    tools: registered.map((tool) => ({
      id: tool.id,
      family: tool.family,
      effect: tool.baselineEffect,
      reversibility: tool.reversibility,
      availability: tool.availability,
      description: tool.description,
    })),
  });
});
