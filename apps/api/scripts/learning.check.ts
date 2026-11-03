/**
 * Step 8 check: the learning loop.
 *
 *   pnpm check:learning
 *
 * Offline. No harness, no model, no network.
 *
 *   1. Profile store: migrations, persistence, versions, evidence, export, delete.
 *   2. Signal capture: edit diffs (CRLF-safe), builders, the signal log.
 */

process.env.PERSIST_TO_DISK = 'false';
process.env.MOCK_MIN_LATENCY_MS = '0';
process.env.MOCK_MAX_LATENCY_MS = '0';
process.env.MOCK_FAILURE_RATE = '0';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ProfileStore, PROFILE_SCHEMA_VERSION, toPreference, toSkill } = await import('../src/core/learning/profileStore.js');
const {
  SignalLog,
  editDiff,
  editDiffFromGit,
  userEditSignal,
  variantPickSignal,
  feedbackSignal,
  requestWordingSignal,
  describeSignal,
} = await import('../src/core/learning/signalLog.js');
type LearnedEntry = import('../src/core/learning/profileStore.js').LearnedEntry;
type PreferenceSignal = import('@htn/shared').PreferenceSignal;
type RunEvent = import('@htn/shared').RunEvent;

const T0 = '2026-11-02T00:00:00.000Z';
const scratch = await mkdtemp(join(tmpdir(), 'zephyr-learning-'));

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

const tick = () => new Promise((r) => setTimeout(r, 5));

function sig(id: string, over: Partial<PreferenceSignal> = {}): PreferenceSignal {
  return {
    id,
    kind: 'explicit_feedback',
    rating: 'down',
    comment: 'too verbose',
    scope: 'personal',
    private: false,
    at: T0,
    ...over,
  } as PreferenceSignal;
}

