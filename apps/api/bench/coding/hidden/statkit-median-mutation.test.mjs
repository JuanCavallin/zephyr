import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../src/stats.mjs';

test('median leaves its input alone', () => {
  const input = [3, 1, 2];
  assert.equal(median(input), 2);
  assert.deepEqual(input, [3, 1, 2]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
