/**
 * The tool catalog the graph SYNTHESISER is shown.
 *
 * Rebuilt against the AgentOS tool registry after the control-plane merge. The
 * previous version read the old tool plane (`createToolPlane`), which no longer
 * exists; the registry is now the trusted source of what tools are real, so
 * this reads that instead of a second catalog of its own.
 *
 * Browser, local, Composio and MCP descriptors all come from the reviewed
 * registry. Provider-native slugs cannot become executable graph choices
 * without a registered schema, scope check and exact-action broker.
 *
 * NEVER returns schemas. Descriptor metadata only -- full input schemas stay
 * server-side, which is the registry's own rule (see core/tools/registry.ts).
 */

import type { ToolCatalogEntry } from '../core/graph/synthesisPrompt.js';
import { toolRegistry } from './runtime.js';

/** Registry descriptors, as catalog entries. Unavailable tools are omitted. */
async function fromRegistry(): Promise<ToolCatalogEntry[]> {
  const registered = await toolRegistry.list();
  return registered
    .filter((tool) => tool.descriptor.availability === 'available')
    .map((tool) => ({
      name: tool.descriptor.id,
      description: tool.descriptor.description,
      group: tool.descriptor.family,
      ...(tool.descriptor.interactionMode
        ? { interactionMode: tool.descriptor.interactionMode }
        : {}),
    }));
}

export async function listToolCatalog(_conversationId: string): Promise<ToolCatalogEntry[]> {
  const cached = catalogCache;
  if (cached && cached.expiresAt > Date.now()) return cached.tools.map((tool) => ({ ...tool }));

  const tools = await fromRegistry();
  catalogCache = { tools, expiresAt: Date.now() + 30_000 };
  return tools.map((tool) => ({ ...tool }));
}

/** Catalog metadata changes much less often than chat messages. A short TTL
 * removes repeated provider-list calls while still picking up new MCP/Composio
 * connections without a process restart. */
let catalogCache: { tools: ToolCatalogEntry[]; expiresAt: number } | undefined;

export function invalidateToolCatalogCache(): void {
  catalogCache = undefined;
}
