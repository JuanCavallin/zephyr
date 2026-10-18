import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDebugEntries, debugReport } from '../src/lib/debugLog.ts';

const base = {
  run: null,
  steps: [],
  approvals: [],
  egress: [],
  piiSpans: [],
  scheduleDecisions: [],
  browserSessions: [],
  controlDecisions: [],
  modelCalls: [],
  harnessTurns: [],
  toolLifecycle: [],
  agentSessions: [],
  logs: [],
  lastSeq: 0,
};

const call = (id, phase, at, extra = {}) => ({
  id: id + ':' + phase,
  modelCallId: id,
  runId: 'r',
  stepId: 's1',
  sessionStateId: 'ses',
  phase,
  routeId: 'anthropic-cheap',
  providerId: 'anthropic',
  configuredModelId: 'haiku',
  selectedToolIds: [],
  dataLabels: ['public'],
  messageCount: 2,
  at,
  ...extra,
});

test('a failed model call is an error and the next call is labelled a retry', () => {
  const entries = buildDebugEntries({
    ...base,
    modelCalls: [
      call('a', 'requested', '2026-01-01T00:00:00.000Z'),
      call('a', 'failed', '2026-01-01T00:00:01.000Z', {
        error: { code: 'MODEL_CALL_FAILED', message: 'HTTP 502' },
      }),
      call('b', 'requested', '2026-01-01T00:00:03.000Z'),
      call('b', 'completed', '2026-01-01T00:00:04.000Z', {
        inputPreview: '[user] hi',
        outputPreview: 'hello',
      }),
    ],
  });
  const [first, second] = entries.filter((entry) => entry.kind === 'model');
  assert.equal(first.level, 'error');
  assert.match(first.summary, /HTTP 502/);
  assert.equal(second.level, 'ok');
  assert.match(second.title, /retry #1/);
  assert.ok(second.details.some((item) => item.label === 'OUTPUT' && item.value === 'hello'));
});

test('withheld model I/O is stated, never silently empty', () => {
  const [entry] = buildDebugEntries({
    ...base,
    modelCalls: [call('c', 'completed', '2026-01-01T00:00:00.000Z', { ioWithheld: true })],
  });
  assert.ok(entry.details.some((item) => /Withheld/.test(item.value)));
});

test('a routing decision that grants no tools is a warning', () => {
  const [entry] = buildDebugEntries({
    ...base,
    scheduleDecisions: [
      {
        id: 'd',
        runId: 'r',
        stepId: 's1',
        requestedCapability: 'agent.runtime',
        selectedProvider: 'hermes',
        privacy: 'public',
        intelligence: 'high',
        privacyConfidence: 1,
        intelligenceConfidence: 1,
        modelTier: 'cloud',
        availableTools: ['browserbase.search'],
        exposedTools: [],
        confidence: 0.5,
        escalated: false,
        rule: 'route-failed-safe-local',
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  assert.equal(entry.level, 'warn');
  assert.match(entry.summary, /NO tools granted/);
});

test('the copied report lists entries with relative timestamps', () => {
  const entries = buildDebugEntries({
    ...base,
    logs: [{ level: 'error', message: 'boom', at: '2026-01-01T00:00:02.000Z' }],
  });
  assert.match(debugReport(entries, entries[0].at - 1000), /1\.0s\s+ERROR\s+Log\s+boom/);
});