function entry(id: string, over: Partial<LearnedEntry> = {}): LearnedEntry {
  return {
    id,
    kind: 'pref',
    scope: 'personal',
    status: 'candidate',
    confidence: 0.4,
    version: 1,
    evidence: ['sig_a'],
    text: 'Prefer early returns over nested ifs.',
    autoActivate: true,
    source: 'jev',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

console.log('1. profile store');

await test('migrations bring a new profile to the current schema version', () => {
  const store = new ProfileStore(':memory:');
  assert.equal(store.schemaVersion(), PROFILE_SCHEMA_VERSION);
  store.close();
});

await test('signals, entries and versions persist across reopen', async () => {
  const path = join(scratch, 'persist.db');
  const a = new ProfileStore(path);
  await a.recordSignal(sig('sig_a'), { detail: 'diff body' });
  a.putEntry(entry('ent_1'), 'drafted');
  a.close();

  const b = new ProfileStore(path);
  assert.equal(b.schemaVersion(), PROFILE_SCHEMA_VERSION);
  assert.equal(b.signal('sig_a')?.detail, 'diff body');
  assert.equal(b.entry('ent_1')?.text, 'Prefer early returns over nested ifs.');
  assert.equal(b.versions('ent_1').length, 1);
  b.close();
});

await test('recording the same signal twice keeps one copy', async () => {
  const store = new ProfileStore(':memory:');
  await store.recordSignal(sig('sig_a'));
  await store.recordSignal(sig('sig_a'));
  assert.equal(store.signals().length, 1);
  store.close();
});

await test('an invalid signal is rejected', async () => {
  const store = new ProfileStore(':memory:');
  await assert.rejects(() => store.recordSignal({ ...sig('sig_x'), scope: 'galaxy' } as unknown as PreferenceSignal));
  store.close();
});

await test('unprocessed signals drain once marked processed', async () => {
  const store = new ProfileStore(':memory:');
  await store.recordSignal(sig('sig_a'));
  await store.recordSignal(sig('sig_b'));
  assert.equal(store.signals({ unprocessed: true }).length, 2);
  store.markProcessed(['sig_a']);
  assert.deepEqual(store.signals({ unprocessed: true }).map((s) => s.signal.id), ['sig_b']);
  store.close();
});

await test('every change is a new version; a skipped or repeated version is refused', async () => {
  const store = new ProfileStore(':memory:');
  await store.recordSignal(sig('sig_a'));
  await store.recordSignal(sig('sig_b'));
  store.putEntry(entry('ent_1'), 'drafted');
  assert.throws(() => store.putEntry(entry('ent_1', { version: 1 }), 'x'), /version/);
  assert.throws(() => store.putEntry(entry('ent_1', { version: 3 }), 'x'), /version/);
  store.putEntry(entry('ent_1', { version: 2, confidence: 0.8, status: 'active', evidence: ['sig_a', 'sig_b'] }), 'duplicate evidence');
  assert.deepEqual(store.versions('ent_1').map((v) => [v.version, v.reason]), [
    [1, 'drafted'],
    [2, 'duplicate evidence'],
  ]);
  assert.equal(store.entry('ent_1')?.status, 'active');
  assert.deepEqual(store.evidenceFor('ent_1').map((s) => s.signal.id).sort(), ['sig_a', 'sig_b']);
  store.close();
});

await test('an entry with no evidence is refused', () => {
  const store = new ProfileStore(':memory:');
  assert.throws(() => store.putEntry(entry('ent_1', { evidence: [] }), 'drafted'), /evidence/);
  store.close();
});

await test('entries filter by status, scope and kind', () => {
  const store = new ProfileStore(':memory:');
  store.putEntry(entry('ent_1', { status: 'active' }), 'x');
  store.putEntry(entry('ent_2', { scope: 'project' }), 'x');
  store.putEntry(
    entry('ent_3', {
      kind: 'skill',
      status: 'active',
      scope: 'project',
      skill: { name: 'early-returns', description: 'Use early returns', body: 'Return early.' },
    }),
    'x',
  );
  assert.deepEqual(store.entries({ status: ['active'] }).map((e) => e.id).sort(), ['ent_1', 'ent_3']);
  assert.deepEqual(store.entries({ scope: 'project' }).map((e) => e.id).sort(), ['ent_2', 'ent_3']);
  assert.deepEqual(store.entries({ kind: 'skill' }).map((e) => e.id), ['ent_3']);
  assert.equal(toPreference(store.entry('ent_1')!).status, 'active');
  assert.equal(toSkill(store.entry('ent_3')!).name, 'early-returns');
  store.close();
});

await test('skill runs are tagged and their outcome recorded', () => {
  const store = new ProfileStore(':memory:');
  store.tagRun('run_1', [{ id: 'ent_3', version: 2 }], 'task_1');
  store.recordRunOutcome('run_1', 'passed');
  const runs = store.skillRuns('ent_3');
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.outcome, 'passed');
  assert.equal(runs[0]!.skillVersion, 2);
  store.close();
});

await test('export carries everything and delete removes every signal and entry', async () => {
  const path = join(scratch, 'delete.db');
  const store = new ProfileStore(path);
  await store.recordSignal(sig('sig_a'), { detail: 'secret diff' });
  store.putEntry(entry('ent_1'), 'drafted');
  store.tagRun('run_1', [{ id: 'ent_1', version: 1 }]);
  const exported = store.exportAll();
  assert.equal(exported.format, 'zephyr-profile');
  assert.equal(exported.signals.length, 1);
  assert.equal(exported.entries.length, 1);
  assert.equal(exported.versions.length, 1);
  assert.equal(exported.skillRuns.length, 1);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(exported)));

  const counts = store.deleteAll();
  assert.deepEqual(counts, { signals: 1, entries: 1 });
  assert.equal(store.signals().length, 0);
  assert.equal(store.entries().length, 0);
  assert.equal(store.versions('ent_1').length, 0);
  assert.equal(store.skillRuns().length, 0);
  store.close();
  const reopened = new ProfileStore(path);
  assert.equal(reopened.signals().length, 0);
  reopened.close();
});

console.log('2. signal capture');

