import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean, median, quantile } from '../src/stats.mjs';

test('mean', () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test('median of odd length', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('quantile endpoints', () => {
  assert.equal(quantile([5, 1, 3], 0), 1);
  assert.equal(quantile([5, 1, 3], 1), 5);
});
