import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCount } from '../src/format.mjs';

test('formatCount', () => {
  assert.equal(formatCount(15300), '15.3k');
  assert.equal(formatCount(42), '42');
});
