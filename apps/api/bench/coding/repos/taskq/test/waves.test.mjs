import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waves } from '../src/waves.mjs';

test('dependencies run in later waves', () => {
  const out = waves([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: [] },
  ]);
  assert.deepEqual(out, [['a', 'c'], ['b']]);
});
