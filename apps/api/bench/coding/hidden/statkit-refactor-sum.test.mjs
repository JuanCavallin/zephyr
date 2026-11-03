import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean, sum, variance } from '../src/stats.mjs';

test('sum is exported and behaviour is unchanged', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(variance([1, 2, 3]), 1);
});
