import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

test('lint passes and still bans console.log', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'lint.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(root, 'scripts', 'lint.mjs'), 'utf8').includes('console\\.log'), 'rule kept');
});
