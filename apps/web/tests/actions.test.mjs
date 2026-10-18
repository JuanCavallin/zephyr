import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionStatus,
  actionFailureConsequence,
  approvalPreviewReady,
  groupActions,
  redactCredentialFields,
  safeResourceUrl,
} from '../src/lib/actions.ts';

const event = (id, phase, actionId = 'action-a', extra = {}) => ({
  id,
  runId: 'run',
  stepId: 'step',
  sessionStateId: 'session',
  phase,
  action: { id: actionId, toolId: 'spreadsheet.update', arguments: {}, dataLabels: ['private'] },
  at: '2026-10-05T12:00:00.000Z',
  ...extra,
});

test('actions retain identity and history across interleaved tools and replayed events', () => {
  const events = [
    event('a1', 'proposed'),
    event('b1', 'proposed', 'action-b'),
    event('a2', 'awaiting_approval', 'action-a', { approvalId: 'approval-a' }),
    event('a2', 'awaiting_approval', 'action-a', { approvalId: 'approval-a' }),
  ];
  const grouped = groupActions(events, [{ id: 'approval-a', status: 'pending' }]);
  assert.deepEqual(
    grouped.map((item) => item.id),
    ['action-a', 'action-b'],
  );
  assert.equal(grouped[0].events.length, 2);
  assert.equal(grouped[0].approval.id, 'approval-a');
  assert.equal(actionStatus(grouped[0]), 'Awaiting approval');
});

test('provider success never becomes verified without executed readback evidence', () => {
  const action = groupActions([event('a1', 'succeeded')])[0];
  assert.equal(actionStatus(action), 'Provider reported success');
  assert.equal(
    actionStatus(action, [{ phase: 'proposed', evidenceLevel: 'readback_verified' }]),
    'Provider reported success',
  );
  assert.equal(
    actionStatus(action, [{ phase: 'executed', evidenceLevel: 'provider_reported' }]),
    'Provider reported success',
  );
  assert.equal(
    actionStatus(action, [{ phase: 'executed', evidenceLevel: 'readback_verified' }]),
    'Verified changes',
  );
  assert.equal(
    actionStatus(action, [
      { phase: 'executed', evidenceLevel: 'readback_verified', executionMode: 'mock' },
    ]),
    'Simulated completion',
    'Simulated readback cannot imply that a live resource changed',
  );
  const replayed = groupActions([
    event('replayed-mock', 'succeeded', 'action-a', {
      evidence: { phase: 'executed', executionMode: 'mock', evidenceLevel: 'provider_reported' },
    }),
  ])[0];
  assert.equal(
    actionStatus(replayed),
    'Simulated completion',
    'Metadata from replay remains truthful even when the transient preview is expired',
  );
});

test('approve requires the current complete preview and matching fingerprint', () => {
  const action = groupActions(
    [event('a1', 'awaiting_approval')],
    [
      {
        id: 'approval-a',
        status: 'pending',
        proposedAction: {
          actionId: 'action-a',
          previewFingerprint: 'current-fingerprint',
          arguments: { previewRef: 'current-preview' },
        },
      },
    ],
  )[0];
  const loaded = (
    ref = 'current-preview',
    fingerprint = 'current-fingerprint',
    truncated = false,
    phase = 'proposed',
  ) => ({
    evidence: { phase, previewRef: ref, fingerprint },
    preview: { truncated },
  });
  assert.equal(
    approvalPreviewReady(action, []),
    false,
    'An expired or unloaded preview cannot be approved',
  );
  assert.equal(approvalPreviewReady(action, [loaded('old-preview')]), false);
  assert.equal(approvalPreviewReady(action, [loaded('current-preview', 'old-fingerprint')]), false);
  assert.equal(
    approvalPreviewReady(action, [loaded('current-preview', 'current-fingerprint', true)]),
    false,
  );
  assert.equal(
    approvalPreviewReady(action, [
      loaded('current-preview', 'current-fingerprint', false, 'executed'),
    ]),
    false,
  );
  assert.equal(approvalPreviewReady(action, [loaded()]), true);
  assert.equal(
    approvalPreviewReady(groupActions([event('generic', 'awaiting_approval')])[0], []),
    true,
    'Exact generic arguments are already present in the lifecycle action',
  );
});

test('failure outcomes distinguish unexecuted, partial and uncertain effects', () => {
  const blocked = groupActions([
    event('no-write', 'blocked', 'action-a', { outcome: 'not_executed' }),
  ])[0];
  const partial = groupActions([
    event('partial-write', 'failed', 'action-a', { outcome: 'partial' }),
  ])[0];
  const unknown = groupActions([
    event('unknown-write', 'failed', 'action-a', { outcome: 'unknown' }),
  ])[0];
  assert.match(actionFailureConsequence(blocked), /did not execute/);
  assert.match(actionFailureConsequence(partial), /Some effects completed/);
  assert.match(actionFailureConsequence(unknown), /may have changed/);
  assert.equal(actionStatus(partial), 'Partially completed');
  assert.equal(actionStatus(unknown), 'Outcome unknown');
});

test('a pending approval joins its canonical actionId before lifecycle has approvalId', () => {
  const action = groupActions(
    [event('a1', 'awaiting_approval')],
    [{ id: 'approval-a', status: 'pending', proposedAction: { actionId: 'action-a' } }],
  )[0];
  assert.equal(action.approval.id, 'approval-a');
});

test('rejected and uncertain writes have distinct truthful outcomes', () => {
  const rejected = groupActions(
    [event('a1', 'blocked', 'action-a', { approvalId: 'approval-a' })],
    [{ id: 'approval-a', status: 'rejected' }],
  )[0];
  assert.equal(actionStatus(rejected), 'Rejected');
  assert.equal(
    actionStatus(
      groupActions([
        event('a2', 'failed', 'action-b', {
          error: { code: 'WRITE_TIMEOUT', message: 'Uncertain outcome' },
        }),
      ])[0],
    ),
    'Outcome unknown',
  );
  assert.equal(actionStatus(groupActions([event('a3', 'failed')])[0]), 'Failed');
});

test('credential fields redact recursively while exact recipients and content remain reviewable', () => {
  const payload = {
    to: '+15555550123',
    body: 'Review this contract',
    data: [
      { api_key: 'secret', accessToken: 'secret', password: 'secret', subject: 'Call request' },
    ],
    authorization: 'Bearer secret',
  };
  const redacted = redactCredentialFields(payload);
  assert.equal(redacted.to, payload.to);
  assert.equal(redacted.body, payload.body);
  assert.equal(redacted.data[0].subject, 'Call request');
  assert.equal(JSON.stringify(redacted).includes('secret'), false);
  assert.equal(payload.data[0].api_key, 'secret');
});

test('resource links reject executable schemes and embedded credentials', () => {
  assert.equal(safeResourceUrl('javascript:alert(1)'), undefined);
  assert.equal(safeResourceUrl('file:///private.docx'), undefined);
  assert.equal(safeResourceUrl('https://user:password@example.com'), undefined);
  assert.equal(
    safeResourceUrl('https://office.example.com/document/1'),
    'https://office.example.com/document/1',
  );
});
