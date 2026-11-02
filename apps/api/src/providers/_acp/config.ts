/**
 * What makes one ACP harness different from another.
 *
 * The ACP client (client.ts) is harness-agnostic: it spawns a binary, speaks
 * newline-delimited JSON-RPC on stdio, and turns everything the peer can do into
 * a typed terminal state. A harness — Hermes today, Claude Code and Codex next —
 * is a thin AcpHarnessConfig: which binary, which env, which MCP servers.
 *
 * ENVIRONMENT IS AN ALLOWLIST, NOT A COPY. A coding harness runs untrusted model
 * output as shell commands in a worktree. Handing it `process.env` hands it every
 * ambient credential on the machine (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * AI_GATEWAY_API_KEY, cloud tokens...). `buildHarnessEnv` therefore starts from a
 * minimal PATH/HOME allowlist and adds only the gateway URL plus a scoped token.
 * Hermes is the one exception (`inheritEnv: true`) to keep its behaviour
 * unchanged by this refactor; it never executes repo code.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { HarnessId } from '@htn/shared';

/** Everything a harness config may need to build its env and session. */
export interface AcpLaunchContext {
  /** Directory the harness works in (the run's worktree for coding harnesses). */
  cwd: string;
  /** Zephyr's model gateway: loopback URL and a token scoped to this run. */
  gateway: { url: string; token: string };
  /** Zephyr's MCP server, the harness's only MCP config. */
  mcp?: { url: string; token: string };
  /** Per-run harness state directory (Hermes: its profile / HERMES_HOME). */
  stateDir?: string;
}

export interface AcpTimeouts {
  /** Spawn + `initialize` round trip. 0 disables. */
  initializeMs: number;
  /** Longest silence (no session/update) tolerated inside a turn. 0 disables. */
  turnIdleMs: number;
  /**
   * After `session/cancel`, how long the peer gets to stop before its process
   * tree is killed. 0 = kill at once.
   */
  cancelGraceMs: number;
}

export const DEFAULT_TIMEOUTS: AcpTimeouts = {
  initializeMs: 30_000,
  turnIdleMs: 120_000,
  cancelGraceMs: 2_000,
};

export interface AcpHarnessConfig {
  harness: HarnessId;
  binary: string;
  args: string[];
  /** Harness-specific env additions (never secrets beyond the scoped ones in ctx). */
  env(ctx: AcpLaunchContext): Record<string, string>;
  /** How this harness is pointed at Zephyr's gateway, e.g. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. */
  gatewayEnv(url: string, token: string): Record<string, string>;
  /** MCP servers sent on `session/new`. Zephyr's MCP server and nothing else. */
  mcpServers(ctx: AcpLaunchContext): acp.McpServer[];
  /** Expected `agentInfo.version`; a mismatch is logged, not fatal. Null = unpinned. */
  pinnedVersion: string | null;
  /** Copy the parent env instead of the allowlist. Hermes only — see file header. */
  inheritEnv?: boolean;
  /**
   * A stdout line that is not JSON. 'fail' ends every active turn with
   * protocol_error and kills the peer; 'ignore' keeps the SDK's behaviour
   * (answer with a parse error and carry on).
   */
  malformedLines?: 'fail' | 'ignore';
  timeouts?: Partial<AcpTimeouts>;
}

/**
 * Names (case-insensitive: Windows env keys are) a process needs to start and
 * find its tools. Nothing here carries a credential.
 */
export const ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
] as const;

const ALLOWED = new Set<string>(ENV_ALLOWLIST);

/** Only the allowlisted entries of `source`, plus the gateway URL and scoped token. */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv,
  gateway: { url: string; token: string },
  gatewayEnv: AcpHarnessConfig['gatewayEnv'] = zephyrGatewayEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED.has(key.toUpperCase())) out[key] = value;
  }
  return { ...out, ...gatewayEnv(gateway.url, gateway.token) };
}

/** The final child env for a harness launch. */
export function buildHarnessEnv(
  harness: AcpHarnessConfig,
  ctx: AcpLaunchContext,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base = harness.inheritEnv
    ? {
        ...(Object.fromEntries(
          Object.entries(source).filter(([, v]) => v !== undefined),
        ) as Record<string, string>),
        ...harness.gatewayEnv(ctx.gateway.url, ctx.gateway.token),
      }
    : scrubbedEnv(source, ctx.gateway, harness.gatewayEnv);
  return { ...base, ...harness.env(ctx) };
}

/** Generic gateway variables for harnesses with no vendor-specific names. */
export function zephyrGatewayEnv(url: string, token: string): Record<string, string> {
  return { ZEPHYR_GATEWAY_URL: url, ZEPHYR_GATEWAY_TOKEN: token };
}

/** Zephyr's MCP server as an ACP `session/new` entry. */
export function zephyrMcpServer(url: string, token: string): acp.McpServer {
  return {
    type: 'http',
    name: 'zephyr',
    url,
    headers: [{ name: 'Authorization', value: 'Bearer ' + token }],
  };
}

export function resolveTimeouts(...layers: (Partial<AcpTimeouts> | undefined)[]): AcpTimeouts {
  return Object.assign({}, DEFAULT_TIMEOUTS, ...layers.filter(Boolean)) as AcpTimeouts;
}
