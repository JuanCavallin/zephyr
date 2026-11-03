/**
 * Observed mode installer (step 3): point the user's own, unmodified Claude Code at
 * Zephyr by merging the server's hook snippet into `<project>/.claude/settings.local.json`.
 *
 * The local settings file is the one Claude Code keeps out of git, which matters: the
 * hook URL carries a run-scoped token. The merge is idempotent and conservative:
 *
 * - Zephyr's previous hook entries (URLs under `/api/hooks/claudecode/`) are replaced,
 *   every other hook the user has is kept.
 * - `env` gains the OTel exporter keys; other env keys are kept.
 * - `permissions.disableBypassPermissionsMode` is forced to `disable` (a bypassed session
 *   never asks, so the hook could not ask on Zephyr's behalf). The user's `defaultMode`
 *   is kept unless it is `bypassPermissions`. `allow`/`deny` lists are kept.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ApiClient } from './api.js';

const HOOK_MARK = '/api/hooks/claudecode/';
const OTEL_MARK = '/api/otel/';

interface HookCommand {
  type: string;
  url?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}
export interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  permissions?: { defaultMode?: string; disableBypassPermissionsMode?: string; [k: string]: unknown };
  env?: Record<string, string>;
  [k: string]: unknown;
}

export interface ObservedSnippetResponse {
  runId: string;
  snippet: {
    settings: ClaudeSettings & { hooks: Record<string, HookEntry[]>; env?: Record<string, string> };
    env: Record<string, string>;
    hookUrl: string;
    otelEndpoint: string;
  };
}

const isZephyrEntry = (e: HookEntry) => Array.isArray(e.hooks) && e.hooks.length > 0 && e.hooks.every((h) => typeof h.url === 'string' && h.url.includes(HOOK_MARK));

/** Remove every Zephyr hook entry and Zephyr OTel env key; keep the rest. */
export function stripZephyr(current: ClaudeSettings): ClaudeSettings {
  const out: ClaudeSettings = { ...current };
  if (current.hooks) {
    const hooks: Record<string, HookEntry[]> = {};
    for (const [event, entries] of Object.entries(current.hooks)) {
      const kept = (entries ?? []).filter((e) => !isZephyrEntry(e));
      if (kept.length) hooks[event] = kept;
    }
    if (Object.keys(hooks).length) out.hooks = hooks;
    else delete out.hooks;
  }
  if (current.env) {
    const pointsAtZephyr = Object.values(current.env).some((v) => typeof v === 'string' && v.includes(OTEL_MARK));
    if (pointsAtZephyr) {
      const env = Object.fromEntries(
        Object.entries(current.env).filter(([k]) => !(k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY')),
      );
      if (Object.keys(env).length) out.env = env;
      else delete out.env;
    }
  }
  return out;
}

export function mergeObserved(current: ClaudeSettings, snippet: ObservedSnippetResponse['snippet']): ClaudeSettings {
  const base = stripZephyr(current);
  const hooks: Record<string, HookEntry[]> = { ...(base.hooks ?? {}) };
  for (const [event, entries] of Object.entries(snippet.settings.hooks)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  const permissions = { ...(base.permissions ?? {}) };
  if (!permissions.defaultMode || permissions.defaultMode === 'bypassPermissions') permissions.defaultMode = 'default';
  permissions.disableBypassPermissionsMode = 'disable';
  return {
    ...base,
    hooks,
    permissions,
    env: { ...(base.env ?? {}), ...snippet.env },
  };
}

export function settingsPath(cwd: string): string {
  return join(resolve(cwd), '.claude', 'settings.local.json');
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // a BOM from Windows editors
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as ClaudeSettings;
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); fix or move it, then rerun.`);
  }
}

function writeSettings(path: string, s: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.zephyr-tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, path);
}

export interface HookInstallResult {
  runId: string;
  path: string;
  replaced: boolean;
}

export async function installHook(api: ApiClient, opts: { cwd: string; title?: string }): Promise<HookInstallResult> {
  const cwd = resolve(opts.cwd);
  const path = settingsPath(cwd);
  // Read first: a malformed file stops us before a run is created for nothing.
  const current = readSettings(path);
  const res = await api.post<ObservedSnippetResponse>('/api/observed/claudecode', {
    cwd,
    ...(opts.title ? { title: opts.title } : {}),
  });
  const replaced = JSON.stringify(stripZephyr(current)) !== JSON.stringify(current);
  writeSettings(path, mergeObserved(current, res.snippet));
  return { runId: res.runId, path, replaced };
}

export function uninstallHook(cwd: string): { path: string; removed: boolean } {
  const path = settingsPath(cwd);
  const current = readSettings(path);
  const next = stripZephyr(current);
  const removed = JSON.stringify(next) !== JSON.stringify(current);
  if (removed) writeSettings(path, next);
  return { path, removed };
}
