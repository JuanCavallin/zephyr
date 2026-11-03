import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents } from '../src/format.mjs';

test('formatCents has two decimals', () => {
  assert.equal(formatCents(1234), '$12.34');
  assert.equal(formatCents(5), '$0.05');
});
