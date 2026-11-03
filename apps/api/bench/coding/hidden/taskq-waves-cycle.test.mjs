import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waves } from '../src/waves.mjs';

test('a cycle or unknown dependency throws instead of hanging', () => {
  assert.throws(() => waves([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle/);
  assert.throws(() => waves([{ id: 'a', dependsOn: ['zzz'] }]), /cycle/);
  assert.deepEqual(waves([{ id: 'a', dependsOn: [] }]), [['a']]);
});
