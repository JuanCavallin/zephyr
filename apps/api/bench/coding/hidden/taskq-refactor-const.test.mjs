import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTEMPTS, PriorityQueue } from '../src/queue.mjs';

test('MAX_ATTEMPTS is exported and still three', () => {
  assert.equal(MAX_ATTEMPTS, 3);
  const q = new PriorityQueue();
  assert.equal(q.retry('x', 1), true);
  assert.equal(q.retry('x', 1), true);
  assert.equal(q.retry('x', 1), false);
});
