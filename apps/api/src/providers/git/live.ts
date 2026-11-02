/**
 * Real git workspaces: one `git worktree` per run.
 *
 *   path       <workspacesDir>/<runId>
 *   branch     zephyr/<runId>, cut from the requested base
 *   checkpoint refs/zephyr/checkpoints/<runId>/<turn> -> a commit whose tree is the
 *              whole working tree (tracked + untracked, minus ignored) at that turn
 *   meta       <workspacesDir>/.meta/<runId>.json, so a restarted process can find
 *              and reap what a crashed one left behind
 *
 * Snapshots go through a THROWAWAY index (GIT_INDEX_FILE), so checkpointing never
 * disturbs the harness's own staging area and never needs a real commit on the
 * run branch. The branch only moves when the harness itself commits.
 *
 * Every git call pins `core.autocrlf=false` (a checkpoint must restore the exact
 * bytes, and a developer's global autocrlf=true would rewrite them) and
 * `core.longpaths=true` (Windows).
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkspaceProvider } from '@htn/shared';

/** Leading alphanumeric: an id must never read as a git option. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHECKPOINT_NS = 'refs/zephyr/checkpoints';
const GIT_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.quotepath=false'];
/** Fixed identity for checkpoint commits: never the developer's, never the harness's. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Zephyr',
  GIT_AUTHOR_EMAIL: 'zephyr@localhost',
  GIT_COMMITTER_NAME: 'Zephyr',
  GIT_COMMITTER_EMAIL: 'zephyr@localhost',
};

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new Error(`Invalid runId "${runId}": expected 1-64 of [A-Za-z0-9_-], starting alphanumeric.`);
  }
}

function assertRev(rev: string): void {
  if (!rev || rev.startsWith('-') || /[\s\0]/.test(rev)) throw new Error(`Invalid git revision "${rev}".`);
}

export function branchOf(runId: string): string {
  return 'zephyr/' + runId;
}

export function checkpointRef(runId: string, turn: number): string {
  if (!Number.isInteger(turn) || turn < 0) throw new Error(`Invalid turn ${turn}.`);
  return `${CHECKPOINT_NS}/${runId}/${turn}`;
}

export function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      [...GIT_FLAGS, ...args],
      {
        cwd,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          fail(new GitError(`git ${args[0]} failed: ${(stderr || error.message).trim()}`, args, stderr));
        } else {
          done(stdout);
        }
      },
    );
  });
}

interface WorkspaceMeta {
  runId: string;
  repoRoot: string;
  path: string;
  branch: string;
  base: string;
  baseCommit: string;
  createdAt: string;
}

export interface LiveGitWorkspaces extends WorkspaceProvider {
  list(): Promise<string[]>;
  pathOf(runId: string): string;
  commitsAhead(runId: string): Promise<number>;
}

export function createLiveGitWorkspaces(opts: {
  repoRoot: string;
  workspacesDir: string;
}): LiveGitWorkspaces {
  const repoRoot = resolve(opts.repoRoot);
  const dir = resolve(opts.workspacesDir);
  const metaDir = join(dir, '.meta');

  const pathOf = (runId: string) => join(dir, runId);
  const metaPath = (runId: string) => join(metaDir, runId + '.json');

  async function readMeta(runId: string): Promise<WorkspaceMeta | undefined> {
    try {
      return JSON.parse(await readFile(metaPath(runId), 'utf8')) as WorkspaceMeta;
    } catch {
      return undefined;
    }
  }

  async function requireMeta(runId: string): Promise<WorkspaceMeta> {
    assertRunId(runId);
    const meta = await readMeta(runId);
    if (!meta || !existsSync(meta.path)) throw new Error(`No workspace for run "${runId}".`);
    return meta;
  }

  /** Run `fn` with a throwaway index file, removed afterwards. */
  async function withTempIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const indexFile = join(tmpdir(), `zephyr-index-${randomUUID()}`);
    try {
      return await fn({ GIT_INDEX_FILE: indexFile });
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  /** Tree of the whole working tree into the given (temp) index; returns the tree hash. */
  async function snapshotInto(cwd: string, env: Record<string, string>): Promise<string> {
    // Seeding from HEAD lets `add -A` reuse cached stat info for unchanged files.
    await git(cwd, ['read-tree', 'HEAD'], env);
    await git(cwd, ['add', '-A', '--', '.'], env);
    return (await git(cwd, ['write-tree'], env)).trim();
  }

  async function snapshotTree(cwd: string): Promise<string> {
    return withTempIndex((env) => snapshotInto(cwd, env));
  }

  return {
    pathOf,

    async create(runId, base) {
      assertRunId(runId);
      assertRev(base);
      const path = pathOf(runId);
      if (existsSync(path)) throw new Error(`Workspace for run "${runId}" already exists at ${path}.`);
      const baseCommit = (await git(repoRoot, ['rev-parse', '--verify', base + '^{commit}'])).trim();
      const branch = branchOf(runId);
      await mkdir(metaDir, { recursive: true });
      // Meta first: if `worktree add` dies half-way, startup reaping still finds it.
      const meta: WorkspaceMeta = {
        runId,
        repoRoot,
        path,
        branch,
        base,
        baseCommit,
        createdAt: new Date().toISOString(),
      };
      await writeFile(metaPath(runId), JSON.stringify(meta, null, 2));
      await git(repoRoot, ['worktree', 'add', '-b', branch, path, baseCommit]);
      return { path, branch };
    },

    async checkpoint(runId, turn) {
      const meta = await requireMeta(runId);
      const ref = checkpointRef(runId, turn);
      const treeHash = await snapshotTree(meta.path);
      const head = (await git(meta.path, ['rev-parse', 'HEAD'])).trim();
      const commit = (
        await git(
          meta.path,
          ['commit-tree', treeHash, '-p', head, '-m', `zephyr checkpoint ${runId} turn ${turn}`],
          CHECKPOINT_IDENTITY,
        )
      ).trim();
      await git(meta.path, ['update-ref', ref, commit]);
      return { ref, treeHash };
    },

    async rewind(runId, ref) {
      const meta = await requireMeta(runId);
      assertRev(ref);
      const target = (await git(meta.path, ['rev-parse', '--verify', ref + '^{tree}'])).trim();
      await withTempIndex(async (env) => {
        // The temp index now mirrors the working tree exactly, so a reset-merge to
        // the target writes every target file and deletes every file the target
        // lacks — including untracked ones the harness created since. Ignored
        // files are outside both trees and are left alone.
        await snapshotInto(meta.path, env);
        await git(meta.path, ['read-tree', '--reset', '-u', target], env);
      });
      // Re-sync the real index to HEAD (mixed reset; the working tree is untouched).
      await git(meta.path, ['reset', '-q']);
    },

    async diff(runId, since) {
      const meta = await requireMeta(runId);
      const from = since ?? meta.baseCommit;
      assertRev(from);
      const tree = await snapshotTree(meta.path);
      const stat = await git(meta.path, ['diff', '--stat', from, tree]);
      const patch = await git(meta.path, ['diff', '--binary', '--full-index', from, tree]);
      const hash = createHash('sha256').update(patch).digest('hex');
      return { stat, hash, patch };
    },

    async dispose(runId, keepBranch) {
      assertRunId(runId);
      const meta = await readMeta(runId);
      const root = meta?.repoRoot ?? repoRoot;
      const path = meta?.path ?? pathOf(runId);

      if (existsSync(path)) {
        try {
          await git(root, ['worktree', 'remove', '--force', '--force', path]);
        } catch {
          // A crashed run can leave a half-made or locked worktree; fall back to
          // deleting the directory and letting prune drop git's bookkeeping.
          await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
      await git(root, ['worktree', 'prune']).catch(() => undefined);

      const refs = (
        await git(root, ['for-each-ref', '--format=%(refname)', `${CHECKPOINT_NS}/${runId}/`]).catch(
          () => '',
        )
      )
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (const ref of refs) await git(root, ['update-ref', '-d', ref]);

      if (!keepBranch) {
        const branch = meta?.branch ?? branchOf(runId);
        const exists = await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])
          .then(() => true)
          .catch(() => false);
        if (exists) await git(root, ['branch', '-D', branch]);
      }

      await rm(metaPath(runId), { force: true });
    },

    async commitsAhead(runId) {
      assertRunId(runId);
      const meta = await readMeta(runId);
      if (!meta) return 0;
      const count = await git(meta.repoRoot, [
        'rev-list',
        '--count',
        `${meta.baseCommit}..refs/heads/${meta.branch}`,
      ]).catch(() => '0');
      return Number.parseInt(count.trim(), 10) || 0;
    },

    async list() {
      const ids = new Set<string>();
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && RUN_ID.test(entry.name)) ids.add(entry.name);
      }
      for (const name of await readdir(metaDir).catch(() => [] as string[])) {
        const id = name.replace(/\.json$/, '');
        if (name.endsWith('.json') && RUN_ID.test(id)) ids.add(id);
      }
      return [...ids].sort();
    },
  };
}
