/**
 * Step 9 check: the run page's Workspace panel service.
 *
 *   pnpm check:workspace-view
 *
 * Offline: mock workspaces (a temp dir with in-memory checkpoints), an in-memory run
 * and event list. Covers
 *   1. checkpoints come from `workspace.checkpoint` events, numbered by turn
 *   2. diff against base and against a checkpoint; an unannounced ref is refused
 *   3. a patch over the limit is cut and flagged; the stat is kept whole
 *   4. rewind restores the checkpoint's bytes and logs a user-initiated rewind
 *   5. rewind is refused for an unknown ref, a running run and a finished run
 *   6. no worktree on disk: diff and rewind answer NO_WORKSPACE, not a git error
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run, RunEvent, RunStatus, StoredEvent } from '@htn/shared';
import { createMockGitWorkspaces } from '../src/providers/git/mock.js';
import { createWorkspacesService } from '../src/services/workspaces.service.js';
import {
  DIFF_PATCH_LIMIT,
  RunWorkspaceError,
  checkpointsOf,
  createRunWorkspace,
} from '../src/services/runWorkspace.service.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

async function rejectsWith(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RunWorkspaceError, 'expected a RunWorkspaceError, got ' + String(err));
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

async function fixture(status: RunStatus = 'paused') {
  const adapter = createMockGitWorkspaces();
  const ws = createWorkspacesService(() => adapter as never);
  const runId = 'run_wsview' + Math.random().toString(36).slice(2, 8);
  const run = { id: runId, status } as Run;
  const events: StoredEvent[] = [];
  const emitted: RunEvent[] = [];
  const push = (event: RunEvent) => events.push({ seq: events.length + 1, event } as StoredEvent);

  const { path } = await ws.open(runId);
  async function turn(turnId: string, files: Record<string, string>) {
    for (const [name, text] of Object.entries(files)) await writeFile(join(path, name), text);
    const cp = await ws.checkpointTurn(runId);
    push({ type: 'workspace.checkpoint', runId, turnId, ref: cp.ref, treeHash: cp.treeHash, at: new Date().toISOString() } as RunEvent);
    return cp.ref;
  }

  const service = createRunWorkspace({
    getRun: async (id) => (id === runId ? run : null),
    events: async () => events,
    pathOf: (id) => adapter.pathOf(id),
    diff: (id, since) => ws.diff(id, since),
    rewind: (id, ref) => ws.rewind(id, ref),
    emit: async (_id, event) => {
      emitted.push(event);
    },
    now: () => '2026-11-03T00:00:00.000Z',
  });
  return { adapter, ws, run, runId, path, events, emitted, turn, service, push };
}

console.log('workspace-view');

await test('checkpoints come from workspace.checkpoint events, numbered by turn', async () => {
  const f = await fixture();
  const r1 = await f.turn('t1', { 'a.txt': 'one\n' });
  f.push({ type: 'log', runId: f.runId, level: 'info', message: 'noise', at: 'x' } as RunEvent);
  const r2 = await f.turn('t2', { 'a.txt': 'two\n' });
  const { checkpoints, live } = await f.service.checkpoints(f.runId);
  assert.equal(live, true);
  assert.deepEqual(
    checkpoints.map((c) => [c.turn, c.turnId, c.ref]),
    [
      [1, 't1', r1],
      [2, 't2', r2],
    ],
  );
  assert.equal(checkpointsOf([]).length, 0);
  await rejectsWith(f.service.checkpoints('run_missing'), 404, 'NOT_FOUND');
  await f.ws.finish(f.runId, 'cancelled');
});

await test('diff against base and a checkpoint; unannounced refs are refused', async () => {
  const f = await fixture();
  const r1 = await f.turn('t1', { 'a.txt': 'one\n' });
  await writeFile(join(f.path, 'b.txt'), 'later\n');
  const all = await f.service.diff(f.runId);
  assert.match(all.stat, /a\.txt/);
  assert.match(all.stat, /b\.txt/);
  assert.equal(all.truncated, false);
  const since = await f.service.diff(f.runId, r1);
  assert.doesNotMatch(since.stat, /a\.txt/);
  assert.match(since.stat, /b\.txt/);
  assert.equal(since.since, r1);
  await rejectsWith(f.service.diff(f.runId, 'refs/heads/main'), 400, 'UNKNOWN_CHECKPOINT');
  await rejectsWith(f.service.diff(f.runId, '--output=/tmp/x'), 400, 'UNKNOWN_CHECKPOINT');
  await f.ws.finish(f.runId, 'cancelled');
});

await test('a patch over the limit is cut and flagged; the stat is whole', async () => {
  const f = await fixture();
  await f.turn('t1', {});
  await writeFile(join(f.path, 'big.txt'), 'x'.repeat(DIFF_PATCH_LIMIT + 5000));
  await writeFile(join(f.path, 'small.txt'), 'y\n');
  const d = await f.service.diff(f.runId);
  assert.equal(d.truncated, true);
  assert.equal(d.patch.length, DIFF_PATCH_LIMIT);
  assert.match(d.stat, /small\.txt/);
  await f.ws.finish(f.runId, 'cancelled');
});

await test('rewind restores the checkpoint and logs the user action', async () => {
  const f = await fixture('paused');
  const r1 = await f.turn('t1', { 'a.txt': 'one\n' });
  await f.turn('t2', { 'a.txt': 'two\n', 'c.txt': 'new\n' });
  const target = await f.service.rewind(f.runId, r1);
  assert.equal(target.turn, 1);
  assert.equal(await readFile(join(f.path, 'a.txt'), 'utf8'), 'one\n');
  assert.equal((await f.service.diff(f.runId, r1)).stat, '');
  assert.equal(f.emitted.length, 1);
  const log = f.emitted[0] as Extract<RunEvent, { type: 'log' }>;
  assert.equal(log.type, 'log');
  assert.match(log.message, /rewound by the user to turn 1/);
  await f.ws.finish(f.runId, 'cancelled');
});

await test('rewind is refused for unknown refs, active runs and finished runs', async () => {
  const f = await fixture('paused');
  const r1 = await f.turn('t1', { 'a.txt': 'one\n' });
  await rejectsWith(f.service.rewind(f.runId, 'HEAD~3'), 400, 'UNKNOWN_CHECKPOINT');
  for (const status of ['running', 'pending'] as RunStatus[]) {
    f.run.status = status;
    await rejectsWith(f.service.rewind(f.runId, r1), 409, 'RUN_ACTIVE');
  }
  f.run.status = 'succeeded';
  await rejectsWith(f.service.rewind(f.runId, r1), 409, 'RUN_FINISHED');
  assert.equal(f.emitted.length, 0, 'a refused rewind logs nothing');
  await f.ws.finish(f.runId, 'cancelled');
});

await test('no worktree on disk answers NO_WORKSPACE', async () => {
  const f = await fixture('paused');
  const r1 = await f.turn('t1', { 'a.txt': 'one\n' });
  await f.adapter.dispose(f.runId, false);
  assert.equal((await f.service.checkpoints(f.runId)).live, false);
  await rejectsWith(f.service.diff(f.runId), 409, 'NO_WORKSPACE');
  await rejectsWith(f.service.rewind(f.runId, r1), 409, 'NO_WORKSPACE');
});

console.log(`\nworkspace-view: ${passed} passed`);
process.exit(0);
