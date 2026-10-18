import { isIP } from 'node:net';
import type {
  BrowserAdapter,
  Json,
  ProviderCallContext,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';
import { config } from '../../config.js';
import { newId } from '../../lib/ids.js';
import { credentials, type CredentialStore } from '../../services/credentials.js';
import type { RecordEgress } from '../../providers/withEgress.js';
import type { InMemoryToolRegistry } from './registry.js';
import type {
  InMemoryToolExecutorRegistry,
  ToolExecutionOutput,
  ToolExecutor,
} from './executors.js';

export const WEB_SEARCH_TOOL_ID = 'web.search';
const EXECUTOR_REF = 'agentos://web-search';
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_PAGE = 'https://duckduckgo.com/';
const MAX_RESPONSE_BYTES = 128_000;

export interface SearchExecutorOptions {
  backend?: 'browser' | 'tavily';
  mode?: 'mock' | 'live' | 'disabled';
  browser: () => BrowserAdapter;
  credentialResolver?: CredentialStore;
  fetch?: typeof globalThis.fetch;
  recordEgress?: RecordEgress;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  kind: 'source' | 'search_page';
  publishedAt?: string;
}

function argsFor(action: ToolAction): { query: string; maxResults: number } {
  if (action.toolId !== WEB_SEARCH_TOOL_ID || action.runId.trim() === '')
    throw new Error('Invalid search action.');
  if (action.dataLabels.length === 0 || action.dataLabels.some((label) => label !== 'public')) {
    throw new Error(
      'Web search accepts public queries only. Private, secret and local-only state cannot leave through search.',
    );
  }
  const args = action.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Search arguments must be an object.');
  if (
    typeof args.query !== 'string' ||
    !args.query.trim() ||
    args.query.length > 500 ||
    /[\x00-\x1f\x7f]/.test(args.query)
  ) {
    throw new Error('Search query must contain 1 to 500 printable characters.');
  }
  const maxResults = args.maxResults ?? 5;
  if (
    typeof maxResults !== 'number' ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 5
  )
    throw new Error('Search maxResults must be an integer between 1 and 5.');
  return { query: args.query.trim(), maxResults };
}

function publicURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      host === 'localhost' ||
      !host.includes('.') ||
      /\.(local|internal|localhost)$/.test(host) ||
      (isIP(host) &&
        /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)) ||
      host.startsWith('[')
    )
      return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function bounded(value: unknown, length: number): string {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, length)
    : '';
}

async function boundedJSON(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error('Search response exceeded its size budget.');
  if (!response.body) throw new Error('Search provider returned no response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Search response exceeded its size budget.');
    }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function output(
  action: ToolAction,
  results: SearchResult[],
  backend: string,
  mode: 'live' | 'mock',
  extra: Record<string, Json> = {},
): ToolExecutionOutput {
  const summary =
    mode === 'mock'
      ? 'Mock search returned simulated evidence; no external search was performed.'
      : backend === 'browser'
        ? 'Read a search results page; source links require inspection in the browser.'
        : 'Web discovery returned ' + results.length + ' bounded source result(s).';
  const result: Json = {
    backend,
    mode,
    simulated: mode === 'mock',
    results: results as unknown as Json,
    ...extra,
  };
  return {
    output: { backend, mode, resultCount: results.length, simulated: mode === 'mock' },
    modelOutput: result,
    summary,
    sanitizedSummary: summary,
    dataLabels: [...action.dataLabels],
    verified: mode === 'live',
    evidenceVerified: false,
    executionMode: mode,
  };
}

