import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

test('short text is unchanged', () => {
  assert.equal(truncate('abc', 5), 'abc');
});

test('cut text never exceeds max', () => {
  assert.ok(truncate('abcdefghij', 5).length <= 5);
});
