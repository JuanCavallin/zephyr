import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue } from '../src/queue.mjs';

test('size counts items', () => {
  const q = new PriorityQueue();
  q.push('a', 1);
  q.push('b', 2);
  assert.equal(q.size, 2);
});
