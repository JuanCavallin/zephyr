import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRepoPath } from '../src/paths.mjs';

test('resolves dot segments', () => {
  assert.equal(toRepoPath('src/./a/../b.ts'), 'src/b.ts');
});

test('rejects escapes', () => {
  assert.equal(toRepoPath('../etc/passwd'), null);
});