await test('edit diff fixture: agent output vs merged, files and hash', () => {
  const agent = {
    'src/parse.ts': 'export function parse(s) {\n  if (s) {\n    return s.trim();\n  }\n  return "";\n}\n',
    'src/util.ts': 'export const a = 1;\n',
  };
  const merged = {
    'src/parse.ts': 'export function parse(s) {\n  if (!s) return "";\n  return s.trim();\n}\n',
    'src/util.ts': 'export const a = 1;\n',
  };
  const d = editDiff(agent, merged);
  assert.ok(d);
  assert.deepEqual(d.files, ['src/parse.ts']);
  assert.match(d.diff, /^--- a\/src\/parse\.ts$/m);
  assert.match(d.diff, /^\+  if \(!s\) return "";$/m);
  assert.match(d.diff, /^-  if \(s\) \{$/m);
  assert.doesNotMatch(d.diff, /util\.ts/);
  assert.match(d.diffHash, /^sha256:[0-9a-f]{64}$/);
  // Same edit, same hash.
  assert.equal(editDiff(agent, merged)!.diffHash, d.diffHash);
});

await test('CRLF and backslash paths are not edits', () => {
  const agent = { 'src\\a.ts': 'one\ntwo\n' };
  const merged = { 'src/a.ts': 'one\r\ntwo\r\n' };
  assert.equal(editDiff(agent, merged), null);
});

await test('added and deleted files show up in the edit', () => {
  const d = editDiff({ 'a.ts': 'x\n' }, { 'b.ts': 'y\n' });
  assert.ok(d);
  assert.deepEqual(d.files, ['a.ts', 'b.ts']);
  assert.match(d.diff, /--- a\/a\.ts\n\+\+\+ \/dev\/null/);
  assert.match(d.diff, /--- \/dev\/null\n\+\+\+ b\/b\.ts/);
});

await test('git diff output parses into files and a blob-independent hash', () => {
  const git = (blob: string) =>
    [
      'diff --git a/src/parse.ts b/src/parse.ts',
      `index ${blob}..1234567 100644`,
      '--- a/src/parse.ts',
      '+++ b/src/parse.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      '',
    ].join('\r\n');
  const a = editDiffFromGit(git('aaaaaaa'));
  const b = editDiffFromGit(git('bbbbbbb'));
  assert.ok(a && b);
  assert.deepEqual(a.files, ['src/parse.ts']);
  assert.equal(a.diffHash, b.diffHash);
  assert.equal(editDiffFromGit('  \n'), null);
});

await test('builders produce valid signals of every capture kind', () => {
  const d = editDiff({ 'a.ts': 'x\n' }, { 'a.ts': 'y\n' })!;
  const edit = userEditSignal(d, { taskId: 'task_1', scope: 'project' });
  assert.equal(edit.kind, 'user_edit');
  assert.equal(edit.scope, 'project');
  assert.equal(variantPickSignal('var_b', ['var_a', 'var_c']).kind, 'variant_pick');
  const fb = feedbackSignal('down', '  ', { private: true });
  assert.equal(fb.kind, 'explicit_feedback');
  assert.equal(fb.private, true);
  assert.ok(!('comment' in fb), 'blank comment dropped');
  assert.equal(requestWordingSignal(' add a parser ').kind, 'request_wording');
  assert.throws(() => variantPickSignal('var_a', []));
  for (const s of [edit, fb]) assert.ok(describeSignal(s).length > 0);
});

await test('the signal log stores, emits learning.signal and wakes the pipeline off the critical path', async () => {
  const store = new ProfileStore(':memory:');
  const events: Array<{ runId: string; event: RunEvent }> = [];
  const woke: string[] = [];
  const errors: unknown[] = [];
  const log = new SignalLog({
    store,
    emit: (runId, event) => events.push({ runId, event }),
    onSignal: async (s) => {
      woke.push(s.id);
      throw new Error('pipeline exploded');
    },
    onError: (e) => errors.push(e),
  });
  const s = sig('sig_a', { runId: 'run_9' } as Partial<PreferenceSignal>);
  await log.recordSignal(s, { detail: 'x'.repeat(20_000) });
  assert.ok(store.signal('sig_a'));
  assert.ok(store.signal('sig_a')!.detail!.length < 13_000, 'detail truncated');
  assert.deepEqual(events.map((e) => [e.runId, e.event.type]), [['run_9', 'learning.signal']]);
  await tick();
  assert.deepEqual(woke, ['sig_a']);
  assert.equal(errors.length, 1, 'pipeline failure reported, not thrown at the caller');
});

console.log(`\n${passed} passed`);
await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
