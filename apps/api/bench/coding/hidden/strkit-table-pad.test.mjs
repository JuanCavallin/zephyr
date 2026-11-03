import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padTable } from '../src/table.mjs';

test('columns are aligned two spaces apart', () => {
  assert.deepEqual(padTable([['a', 'bb'], ['ccc', 'd']]), ['a    bb', 'ccc  d']);
  assert.deepEqual(padTable([]), []);
});
