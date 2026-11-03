import assert from 'node:assert/strict';
import test from 'node:test';
import {
  armSummary,
  canRate,
  confidenceLabel,
  entryActions,
  feedbackOrigin,
  groupFeed,
  percent,
  runIsPrivate,
  variantPickBody,
} from '../src/lib/learning.ts';

const entry = (id, over = {}) => ({
  id,
  kind: 'pref',
  scope: 'personal',
  status: 'active',
  confidence: 0.9,
  version: 2,
  evidence: [],
  text: 'Prefer early returns',
  autoActivate: true,
  source: 'jev',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const item = (e, versions = [1, 2]) => ({
  entry: e,
  evidence: [],
  versions: versions.map((v) => ({ version: v, at: e.updatedAt, reason: 'v' + v })),
});

test('actions follow the lifecycle: retired cannot be reverted, active cannot be accepted', () => {
  const active = entryActions(item(entry('a')));
  assert.equal(active.revert, true);
  assert.equal(active.accept, false);
  assert.deepEqual(active.restorable, [1], 'the current version is not offered');
  const retired = entryActions(item(entry('b', { status: 'retired', reverted: true })));
  assert.equal(retired.revert, false);
  assert.equal(retired.accept, true);
  assert.equal(entryActions(item(entry('c', { status: 'candidate' }))).accept, true);
});

test('private entries are never promoted or proposed; project entries propose only when active', () => {
  assert.equal(entryActions(item(entry('a'))).promote, true);
  assert.equal(entryActions(item(entry('a'))).propose, false, 'personal taste stays out of the repo');
  assert.equal(entryActions(item(entry('p', { private: true }))).promote, false);
  assert.equal(entryActions(item(entry('q', { scope: 'project' }))).promote, false);
  assert.equal(entryActions(item(entry('q', { scope: 'project' }))).propose, true);
  assert.equal(entryActions(item(entry('r', { scope: 'project', status: 'candidate' }))).propose, false);
  assert.equal(entryActions(item(entry('s', { scope: 'project', private: true }))).propose, false);
});

test('groupFeed: by status, newest change first', () => {
  const g = groupFeed([
    item(entry('old', { updatedAt: '2026-11-01T00:00:00.000Z' })),
    item(entry('cand', { status: 'candidate' })),
    item(entry('new', { updatedAt: '2026-11-02T00:00:00.000Z' })),
    item(entry('gone', { status: 'retired' })),
  ]);
  assert.deepEqual(g.active.map((i) => i.entry.id), ['new', 'old']);
  assert.deepEqual(g.candidate.map((i) => i.entry.id), ['cand']);
  assert.deepEqual(g.retired.map((i) => i.entry.id), ['gone']);
});

test('confidence labels and percent clamp', () => {
  assert.equal(confidenceLabel(0.85), 'strong');
  assert.equal(confidenceLabel(0.5), 'moderate');
  assert.equal(confidenceLabel(0.2), 'weak');
  assert.equal(percent(0.756), '76%');
  assert.equal(percent(1.4), '100%');
});

test('armSummary: newest version first; an unmeasured version says so', () => {
  assert.deepEqual(armSummary(undefined), []);
  assert.deepEqual(
    armSummary([
      { skillId: 's', version: 1, passed: 3, failed: 1, passRate: 0.75 },
      { skillId: 's', version: 2, passed: 0, failed: 0, passRate: null },
    ]),
    ['v2: no finished runs yet', 'v1: 3 of 4 runs passed (75%)'],
  );
});

test('only finished tasks are rated; the origin carries task, run and the private flag', () => {
  assert.equal(canRate({ status: 'done' }), true);
  assert.equal(canRate({ status: 'failed' }), true);
  assert.equal(canRate({ status: 'running' }), false);
  assert.deepEqual(feedbackOrigin({ id: 't1', runId: 'r1' }, true), { taskId: 't1', runId: 'r1', private: true });
  assert.deepEqual(feedbackOrigin({ id: 't1' }, false), { taskId: 't1' });
});

test('variantPickBody: chosen vs the rest, clipped to the API limits; nothing rejected is no signal', () => {
  const variants = [
    { id: 'a', label: 'Early returns' },
    { id: 'b', label: 'Nested ifs' },
    { id: 'c', label: 'x'.repeat(300) },
  ];
  const body = variantPickBody(variants, 'a', { taskId: 't1' });
  assert.equal(body.chosen, 'Early returns');
  assert.equal(body.rejected.length, 2);
  assert.equal(body.rejected[1].length, 200);
  assert.equal(body.taskId, 't1');
  assert.equal(variantPickBody(variants.slice(0, 1), 'a'), null);
  assert.equal(variantPickBody(variants, 'zzz'), null);
});

test('runIsPrivate reads the board run input', () => {
  assert.equal(runIsPrivate({ input: { request: 'x', private: true } }), true);
  assert.equal(runIsPrivate({ input: { request: 'x' } }), false);
  assert.equal(runIsPrivate({ input: 'private' }), false);
  assert.equal(runIsPrivate(null), false);
});
