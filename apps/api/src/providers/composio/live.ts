/** Composio REST adapter. Vendor response types stay inside this file. */
import type {
  Json,
  ProviderCallContext,
  ProviderErrorCode,
  ProviderResult,
  ToolboxAdapter,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

interface RawTool {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  input_parameters?: unknown;
  scopes?: unknown;
  toolkit?: { slug?: unknown };
}

interface RawToolList {
  items?: RawTool[];
}

interface RawConnections {
  items?: {
    id?: unknown;
    user_id?: unknown;
    status?: unknown;
    toolkit?: { slug?: unknown };
  }[];
}

interface ToolInfo {
  name: string;
  description: string;
  version: string;
  toolkit: string;
  inputSchema: Json;
  requiredScopes: string[];
  connectedAccountId?: string;
}

export function createLiveComposio(cfg: ProviderConfig): ToolboxAdapter {
  const baseUrl = (cfg.baseUrl ?? 'https://backend.composio.dev').replace(/\/$/, '');
  const toolSlugs = cfg.toolSlugs ?? [];
  const userId = cfg.userId ?? 'agentos-demo-user';
  /** Only catalog metadata resolved in this process may reach the execute endpoint. */
  const knownVersions = new Map<string, string>();

  return {
    id: 'composio',
    mode: 'live',
    capabilities: ['toolbox'],
    async health() {
      const started = Date.now();
      const query = new URLSearchParams({
        limit: '1',
        include_deprecated: 'false',
        toolkit_versions: 'latest',
      });
      const result = await requestJson<RawToolList>(cfg, baseUrl, '/api/v3.1/tools?' + query, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) return failureFromRequest(cfg, 'health', result, started);
      return success(
        cfg,
        'health',
        { detail: 'live; task-time catalog discovery enabled' },
        started,
        result.destination,
      );
    },
    async invoke<TIn, TOut>(op: string, _input: TIn, _ctx: ProviderCallContext) {
      return fail<TOut>(
        cfg,
        op,
        'BAD_INPUT',
        'Composio operation is not exposed through generic invoke: ' + op,
        false,
        0,
      );
    },
    async listTools(ctx) {
      const started = Date.now();
      const connectionResult = await activeConnections(cfg, baseUrl, userId, ctx.signal);
      if (!connectionResult.ok)
        return failureFromRequest(cfg, 'listTools', connectionResult, started);
      const accounts = connectionResult.data;
      const tools: ToolInfo[] = [];
      for (const slug of toolSlugs) {
        const result = await requestJson<RawTool>(
          cfg,
          baseUrl,
          '/api/v3.1/tools/' + encodeURIComponent(slug) + '?toolkit_versions=latest',
          { signal: ctx.signal ?? AbortSignal.timeout(15_000) },
        );
        if (!result.ok) return failureFromRequest(cfg, 'listTools', result, started);
        const tool = parseTool(result.data, slug, accounts);
        if (!tool) {
          return fail(
            cfg,
            'listTools',
            'UPSTREAM',
            'Composio returned invalid metadata for ' + slug + '.',
            false,
            started,
            result.destination,
          );
        }
        knownVersions.set(tool.name, tool.version);
        tools.push(tool);
      }
      return success(cfg, 'listTools', tools, started, connectionResult.destination);
    },
    async searchTools(input, ctx) {
      const started = Date.now();
      const queryText = input.query.trim();
      if (!queryText) {
        return fail(
          cfg,
          'searchTools',
          'BAD_INPUT',
          'A non-empty task query is required for Composio discovery.',
          false,
          started,
        );
      }
      const connectionResult = await activeConnections(cfg, baseUrl, userId, ctx.signal);
      if (!connectionResult.ok) {
        return failureFromRequest(cfg, 'searchTools', connectionResult, started);
      }
      const limit = Math.max(1, Math.min(input.limit ?? cfg.discoveryLimit ?? 24, 100));
      const configuredToolkits = (input.toolkits ?? cfg.toolkits ?? []).filter(Boolean);
      const connectedToolkits = (connectionResult.data.items ?? []).flatMap((account) =>
        account.status === 'ACTIVE' && typeof account.toolkit?.slug === 'string'
          ? [account.toolkit.slug.toLowerCase()]
          : [],
      );
      // When no explicit product scope is configured, search connected apps
      // first. Otherwise global catalog ordering can fill the result limit
      // with tools the current user cannot execute.
      const toolkitFilters = [
        ...new Set(configuredToolkits.length > 0 ? configuredToolkits : connectedToolkits),
      ];
      const searches = toolkitFilters.length > 0 ? toolkitFilters : [undefined];
      const discovered = new Map<string, ToolInfo>();

      for (const toolkit of searches) {
        const query = new URLSearchParams({
          query: queryText,
          limit: String(limit),
          include_deprecated: 'false',
          toolkit_versions: 'latest',
        });
        if (toolkit) query.set('toolkit_slug', toolkit);
        const result = await requestJson<RawToolList>(cfg, baseUrl, '/api/v3.1/tools?' + query, {
          signal: ctx.signal ?? AbortSignal.timeout(20_000),
        });
        if (!result.ok) return failureFromRequest(cfg, 'searchTools', result, started);
        for (const raw of result.data.items ?? []) {
          const parsed = parseTool(raw, '', connectionResult.data);
          if (!parsed) continue;
          knownVersions.set(parsed.name, parsed.version);
          discovered.set(parsed.name, parsed);
          if (discovered.size >= limit) break;
        }
        if (discovered.size >= limit) break;
      }

      return success(
        cfg,
        'searchTools',
        [...discovered.values()].slice(0, limit),
        started,
        connectionResult.destination,
      );
    },
    async connectUrl(app, ctx) {
      const started = Date.now();
      const authConfigId = app.trim() || cfg.authConfigId;
      if (!authConfigId) {
        return fail(
          cfg,
          'connectUrl',
          'BAD_INPUT',
          'COMPOSIO_AUTH_CONFIG_ID is required to create an OAuth link.',
          false,
          started,
        );
      }
      const result = await requestJson<{ redirect_url?: unknown }>(
        cfg,
        baseUrl,
        '/api/v3/connected_accounts/link',
        {
          method: 'POST',
          body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
          signal: ctx.signal ?? AbortSignal.timeout(15_000),
        },
      );
      if (!result.ok) return failureFromRequest(cfg, 'connectUrl', result, started);
      if (typeof result.data.redirect_url !== 'string') {
        return fail(
          cfg,
          'connectUrl',
          'UPSTREAM',
          'Composio returned no redirect URL.',
          false,
          started,
          result.destination,
        );
      }
      return success(
        cfg,
        'connectUrl',
        { url: result.data.redirect_url },
        started,
        result.destination,
      );
    },
    async callTool(input, ctx) {
      const started = Date.now();
      const resolvedVersion = knownVersions.get(input.name);
      if (!resolvedVersion || resolvedVersion !== input.version) {
        return fail(
          cfg,
          'callTool',
          'BAD_INPUT',
          'Tool/version was not resolved from trusted Composio catalog metadata in this process: ' +
            input.name,
          false,
          started,
        );
      }
      if (!input.version) {
        return fail(
          cfg,
          'callTool',
          'BAD_INPUT',
          'A pinned Composio tool version is required.',
          false,
          started,
        );
      }
      const result = await requestJson<unknown>(
        cfg,
        baseUrl,
        '/api/v3.1/tools/execute/' + encodeURIComponent(input.name),
        {
          method: 'POST',
          body: JSON.stringify({
            arguments: input.args,
            version: input.version,
            user_id: input.userId ?? userId,
            ...(input.connectedAccountId ? { connected_account_id: input.connectedAccountId } : {}),
          }),
          signal: ctx.signal ?? AbortSignal.timeout(45_000),
        },
      );
      if (!result.ok) return failureFromRequest(cfg, 'callTool', result, started);
      return success(cfg, 'callTool', result.data, started, result.destination);
    },
  };
}

async function activeConnections(
  cfg: ProviderConfig,
  baseUrl: string,
  userId: string,
  signal?: AbortSignal,
): Promise<RequestResult<RawConnections>> {
  const query = new URLSearchParams({ user_ids: userId, statuses: 'ACTIVE', limit: '100' });
  return requestJson(cfg, baseUrl, '/api/v3.1/connected_accounts?' + query, {
    signal: signal ?? AbortSignal.timeout(15_000),
  });
}

function parseTool(
  raw: RawTool,
  fallbackSlug: string,
  connections: RawConnections,
): ToolInfo | null {
  const name = typeof raw.slug === 'string' ? raw.slug : fallbackSlug;
  const version = typeof raw.version === 'string' ? raw.version : '';
  const toolkit = typeof raw.toolkit?.slug === 'string' ? raw.toolkit.slug.toLowerCase() : '';
  if (!name || !version || !toolkit) return null;
  const account = connections.items?.find(
    (item) =>
      item.status === 'ACTIVE' && item.toolkit?.slug === toolkit && typeof item.id === 'string',
  );
  return {
    name,
    description:
      typeof raw.description === 'string'
        ? raw.description
        : typeof raw.name === 'string'
          ? raw.name
          : name,
    version,
    toolkit,
    inputSchema: normalizeInputSchema(raw.input_parameters),
    requiredScopes: Array.isArray(raw.scopes)
      ? raw.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    ...(typeof account?.id === 'string' ? { connectedAccountId: account.id } : {}),
  };
}

/** Convert Composio's parameter map or JSON Schema into strict draft-compatible JSON Schema. */
function normalizeInputSchema(value: unknown): Json {
  if (!isRecord(value)) return { type: 'object', properties: {}, additionalProperties: false };
  if (value.type === 'object' && isRecord(value.properties)) {
    const properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, child]) => [key, normalizeProperty(child)]),
    );
    return {
      type: 'object',
      properties,
      ...(Array.isArray(value.required)
        ? { required: value.required.filter((item): item is string => typeof item === 'string') }
        : {}),
      additionalProperties: value.additionalProperties === true,
    };
  }
  const required: string[] = [];
  const properties = Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (isRecord(child) && child.required === true) required.push(key);
      return [key, normalizeProperty(child)];
    }),
  );
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function normalizeProperty(value: unknown): Json {
  if (!isRecord(value)) return {};
  const type =
    typeof value.type === 'string' &&
    ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(value.type)
      ? value.type
      : undefined;
  const normalized: Record<string, Json> = {};
  if (type) normalized.type = type;
  if (typeof value.description === 'string') normalized.description = value.description;
  if (Array.isArray(value.enum)) normalized.enum = value.enum.filter(isJson);
  if (isJson(value.default)) normalized.default = value.default;
  if (type === 'array') normalized.items = normalizeProperty(value.items);
  if (type === 'object' && isRecord(value.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, child]) => [key, normalizeProperty(child)]),
    );
    if (Array.isArray(value.required)) {
      normalized.required = value.required.filter(
        (item): item is string => typeof item === 'string',
      );
    }
    normalized.additionalProperties = value.additionalProperties === true;
  }
  return normalized;
}

