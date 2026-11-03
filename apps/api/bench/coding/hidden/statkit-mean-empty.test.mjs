import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mean } from '../src/stats.mjs';

test('mean of nothing is zero', () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([2, 4]), 3);
});
