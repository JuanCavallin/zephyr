import assert from 'node:assert/strict';
import test from 'node:test';
import { boardReducer, emptyBoard, moved, orderedTasks, parseScope, editable, assigneeId } from '../src/lib/board.ts';

const at = '2026-11-02T00:00:00.000Z';
const task = (id, over = {}) => ({
  id,
  boardRunId: 'b1',
  title: 'Task ' + id,
  acceptance: 'works',
  writeScope: ['src/' + id + '/**'],
  dependsOn: [],
  status: 'ready',
  createdAt: at,
  updatedAt: at,
  ...over,
});
const run = { id: 'b1', title: 'Board', status: 'running' };
const snapshot = (tasks) => ({ type: 'snapshot', board: { run, tasks, waves: [tasks.map((t) => t.id)] } });

test('a task.* event changes only its own card', () => {
  let s = boardReducer(emptyBoard, snapshot([task('a'), task('b')]));
  const before = s.tasks.b;
  s = boardReducer(s, { type: 'task.status', taskId: 'a', from: 'ready', to: 'running', at });
  s = boardReducer(s, {
    type: 'task.progress',
    taskId: 'a',
    progress: { testsPassed: 1, testsTotal: 2, filesChanged: 3, tokens: 10, turns: 1 },
    at,
  });
  assert.equal(s.tasks.a.status, 'running');
  assert.equal(s.tasks.a.progress.filesChanged, 3);
  assert.equal(s.tasks.b, before, 'the other card keeps the same object');
});

test('created, updated and removed keep board order and waves', () => {
  let s = boardReducer(emptyBoard, snapshot([task('a'), task('b')]));
  s = boardReducer(s, { type: 'task.created', task: task('c') });
  s = boardReducer(s, { type: 'task.updated', task: task('a', { writeScope: ['lib/**'], pinned: true }) });
  s = boardReducer(s, { type: 'task.removed', taskId: 'b', at });
  assert.deepEqual(orderedTasks(s).map((t) => t.id), ['a', 'c']);
  assert.deepEqual(s.tasks.a.writeScope, ['lib/**']);
  assert.deepEqual(s.waves, [['a']]);
});

test('events before the snapshot are not lost', () => {
  let s = boardReducer(emptyBoard, { type: 'task.created', task: task('fix') });
  s = boardReducer(s, snapshot([task('a')]));
  assert.deepEqual(s.order, ['a', 'fix']);
});

test('lease denials and merge results become card notes; unknown events are ignored', () => {
  let s = boardReducer(emptyBoard, snapshot([task('a')]));
  s = boardReducer(s, { type: 'lease.denied', taskId: 'a', path: 'package.json', reason: 'hot_file', at });
  s = boardReducer(s, { type: 'merge.result', taskId: 'a', outcome: 'tests_failed', detail: '1 failing', fixTaskId: 'f', at });
  assert.deepEqual(s.notes.a, ['denied package.json (hot file)', 'tests failed: 1 failing -> fix task']);
  assert.equal(boardReducer(s, { type: 'step.upserted', step: {} }), s);
});

test('review helpers', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.equal(moved(['a', 'b'], 'a', -1), null);
  assert.deepEqual(parseScope(' src/a/**\n, src/b.ts ,\n'), ['src/a/**', 'src/b.ts']);
  assert.equal(editable(task('a', { status: 'pending' })), true);
  assert.equal(editable(task('a', { status: 'running' })), false);
  assert.equal(assigneeId({ kind: 'agent', harness: 'codex', tier: 'standard' }), 'codex-standard');
  assert.equal(assigneeId(undefined), 'auto');
});
