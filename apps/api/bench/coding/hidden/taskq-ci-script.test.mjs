import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the ci script runs a lint file that exists, then the tests', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const m = /node\s+(\S+\.mjs)/.exec(pkg.scripts.ci);
  assert.ok(m, 'ci runs a node script');
  assert.ok(existsSync(join(root, m[1])), m[1] + ' exists');
  assert.match(pkg.scripts.ci, /npm test/);
});
