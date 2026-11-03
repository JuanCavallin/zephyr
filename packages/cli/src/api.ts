/**
 * A small client for Zephyr's HTTP API.
 *
 * Every non-GET `/api` route needs the local control capability: an HttpOnly cookie the
 * server sets from `POST /api/credentials/session` on a loopback connection. That route
 * requires an Origin header; the CLI sends the API's own origin, which the server
 * accepts as same-origin. The cookie is held in memory for this process only.
 */

export const DEFAULT_API = 'http://127.0.0.1:8787';
const COOKIE = 'agentos_local_control';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cookie: string | null = null;

  constructor(opts: ApiClientOptions = {}) {
    this.base = (opts.base ?? DEFAULT_API).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get origin(): string {
    return new URL(this.base).origin;
  }

  /** True when `/api/health` answers ok within the timeout. */
  async healthy(timeoutMs = 2_000): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.base + '/api/health', { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Obtain the local control cookie. Idempotent. */
  async session(): Promise<void> {
    if (this.cookie) return;
    const res = await this.fetchImpl(this.base + '/api/credentials/session', {
      method: 'POST',
      headers: { Origin: this.origin },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toError(res);
    const raw = setCookies(res).find((c) => c.trim().startsWith(COOKIE + '='));
    if (!raw) throw new ApiError(res.status, 'NO_SESSION', 'The server did not set a local control cookie.');
    this.cookie = raw.split(';')[0]!.trim();
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    await this.session();
    return this.call<T>('POST', path, body);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Origin: this.origin };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }
}

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

async function toError(res: Response): Promise<ApiError> {
  let code = 'HTTP_' + res.status;
  let message = res.statusText || 'request failed';
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } | string };
    if (typeof j.error === 'string') message = j.error;
    else if (j.error) {
      code = j.error.code ?? code;
      message = j.error.message ?? message;
    }
  } catch {
    // not JSON
  }
  return new ApiError(res.status, code, `${res.status} ${code}: ${message}`);
}
