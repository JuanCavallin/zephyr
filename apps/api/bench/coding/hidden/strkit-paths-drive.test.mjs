import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRepoPath } from '../src/paths.mjs';

test('drive-letter paths are absolute', () => {
  assert.equal(toRepoPath('C:/Windows/x'), null);
  assert.equal(toRepoPath('d:/a'), null);
  assert.equal(toRepoPath('src/a.ts'), 'src/a.ts');
});
