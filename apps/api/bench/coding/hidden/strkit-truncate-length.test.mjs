import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

test('cut text fits in max, ellipsis included', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  for (let max = 1; max <= 10; max++) assert.ok(truncate('abcdefghijklmnop', max).length <= max, 'max ' + max);
  assert.equal(truncate('abc', 3), 'abc');
});
