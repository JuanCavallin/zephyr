/**
 * git — the `workspace` capability: an isolated worktree per coding run, with a
 * checkpoint per turn and exact rewind. See live.ts for the on-disk layout.
 *
 * Local disk work only, no egress: the registry does not wrap this adapter in
 * the egress ledger. Mode `mock` (the default) uses temp dirs and in-memory
 * snapshots; `live` drives real `git worktree`s under WORKSPACES_DIR.
 */

import type { Capability, ProviderResult, WorkspaceAdapter, WorkspaceProvider } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase } from '../_mock.js';
import { createLiveGitWorkspaces, git } from './live.js';
import { createMockGitWorkspaces } from './mock.js';

const CAPABILITIES: readonly Capability[] = ['workspace'];

function disabledError(): never {
  throw new Error('Provider "git" is disabled. Set GIT_MODE=mock or GIT_MODE=live to enable it.');
}

export function create(cfg: ProviderConfig): WorkspaceAdapter {
  const mode = cfg.mode;
  const base = mockBase('git', CAPABILITIES, mode);

  if (mode === 'disabled') {
    const off: WorkspaceProvider = {
      create: disabledError,
      checkpoint: disabledError,
      rewind: disabledError,
      diff: disabledError,
      dispose: disabledError,
    };
    return { ...base, ...off, list: async () => [], pathOf: () => undefined, commitsAhead: async () => 0 };
  }

  if (mode === 'mock') {
    const ws = createMockGitWorkspaces();
    return { ...base, ...ws };
  }

  const repoRoot = cfg.repoRoot!;
  const ws = createLiveGitWorkspaces({ repoRoot, workspacesDir: cfg.workspacesDir! });
  return {
    ...base,
    ...ws,
    async health(): Promise<ProviderResult<{ detail?: string }>> {
      const started = Date.now();
      const meta = {
        provider: 'git' as const,
        op: 'health',
        mode,
        latencyMs: 0,
        destination: null,
      };
      try {
        const top = (await git(repoRoot, ['rev-parse', '--show-toplevel'])).trim();
        return {
          ok: true,
          data: { detail: `worktrees of ${top} under ${cfg.workspacesDir}` },
          meta: { ...meta, latencyMs: Date.now() - started },
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'UPSTREAM',
            message: `GIT_REPO_ROOT is not a usable git repository: ${(error as Error).message}`,
            retryable: false,
          },
          meta: { ...meta, latencyMs: Date.now() - started },
        };
      }
    },
  };
}
