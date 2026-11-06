import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATEGORIES,
  categoryFromParam,
  countsByCategory,
  firstAttentionPath,
  relativeTime,
  statusGlyph,
  summaryLine,
} from '../src/lib/integrations.ts';

test('categoryFromParam maps known kinds and falls back to keys', () => {
  assert.equal(categoryFromParam('mcp'), 'mcp');
  assert.equal(categoryFromParam('harnesses'), 'harnesses');
  assert.equal(categoryFromParam('system'), 'system');
  assert.equal(categoryFromParam('nope'), 'keys');
  assert.equal(categoryFromParam(undefined), 'keys');
});

test('the rail lists the P0 categories in order', () => {
  assert.deepEqual(
    CATEGORIES.map((c) => c.id),
    ['keys', 'harnesses', 'mcp', 'connectors', 'system'],
  );
});

test('summaryLine names connected and, only when non-zero, what needs the user', () => {
  assert.equal(
    summaryLine({ connected: 3, needsAttention: 1, available: 6 }),
    '3 connected, 1 needs you',
  );
  assert.equal(summaryLine({ connected: 0, needsAttention: 0, available: 2 }), '0 connected');
  assert.equal(
    summaryLine({ connected: 1, needsAttention: 2, available: 0 }),
    '1 connected, 2 need you',
  );
});

test('countsByCategory counts connected items only', () => {
  const items = [
    { kind: 'key', id: 'a', name: 'A', status: 'connected', detail: '' },
    { kind: 'key', id: 'b', name: 'B', status: 'available', detail: '' },
    { kind: 'mcp', id: 'm', name: 'M', status: 'connected', detail: '' },
    { kind: 'harness', id: 'h', name: 'H', status: 'needs_attention', detail: '' },
  ];
  assert.deepEqual(countsByCategory(items), {
    keys: 1,
    harnesses: 0,
    mcp: 1,
    connectors: 0,
    system: 0,
  });
});

test('statusGlyph maps every status to a ladder role', () => {
  assert.equal(statusGlyph('connected'), 'done');
  assert.equal(statusGlyph('needs_attention'), 'attention');
  assert.equal(statusGlyph('error'), 'error');
  assert.equal(statusGlyph('available'), 'planned');
  assert.equal(statusGlyph('disabled'), 'off');
});

test('firstAttentionPath deep-links the first item that needs the user', () => {
  assert.equal(firstAttentionPath([]), undefined);
  assert.equal(
    firstAttentionPath([
      { kind: 'key', id: 'a', name: 'A', status: 'connected', detail: '' },
      { kind: 'harness', id: 'claudecode', name: 'C', status: 'needs_attention', detail: '' },
      { kind: 'key', id: 'tavily', name: 'T', status: 'error', detail: '' },
    ]),
    '/integrations/harnesses/claudecode',
  );
  assert.equal(
    firstAttentionPath([{ kind: 'mcp', id: 'm 1', name: 'M', status: 'error', detail: '' }]),
    '/integrations/mcp/m%201',
  );
});

test('relativeTime renders unknown as a dash, never zero', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');
  assert.equal(relativeTime(undefined, now), '—');
  assert.equal(relativeTime('not a date', now), '—');
  assert.equal(relativeTime('2026-11-05T11:59:50.000Z', now), 'just now');
  assert.equal(relativeTime('2026-11-05T11:55:00.000Z', now), '5 min ago');
  assert.equal(relativeTime('2026-11-05T09:00:00.000Z', now), '3 h ago');
  assert.equal(relativeTime('2026-11-03T12:00:00.000Z', now), '2 d ago');
});
