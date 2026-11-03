import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantile } from '../src/stats.mjs';

test('interpolates between order statistics', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  assert.equal(quantile([4, 1, 3, 2], 1), 4);
});
