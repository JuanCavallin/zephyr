import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs } from '../src/retry.mjs';

test('exponential backoff with a cap', () => {
  assert.equal(backoffMs(0), 100);
  assert.equal(backoffMs(3), 800);
  assert.equal(backoffMs(10), 5000);
  assert.equal(backoffMs(2, 50, 1000), 200);
});
