import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  CreateMcpConnectionInput,
  DataLabel,
  Json,
  McpConnection,
  ToolDescriptor,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { RecordEgress } from '../../providers/withEgress.js';
import type { Store } from '../../store/types.js';
import type { InMemoryToolExecutorRegistry } from '../tools/executors.js';
import type { InMemoryToolRegistry } from '../tools/registry.js';

const READ_VERBS = new Set([
  'GET',
  'LIST',
  'READ',
  'SEARCH',
  'FIND',
  'FETCH',
  'QUERY',
  'LOOKUP',
  'VIEW',
  'CHECK',
  'STATUS',
]);
const WRITE_VERBS = new Set([
  'CREATE',
  'UPDATE',
  'PATCH',
  'ADD',
  'SET',
  'UPLOAD',
  'INSERT',
  'IMPORT',
  'MOVE',
  'RENAME',
  'ARCHIVE',
  'DRAFT',
]);
const IRREVERSIBLE_VERBS = new Set([
  'SEND',
  'POST',
  'PUBLISH',
  'SUBMIT',
  'REPLY',
  'FORWARD',
  'INVITE',
  'PAY',
  'PURCHASE',
  'TRANSFER',
  'EXECUTE',
  'RUN',
]);
const DESTRUCTIVE_VERBS = new Set([
  'DELETE',
  'REMOVE',
  'PURGE',
  'DROP',
  'REVOKE',
  'TERMINATE',
  'DEACTIVATE',
]);

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Json;
}

export class McpConnectionNotFoundError extends Error {
  constructor(id: string) {
    super('MCP connection not found: ' + id);
    this.name = 'McpConnectionNotFoundError';
  }
}

/**
 * Imports upstream MCP schemas into the same trusted registry used by every
 * other tool source. The model never receives a direct upstream client and all
 * calls still pass ToolBroker exact-action authorization.
 */
export class McpConnectionManager {
  private readonly registeredToolIds = new Map<string, Set<string>>();
  private readonly registeredExecutorRefs = new Map<string, Set<string>>();

  constructor(
    private readonly store: Store,
    private readonly registry: InMemoryToolRegistry,
    private readonly executors: InMemoryToolExecutorRegistry,
    private readonly recordEgress: RecordEgress,
    private readonly blockedUrls: string[] = [],
  ) {}

  async initialize(): Promise<void> {
    for (const connection of await this.store.listMcpConnections()) {
      if (!connection.enabled) continue;
      await this.refresh(connection.id).catch((error: unknown) => {
        console.warn(
          '[mcp-connections] refresh failed for ' + connection.name + ': ' + safeError(error),
        );
      });
    }
  }

  list(): Promise<McpConnection[]> {
    return this.store.listMcpConnections();
  }

  async get(id: string): Promise<McpConnection> {
    const connection = await this.store.getMcpConnection(id);
    if (!connection) throw new McpConnectionNotFoundError(id);
    return connection;
  }

