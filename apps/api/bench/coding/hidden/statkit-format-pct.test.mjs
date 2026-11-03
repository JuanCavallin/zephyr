import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPercent } from '../src/format.mjs';

test('formatPercent', () => {
  assert.equal(formatPercent(0.256), '26%');
  assert.equal(formatPercent(0.256, 1), '25.6%');
  assert.equal(formatPercent(1), '100%');
});
