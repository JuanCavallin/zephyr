import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stddev } from '../src/stats.mjs';

test('sample standard deviation', () => {
  assert.ok(Math.abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001);
  assert.equal(stddev([5]), 0);
});