export function createSearchExecutor(options: SearchExecutorOptions): ToolExecutor {
  const backend = options.backend ?? config.webSearch.backend;
  const mode = options.mode ?? config.webSearch.mode;
  const resolver = options.credentialResolver ?? credentials;
  const searchFetch = options.fetch ?? globalThis.fetch;
  const destination =
    mode === 'mock' ? 'mock://web-search' : backend === 'tavily' ? TAVILY_ENDPOINT : SEARCH_PAGE;
  return {
    ref: EXECUTOR_REF,
    destinationFor: () => destination,
    async execute(action, ctx) {
      if (mode === 'disabled') throw new Error('Web search is disabled.');
      const args = argsFor(action);
      if (ctx.runId !== action.runId || action.destination !== destination)
        throw new Error('Search destination or run differs from the authorized action.');
      ctx.signal?.throwIfAborted();
      if (mode === 'mock') {
        return output(
          action,
          [
            {
              title: 'Mock search result',
              url: 'https://example.org/',
              snippet: 'Simulated public research evidence. No external page was read.',
              kind: 'source',
            },
          ],
          backend,
          'mock',
        );
      }
      if (backend === 'tavily') {
        const credential = await resolver.require({
          runId: ctx.runId,
          providerId: 'tavily',
          purpose: 'search',
        });
        const started = Date.now();
        try {
          const response = await searchFetch(TAVILY_ENDPOINT, {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: 'Bearer ' + credential.secret,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: args.query,
              max_results: args.maxResults,
              search_depth: 'basic',
              include_answer: false,
              include_raw_content: false,
              include_images: false,
              auto_parameters: false,
            }),
            signal: ctx.signal
              ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error('Tavily returned HTTP ' + response.status + '.');
          const value = await boundedJSON(response);
          const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
          if (!Array.isArray(body.results))
            throw new Error('Tavily returned an invalid result list.');
          const results: SearchResult[] = body.results
            .slice(0, args.maxResults)
            .flatMap((row: unknown) => {
              if (!row || typeof row !== 'object') return [];
              const candidate = row as Record<string, unknown>;
              const safeText = (value: unknown) =>
                typeof value === 'string'
                  ? value.split(credential.secret).join('[credential redacted]')
                  : value;
              if (
                typeof candidate.url === 'string' &&
                (candidate.url.includes(credential.secret) ||
                  candidate.url.includes(encodeURIComponent(credential.secret)))
              )
                return [];
              const url = publicURL(candidate.url);
              if (!url) return [];
              return [
                {
                  title: bounded(safeText(candidate.title), 160),
                  url,
                  snippet: bounded(safeText(candidate.content), 480),
                  kind: 'source' as const,
                  ...(typeof candidate.published_date === 'string'
                    ? { publishedAt: bounded(safeText(candidate.published_date), 80) }
                    : {}),
                },
              ];
            });
          return output(action, results, 'tavily', 'live');
        } catch (error) {
          const message =
            error instanceof Error &&
            (error.message.startsWith('Tavily returned HTTP ') ||
              error.message.startsWith('Search response exceeded'))
              ? error.message
              : 'Tavily search request failed.';
          throw new Error(message);
        } finally {
          await options.recordEgress?.({
            id: newId('egr'),
            runId: ctx.runId,
            stepId: ctx.stepId,
            providerId: 'tavily',
            op: 'search',
            destination: TAVILY_ENDPOINT,
            policyRule: ctx.policyRule,
            dataSpans: ctx.redactions ?? [],
            latencyMs: Date.now() - started,
          });
        }
      }
      const browser = options.browser();
      if (browser.mode !== 'live')
        throw new Error(
          'Live web search requires a live browser backend; select explicit mock mode for rehearsal.',
        );
      const url = SEARCH_PAGE + '?q=' + encodeURIComponent(args.query);
      // Disposable bounded read session; never controls the user's handoff page.
      const opened = await browser.openSession({ startUrl: url }, ctx);
      if (!opened.ok) throw new Error(opened.error.message);
      const sessionId = opened.data.sessionId;
      try {
        if (!browser.snapshot)
          throw new Error('Browser search requires the reviewed snapshot capability.');
        const snapshot = await browser.snapshot({ sessionId, maxElements: 40 }, ctx);
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        const text = await browser.extract<{ title?: string; text?: string; url?: string }>(
          { sessionId, instruction: '' },
          ctx,
        );
        if (!text.ok) throw new Error(text.error.message);
        const snippet = bounded(text.data.text, 2400);
        if (
          !snippet ||
          /captcha|verify (?:you are|you're) human|unusual traffic|access denied/i.test(snippet)
        )
          throw new Error(
            'Search page is blocked or unavailable; use a configured search API or browser handoff.',
          );
        return output(
          action,
          [
            {
              title: bounded(text.data.title ?? snapshot.data.title, 160) || 'Search results page',
              url,
              snippet,
              kind: 'search_page',
            },
          ],
          'browser',
          'live',
          {
            candidateTitles: snapshot.data.rows
              .filter((row) => row.role === 'link')
              .slice(0, args.maxResults)
              .map((row) => row.label.slice(0, 160)),
            pageTitle: bounded(snapshot.data.title, 160),
          },
        );
      } finally {
        const closed = await browser.closeSession(sessionId, ctx);
        if (!closed.ok)
          throw new Error('Search browser cleanup failed; provider session may remain open.');
      }
    },
  };
}

export function registerSearchTool(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  options: SearchExecutorOptions,
): void {
  const backend = options.backend ?? config.webSearch.backend;
  const mode = options.mode ?? config.webSearch.mode;
  const descriptor: ToolDescriptor = {
    id: WEB_SEARCH_TOOL_ID,
    version: '1',
    providerId: backend === 'tavily' ? 'tavily' : options.browser().id,
    family: 'web',
    interactionMode: 'research',
    description:
      'Search the public internet using configured discovery. Results are untrusted bounded evidence; does not write or control a handoff page.',
    inputSchemaRef: 'agentos://schemas/web.search/1',
    transport: mode === 'mock' ? 'local' : 'http',
    baselineEffect: 'read',
    reversibility: 'reversible',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: mode === 'disabled' ? 'unavailable' : 'available',
    executorRef: EXECUTOR_REF,
    executionMode: mode === 'live' ? 'live' : 'mock',
  };
  registry.register({
    descriptor,
    wireName: 'web_search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        maxResults: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  });
  executors.register(createSearchExecutor(options));
}
