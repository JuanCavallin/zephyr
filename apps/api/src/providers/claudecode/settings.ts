/**
 * Claude Code settings Zephyr generates.
 *
 * MANAGED (Zephyr starts Claude Code over ACP): a per-run `settings.json` written to
 * the run's private `CLAUDE_CONFIG_DIR`, never into the worktree. Its HTTP hooks post
 * to `/api/hooks/claudecode/<token>`, where `<token>` is a short-TTL credential scoped
 * to this one run. This is the "belt and braces" layer of spec §1: the ACP permission
 * request is the primary gate, and the PreToolUse hook classifies the same call again
 * through the same bridge. A hook can deny or ask; it never answers `allow`, so it
 * can only make a decision stricter.
 *
 * OBSERVED (the user runs their own, unmodified Claude Code): a snippet to paste into
 * `.claude/settings.json` plus the OTel env that ships tool calls and token totals to
 * Zephyr. The run it feeds is of kind `external`.
 *
 * No `permissions.allow` rules: those would let Claude Code skip the ACP permission
 * request, and therefore the bridge. Bypass mode is disabled for the same reason.
 */

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface HttpHook {
  type: 'http';
  url: string;
  /** Seconds. PreToolUse may wait on nothing slower than the bridge's classification. */
  timeout: number;
}

export interface ClaudeCodeSettings {
  hooks: Record<HookEventName, { matcher: string; hooks: HttpHook[] }[]>;
  permissions: { defaultMode: 'default'; disableBypassPermissionsMode: 'disable' };
  env?: Record<string, string>;
}

export const HOOK_EVENTS: readonly HookEventName[] = ['PreToolUse', 'PostToolUse', 'Stop'];

/** `<base>/api/hooks/claudecode/<token>` — the token is the only credential. */
export function hookUrl(apiBaseUrl: string, token: string): string {
  return trimSlash(apiBaseUrl) + '/api/hooks/claudecode/' + encodeURIComponent(token);
}

/** OTLP/HTTP base; Claude Code appends `/v1/logs` and `/v1/metrics`. */
export function otelEndpoint(apiBaseUrl: string, token: string): string {
  return trimSlash(apiBaseUrl) + '/api/otel/' + encodeURIComponent(token);
}

export function claudeCodeSettings(opts: {
  hookUrl: string;
  timeoutSec?: number;
  env?: Record<string, string>;
}): ClaudeCodeSettings {
  const timeout = opts.timeoutSec ?? 30;
  const entry = () => [{ matcher: '*', hooks: [{ type: 'http' as const, url: opts.hookUrl, timeout }] }];
  return {
    hooks: { PreToolUse: entry(), PostToolUse: entry(), Stop: entry() },
    permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
    ...(opts.env ? { env: opts.env } : {}),
  };
}

/** Claude Code's OTel exporter, pointed at Zephyr's ingest (OTLP over HTTP/JSON). */
export function otelEnv(endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  };
}

export interface ObservedSnippet {
  /** Paste into `.claude/settings.json` (project) or `~/.claude/settings.json` (user). */
  settings: ClaudeCodeSettings;
  /** Already inside `settings.env`; also listed for shells that prefer exports. */
  env: Record<string, string>;
  hookUrl: string;
  otelEndpoint: string;
}

export function observedSnippet(opts: { apiBaseUrl: string; token: string }): ObservedSnippet {
  const hooks = hookUrl(opts.apiBaseUrl, opts.token);
  const endpoint = otelEndpoint(opts.apiBaseUrl, opts.token);
  const env = otelEnv(endpoint);
  return { settings: claudeCodeSettings({ hookUrl: hooks, env }), env, hookUrl: hooks, otelEndpoint: endpoint };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
