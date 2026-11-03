import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue } from '../src/queue.mjs';

test('peek shows the highest-priority item without removing it', () => {
  const q = new PriorityQueue();
  assert.equal(q.peek(), undefined);
  q.push('a', 1);
  q.push('b', 5);
  assert.equal(q.peek(), 'b');
  assert.equal(q.size, 2);
});
