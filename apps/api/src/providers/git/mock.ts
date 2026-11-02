/**
 * Mock workspaces: a plain temp directory per run and in-memory checkpoints.
 * Never touches a git repository, so a fresh clone can run coding flows without
 * creating branches. Same contract as live.ts: rewind restores exact bytes,
 * including deleting files created after the checkpoint.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { WorkspaceProvider } from '@htn/shared';
import { assertRunId, branchOf, checkpointRef } from './live.js';

type Snapshot = Map<string, Buffer>;

interface MockWorkspace {
  path: string;
  base: Snapshot;
  checkpoints: Map<string, Snapshot>;
}

export interface MockGitWorkspaces extends WorkspaceProvider {
  list(): Promise<string[]>;
  pathOf(runId: string): string | undefined;
  commitsAhead(runId: string): Promise<number>;
}

async function walk(root: string, dir = root, out: Snapshot = new Map()): Promise<Snapshot> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.set(relative(root, full).split(sep).join('/'), await readFile(full));
  }
  return out;
}

function treeHash(snapshot: Snapshot): string {
  const h = createHash('sha1');
  for (const path of [...snapshot.keys()].sort()) {
    h.update(path + '\0' + createHash('sha1').update(snapshot.get(path)!).digest('hex') + '\n');
  }
  return h.digest('hex');
}

function render(from: Snapshot, to: Snapshot): { stat: string; patch: string } {
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const stat: string[] = [];
  const patch: string[] = [];
  for (const path of paths) {
    const a = from.get(path);
    const b = to.get(path);
    if (a && b && a.equals(b)) continue;
    const kind = !a ? 'added' : !b ? 'deleted' : 'modified';
    stat.push(` ${path} | ${kind}`);
    patch.push(`--- ${a ? 'a/' + path : '/dev/null'}`, `+++ ${b ? 'b/' + path : '/dev/null'}`);
    for (const line of a ? a.toString('utf8').split('\n') : []) patch.push('-' + line);
    for (const line of b ? b.toString('utf8').split('\n') : []) patch.push('+' + line);
  }
  if (stat.length) stat.push(` ${stat.length} file(s) changed`);
  return { stat: stat.join('\n') + (stat.length ? '\n' : ''), patch: patch.join('\n') };
}

export function createMockGitWorkspaces(): MockGitWorkspaces {
  const runs = new Map<string, MockWorkspace>();

  function need(runId: string): MockWorkspace {
    assertRunId(runId);
    const ws = runs.get(runId);
    if (!ws) throw new Error(`No workspace for run "${runId}".`);
    return ws;
  }

  return {
    pathOf: (runId) => runs.get(runId)?.path,

    async create(runId, _base) {
      assertRunId(runId);
      if (runs.has(runId)) throw new Error(`Workspace for run "${runId}" already exists.`);
      const path = await mkdtemp(join(tmpdir(), `zephyr-ws-${runId}-`));
      runs.set(runId, { path, base: new Map(), checkpoints: new Map() });
      return { path, branch: branchOf(runId) };
    },

    async checkpoint(runId, turn) {
      const ws = need(runId);
      const ref = checkpointRef(runId, turn);
      const snapshot = await walk(ws.path);
      ws.checkpoints.set(ref, snapshot);
      return { ref, treeHash: treeHash(snapshot) };
    },

    async rewind(runId, ref) {
      const ws = need(runId);
      const target = ws.checkpoints.get(ref);
      if (!target) throw new Error(`Unknown checkpoint "${ref}" for run "${runId}".`);
      const current = await walk(ws.path);
      for (const path of current.keys()) {
        if (!target.has(path)) await rm(join(ws.path, path), { force: true });
      }
      for (const [path, bytes] of target) {
        await mkdir(dirname(join(ws.path, path)), { recursive: true });
        await writeFile(join(ws.path, path), bytes);
      }
    },

    async diff(runId, since) {
      const ws = need(runId);
      const from = since === undefined ? ws.base : ws.checkpoints.get(since);
      if (!from) throw new Error(`Unknown checkpoint "${since}" for run "${runId}".`);
      const { stat, patch } = render(from, await walk(ws.path));
      return { stat, patch, hash: createHash('sha256').update(patch).digest('hex') };
    },

    async dispose(runId, _keepBranch) {
      assertRunId(runId);
      const ws = runs.get(runId);
      if (!ws) return;
      runs.delete(runId);
      await rm(ws.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },

    /** The mock has no branch, so nothing is ever committed ahead of base. */
    async commitsAhead(runId) {
      assertRunId(runId);
      return 0;
    },

    async list() {
      return [...runs.keys()].sort();
    },
  };
}
