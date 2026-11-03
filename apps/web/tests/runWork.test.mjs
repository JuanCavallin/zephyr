import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTokens, hasRunWork, leverLabel, parseLever, runWork } from '../src/lib/runWork.ts';

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheCreationInputTokens: cacheWrite,
  cacheReadInputTokens: cacheRead,
});

const call = (at, u, extra = {}) => ({
  type: 'gateway.call',
  runId: 'r1',
  callId: 'c' + at,
  status: 200,
  stream: true,
  usage: u,
  runCacheHitRate: 0.5,
  toolUses: 1,
  at,
  ...extra,
});
const ended = (at, turnId) => ({
  type: 'harness.turn.ended',
  runId: 'r1',
  sessionId: 's1',
  turnId,
  harness: 'claudecode',
  stopReason: 'end_turn',
  at,
});
const checkpoint = (at, turnId, ref) => ({ type: 'workspace.checkpoint', runId: 'r1', turnId, ref, at });

const action = (id, toolId, args) => ({
  id,
  runId: 'r1',
  stepId: 'agent',
  toolId,
  descriptorVersion: '1',
  operation: 'exec',
  arguments: args,
  dataLabels: [],
  createdAt: 't',
});
const life = (id, phase, act, at, extra = {}) => ({
  id,
  runId: 'r1',
  stepId: 'agent',
  sessionStateId: 's',
  phase,
  action: act,
  at,
  ...extra,
});

test('parseLever reads the digest line and compactTokens formats it', () => {
  const l = parseLever('test output digested: 14211 → 602 tokens\n3 failed', 't');
  assert.deepEqual(l, { what: 'test output', rawTokens: 14211, shapedTokens: 602, at: 't' });
  assert.equal(leverLabel(l), '14k → 602');
  assert.equal(parseLever('ran ls', 't'), null);
  assert.equal(parseLever(undefined, 't'), null);
  assert.equal(compactTokens(950), '950');
  assert.equal(compactTokens(1500), '1.5k');
  assert.equal(compactTokens(2000), '2k');
  assert.equal(compactTokens(1_250_000), '1.3M');
});

test('gateway calls group into turns at turn ends, with usage and cost', () => {
  const w = runWork({
    codingWork: [
      call('2026-01-01T00:00:01Z', usage(100, 10, 0, 900), { costCents: 2 }),
      call('2026-01-01T00:00:02Z', usage(50, 20, 1000), { costCents: 1 }),
      ended('2026-01-01T00:00:03Z', 't1'),
      checkpoint('2026-01-01T00:00:03.5Z', 't1', 'refs/zephyr/r1/turn-1'),
      call('2026-01-01T00:00:04Z', usage(30, 5, 1900), { runCacheHitRate: 0.8 }),
    ],
    toolLifecycle: [],
  });
  assert.equal(w.turns.length, 2);
  assert.deepEqual(
    w.turns.map((t) => [t.turn, t.ended, t.calls, t.freshInput, t.cachedInput, t.output, t.costCents]),
    [
      [1, true, 2, 1050, 1000, 30, 3],
      [2, false, 1, 30, 1900, 5, undefined],
    ],
  );
  assert.equal(w.totals.calls, 3);
  assert.equal(w.totals.costCents, undefined, 'one unpriced call makes the total unknown, never a guess');
  assert.equal(w.cacheHitRate, 0.8);
  assert.deepEqual(w.checkpoints, [{ turn: 1, turnId: 't1', ref: 'refs/zephyr/r1/turn-1', at: '2026-01-01T00:00:03.5Z' }]);
});

test('without turn ends, checkpoints close turns', () => {
  const w = runWork({
    codingWork: [
      call('a1', usage(10, 1)),
      checkpoint('a2', 't1', 'ref1'),
      call('a3', usage(10, 1)),
      checkpoint('a4', 't2', 'ref2'),
    ],
    toolLifecycle: [],
  });
  assert.deepEqual(
    w.turns.map((t) => [t.turn, t.ended, t.calls]),
    [
      [1, true, 1],
      [2, true, 1],
    ],
  );
});

test('shaped results attach to the turn they happened in, once per action phase', () => {
  const shaped = action('a1', 'shaped.run_tests', {});
  const summary = { outputSummary: 'test output digested: 14211 → 602 tokens' };
  const w = runWork({
    codingWork: [call('2026-01-01T00:00:01Z', usage(10, 1)), ended('2026-01-01T00:00:05Z', 't1'), call('2026-01-01T00:00:06Z', usage(10, 1))],
    toolLifecycle: [
      life('l1', 'succeeded', shaped, '2026-01-01T00:00:02Z', summary),
      life('l1', 'succeeded', shaped, '2026-01-01T00:00:02Z', summary),
      life('l2', 'succeeded', action('a2', 'shaped.build', {}), '2026-01-01T00:00:07Z', {
        outputSummary: 'build output digested: 3000 → 120 tokens',
      }),
    ],
  });
  assert.equal(w.levers.length, 2);
  assert.deepEqual(w.turns[0].levers.map(leverLabel), ['14k → 602']);
  assert.deepEqual(w.turns[1].levers.map((l) => l.what), ['build output']);
});

