import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRepoPath } from '../src/paths.mjs';

test('windows separators', () => {
  assert.equal(toRepoPath('src\\a\\b.ts'), 'src/a/b.ts');
  assert.equal(toRepoPath('src\\x\\..\\y.ts'), 'src/y.ts');
  assert.equal(toRepoPath('..\\x'), null);
});

test('forward slashes still work', () => {
  assert.equal(toRepoPath('src/a/b.ts'), 'src/a/b.ts');
  assert.equal(toRepoPath('/etc/passwd'), null);
});