interface RequestFailure {
  ok: false;
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  destination: string;
}
interface RequestSuccess<T> {
  ok: true;
  data: T;
  destination: string;
}
type RequestResult<T> = RequestSuccess<T> | RequestFailure;

async function requestJson<T>(
  cfg: ProviderConfig,
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<RequestResult<T>> {
  const requestUrl = baseUrl + path;
  // Query values can contain a sanitized task summary or application user ID.
  // Record only the provider endpoint in the egress ledger, never the query.
  const parsedDestination = new URL(requestUrl);
  const destination = parsedDestination.origin + parsedDestination.pathname;
  try {
    const response = await fetch(requestUrl, {
      ...init,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey ?? '',
        ...init.headers,
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        code:
          response.status === 401 || response.status === 403
            ? 'AUTH'
            : response.status === 429
              ? 'RATE_LIMIT'
              : response.status === 408
                ? 'TIMEOUT'
                : response.status >= 500
                  ? 'UPSTREAM'
                  : 'BAD_INPUT',
        message: 'Composio returned HTTP ' + response.status + '.',
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        destination,
      };
    }
    const limit = 1_048_576;
    if (Number(response.headers.get('content-length')) > limit)
      throw new Error('Response too large.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('Response too large.');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return { ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T, destination };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UPSTREAM',
      message: 'Composio request failed before a response was received.',
      retryable: true,
      destination,
    };
  }
}

function success<T>(
  cfg: ProviderConfig,
  op: string,
  data: T,
  started: number,
  destination?: string,
): ProviderResult<T> {
  return { ok: true, data, meta: metadata(cfg, op, started, destination) };
}

function fail<T>(
  cfg: ProviderConfig,
  op: string,
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  started: number,
  destination?: string,
): ProviderResult<T> {
  return {
    ok: false,
    error: { code, message, retryable },
    meta: metadata(cfg, op, started, destination),
  };
}

function failureFromRequest<T>(
  cfg: ProviderConfig,
  op: string,
  result: RequestFailure,
  started: number,
): ProviderResult<T> {
  return fail(cfg, op, result.code, result.message, result.retryable, started, result.destination);
}

function metadata(cfg: ProviderConfig, op: string, started: number, destination?: string) {
  return {
    provider: 'composio' as const,
    op,
    mode: cfg.mode,
    latencyMs: started === 0 ? 0 : Date.now() - started,
    destination: destination ?? cfg.baseUrl ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