test('shell rows group lifecycle phases by action and keep class and decision', () => {
  const ls = action('a1', 'shell.exec', { tool: 'Bash', command: 'git status', class: 'inspect' });
  const rm = action('a2', 'shell.exec', { tool: 'Bash', command: 'npm i -g x', class: 'mutate_env' });
  const push = action('a3', 'git.publish', { tool: 'Bash', command: 'git push origin HEAD' });
  const auth = (actionId, policy, allowed, reasonCodes) => ({
    actionId,
    recommendation: { policy, confidence: 1, probabilities: {}, reasonCodes: [] },
    finalPolicy: policy,
    allowed,
    reasonCodes,
    at: 't',
  });
  const w = runWork({
    codingWork: [],
    toolLifecycle: [
      life('e1', 'proposed', ls, 't1'),
      life('e2', 'policy_decided', ls, 't2', { authorization: auth('a1', 'auto', true, ['shell-inspect', 'read-only']) }),
      life('e3', 'succeeded', ls, 't3'),
      life('e4', 'awaiting_approval', rm, 't4', { authorization: auth('a2', 'ask_user', false, ['shell-mutate_env', 'installs globally']) }),
      life('e5', 'blocked', rm, 't5'),
      life('e6', 'awaiting_approval', push, 't6', { authorization: auth('a3', 'ask_user', false, ['git-publish-requires-exact-approval']) }),
      life('e7', 'succeeded', action('a4', 'file.write', {}), 't7'),
    ],
  });
  assert.deepEqual(
    w.shell.map((r) => [r.command, r.shellClass, r.phase, r.policy, r.allowed]),
    [
      ['git status', 'inspect', 'succeeded', 'auto', true],
      ['npm i -g x', 'mutate_env', 'blocked', 'ask_user', false],
      ['git push origin HEAD', undefined, 'awaiting_approval', 'ask_user', false],
    ],
  );
  assert.deepEqual(w.shell[1].reasons, ['shell-mutate_env', 'installs globally']);
  assert.equal(w.shell[0].at, 't1');
});

test('an empty or browser-only run has no coding work', () => {
  const w = runWork({ codingWork: [], toolLifecycle: [] });
  assert.equal(hasRunWork(w), false);
  assert.equal(w.turns.length, 1);
  assert.equal(w.totals.costCents, undefined);
  assert.equal(hasRunWork(runWork({ codingWork: [], toolLifecycle: undefined })), false);
});

test('budget blocks show on the turn they stopped', () => {
  const w = runWork({
    codingWork: [call('a', usage(10, 1)), { type: 'gateway.blocked', runId: 'r1', reason: 'token_budget', detail: 'x', at: 'b' }],
    toolLifecycle: [],
  });
  assert.deepEqual(w.turns[0].blocked, ['Token budget reached']);
});

test('rewind is offered only where the API would accept it', async () => {
  const { rewindGate } = await import('../src/lib/runWork.ts');
  assert.deepEqual(rewindGate('paused', true), { allowed: true });
  assert.deepEqual(rewindGate('awaiting_approval', true), { allowed: true });
  assert.equal(rewindGate('running', true).allowed, false);
  assert.equal(rewindGate('pending', true).allowed, false);
  assert.match(rewindGate('succeeded', true).reason, /finished/);
  assert.match(rewindGate('paused', false).reason, /no longer on disk/);
  assert.equal(rewindGate(undefined, true).allowed, false);
});

test('shell outcomes read as what happened', async () => {
  const { shellOutcome } = await import('../src/lib/runWork.ts');
  const row = (phase, policy, allowed) => ({ actionId: 'a', toolId: 'shell.exec', command: 'x', phase, policy, allowed, reasons: [], at: 't' });
  assert.equal(shellOutcome(row('succeeded', 'auto', true)), 'Ran automatically');
  assert.equal(shellOutcome(row('succeeded', 'ask_user', true)), 'Ran after approval');
  assert.equal(shellOutcome(row('blocked', 'block', false)), 'Blocked');
  assert.equal(shellOutcome(row('awaiting_approval', 'ask_user', false)), 'Waiting for you');
  assert.equal(shellOutcome(row('policy_decided', 'block', false)), 'Not allowed');
});