  async create(input: CreateMcpConnectionInput): Promise<McpConnection> {
    const url = validateUrl(input.url, this.blockedUrls);
    const headerEnv = validateHeaderEnv(input.headerEnv ?? {});
    const duplicate = (await this.store.listMcpConnections()).find(
      (connection) => connection.url === url,
    );
    if (duplicate) throw new Error('An MCP connection already uses this URL.');
    const at = nowIso();
    const connection: McpConnection = {
      id: newId('mcp_conn'),
      name: input.name.trim(),
      url,
      transport: 'streamable_http',
      enabled: input.enabled ?? true,
      headerEnv,
      status: input.enabled === false ? 'disabled' : 'error',
      toolIds: [],
      executableToolIds: [],
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveMcpConnection(connection);
    return connection.enabled ? this.refresh(connection.id) : connection;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpConnection> {
    const current = await this.get(id);
    if (!enabled) {
      this.unregister(id);
      return this.store.saveMcpConnection({
        ...current,
        enabled: false,
        status: 'disabled',
        toolIds: [],
        executableToolIds: [],
        lastError: undefined,
        updatedAt: nowIso(),
      });
    }
    await this.store.saveMcpConnection({
      ...current,
      enabled: true,
      status: 'error',
      updatedAt: nowIso(),
    });
    return this.refresh(id);
  }

  async remove(id: string): Promise<boolean> {
    await this.get(id);
    this.unregister(id);
    return this.store.deleteMcpConnection(id);
  }

  async candidateToolIds(): Promise<string[]> {
    return (await this.store.listMcpConnections())
      .filter((connection) => connection.enabled && connection.status === 'connected')
      .flatMap((connection) => connection.executableToolIds);
  }

  async refresh(id: string): Promise<McpConnection> {
    const connection = await this.get(id);
    if (!connection.enabled) return connection;

    this.unregister(id);
    try {
      const remoteTools = await this.listRemoteTools(connection);
      const toolIds = new Set<string>();
      const executorRefs = new Set<string>();
      const executableToolIds: string[] = [];
      const skipped: string[] = [];

      for (const tool of remoteTools) {
        try {
          const registered = this.registerTool(connection, tool);
          toolIds.add(registered.descriptor.id);
          if (registered.executable) {
            executableToolIds.push(registered.descriptor.id);
            executorRefs.add(registered.descriptor.executorRef);
          }
        } catch (error) {
          skipped.push(tool.name + ': ' + safeError(error));
        }
      }

      this.registeredToolIds.set(id, toolIds);
      this.registeredExecutorRefs.set(id, executorRefs);
      const at = nowIso();
      return this.store.saveMcpConnection({
        ...connection,
        status: 'connected',
        toolIds: [...toolIds].sort(),
        executableToolIds: [...new Set(executableToolIds)].sort(),
        lastError: skipped.length > 0 ? skipped.slice(0, 5).join('; ') : undefined,
        lastRefreshedAt: at,
        updatedAt: at,
      });
    } catch (error) {
      const at = nowIso();
      await this.store.saveMcpConnection({
        ...connection,
        status: 'error',
        toolIds: [],
        executableToolIds: [],
        lastError: safeError(error),
        lastRefreshedAt: at,
        updatedAt: at,
      });
      throw error;
    }
  }

  private async listRemoteTools(connection: McpConnection): Promise<RemoteTool[]> {
    return this.withClient(connection, 20_000, async (client) => {
      const listed = await client.listTools();
      return listed.tools.flatMap((tool) => {
        if (!tool.name || !tool.inputSchema || typeof tool.inputSchema !== 'object') return [];
        return [
          {
            name: tool.name,
            description: tool.description,
            inputSchema: toJson(tool.inputSchema),
          },
        ];
      });
    });
  }

  private registerTool(
    connection: McpConnection,
    tool: RemoteTool,
  ): { descriptor: ToolDescriptor; executable: boolean } {
    const classification = classifyName(tool.name);
    const connectionSlug = normalize(connection.name) || normalize(connection.id);
    const toolSlug = normalize(tool.name);
    if (!toolSlug) throw new Error('tool name cannot be normalized');
    const id = 'mcp.' + connectionSlug + '.' + toolSlug;
    const version = createHash('sha256')
      .update(JSON.stringify({ name: tool.name, inputSchema: tool.inputSchema }))
      .digest('hex')
      .slice(0, 16);
    const executable = classification.effect !== 'unknown';
    const scope = 'mcp:connected:' + connection.id;
    const executorRef =
      'mcp://' + connection.id + '/' + encodeURIComponent(tool.name) + '@' + version;
    const descriptor: ToolDescriptor = {
      id,
      version,
      providerId: 'mcp',
      family: connectionSlug,
      // Provider descriptions are untrusted. Keep selection metadata derived
      // from stable names instead of forwarding arbitrary instructions to Jev.
      description: 'Operation ' + tool.name + ' on MCP connection ' + connection.name + '.',
      inputSchemaRef: 'mcp://' + connection.id + '/schemas/' + encodeURIComponent(tool.name),
      transport: 'mcp',
      baselineEffect: classification.effect,
      reversibility: classification.reversibility,
      requiredScopes: [scope],
      allowedDataLabels: allowedLabels(connection.url),
      availability: executable ? 'available' : 'unavailable',
      executorRef,
      credentialRef: 'mcp-connection:' + connection.id,
      requiresChangeReview: classification.effect !== 'read',
    };
    this.registry.register({
      descriptor,
      wireName: stableWireName(id),
      inputSchema: tool.inputSchema,
      grantedScopes: [scope],
    });

    if (executable) {
      this.executors.register({
        ref: executorRef,
        destinationFor: () => connection.url,
        execute: async (action, ctx) => {
          const started = Date.now();
          try {
            const result = await this.withClient(
              connection,
              45_000,
              (client) =>
                client.callTool({
                  name: tool.name,
                  arguments: asArguments(action.arguments),
                }),
              ctx.signal,
            );
            if (result.isError) throw new Error('MCP server reported tool failure.');
            return {
              output: { tool: descriptor.id, providerReported: true },
              summary: 'Completed ' + descriptor.id + ' through ' + connection.name + '.',
              dataLabels: [...action.dataLabels],
              verified: classification.effect === 'read',
              evidenceVerified: false,
              executionMode: 'live',
            };
          } catch {
            // Remote error payloads can echo document bodies or credentials.
            // The broker records outcome uncertainty without exposing that text.
            throw new Error('MCP tool request failed or was cancelled.');
          } finally {
            await this.recordEgress({
              id: newId('egr'),
              runId: ctx.runId,
              stepId: ctx.stepId,
              providerId: 'mcp',
              op: 'callTool:' + tool.name,
              destination: connection.url,
              dataSpans: ctx.redactions ?? [],
              policyRule: ctx.policyRule,
              latencyMs: Date.now() - started,
            });
          }
        },
      });
    }

    return { descriptor, executable };
  }

  private async withClient<T>(
    connection: McpConnection,
    timeoutMs: number,
    work: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = resolveHeaders(connection.headerEnv);
    const client = new Client({ name: 'agentos-' + connection.id, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: {
        headers,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
    });
    try {
      await client.connect(transport);
      return await work(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private unregister(connectionId: string): void {
    for (const toolId of this.registeredToolIds.get(connectionId) ?? []) {
      this.registry.unregister(toolId);
    }
    for (const executorRef of this.registeredExecutorRefs.get(connectionId) ?? []) {
      this.executors.unregister(executorRef);
    }
    this.registeredToolIds.delete(connectionId);
    this.registeredExecutorRefs.delete(connectionId);
  }
}

function classifyName(name: string): {
  effect: ToolDescriptor['baselineEffect'];
  reversibility: ToolDescriptor['reversibility'];
} {
  if (
    /COMPOSIO_(?:MULTI_EXECUTE|REMOTE_WORKBENCH|REMOTE_BASH)|(?:^|_)RUN_CODE(?:_|$)|(?:^|_)EXECUTE_CODE(?:_|$)/i.test(
      name,
    )
  )
    return { effect: 'unknown', reversibility: 'irreversible' };
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (tokens.some((token) => DESTRUCTIVE_VERBS.has(token))) {
    return { effect: 'destructive', reversibility: 'irreversible' };
  }
  if (tokens.some((token) => IRREVERSIBLE_VERBS.has(token))) {
    return { effect: 'write', reversibility: 'irreversible' };
  }
  if (tokens.some((token) => WRITE_VERBS.has(token))) {
    return { effect: 'write', reversibility: 'recoverable' };
  }
  if (tokens.some((token) => READ_VERBS.has(token))) {
    return { effect: 'read', reversibility: 'reversible' };
  }
  return { effect: 'unknown', reversibility: 'irreversible' };
}

function allowedLabels(url: string): DataLabel[] {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    ? ['public', 'private', 'secret', 'local_only']
    : ['public', 'private'];
}

function validateUrl(value: string, blockedUrls: string[]): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP(S) Streamable MCP servers are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP credentials must use headerEnv, not URL userinfo.');
  }
  parsed.hash = '';
  const normalized = parsed.toString();
  if (blockedUrls.some((blocked) => normalizeUrl(blocked) === normalizeUrl(normalized))) {
    throw new Error('The AgentOS downstream MCP gateway cannot be added as an upstream server.');
  }
  return normalized;
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function validateHeaderEnv(value: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [header, envName] of Object.entries(value)) {
    const normalizedHeader = header.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(normalizedHeader)) {
      throw new Error('Invalid MCP header name: ' + header);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
      throw new Error('MCP header values must reference uppercase environment names.');
    }
    output[normalizedHeader] = envName;
  }
  return output;
}

function resolveHeaders(headerEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headerEnv).map(([header, envName]) => {
      const value = process.env[envName];
      if (!value) throw new Error('Missing environment variable for MCP header: ' + envName);
      return [header, value];
    }),
  );
}

function stableWireName(toolId: string): string {
  const normalized = toolId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized.length <= 48) return normalized;
  return (
    normalized.slice(0, 39) + '_' + createHash('sha256').update(toolId).digest('hex').slice(0, 8)
  );
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asArguments(value: Json): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP tool arguments must be an object.');
  }
  return value;
}

function toJson(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJson(child)]));
  }
  return String(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown MCP connection error.';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}
