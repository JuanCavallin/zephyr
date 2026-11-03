import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityQueue } from '../src/queue.mjs';

test('pop returns the highest priority first', () => {
  const q = new PriorityQueue();
  q.push('a', 1);
  q.push('b', 5);
  q.push('c', 3);
  assert.deepEqual([q.pop(), q.pop(), q.pop()], ['b', 'c', 'a']);
  assert.equal(q.pop(), undefined);
});
