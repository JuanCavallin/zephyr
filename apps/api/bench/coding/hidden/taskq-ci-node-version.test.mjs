import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the workflow node version satisfies engines.node', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const min = Number(/>=\s*(\d+)/.exec(pkg.engines.node)[1]);
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const versions = [...yml.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(versions.length > 0, 'workflow still sets up node');
  for (const v of versions) assert.ok(v >= min, `node-version ${v} < engines ${min}`);
  assert.match(yml, /run: npm run ci/, 'workflow still runs the ci script');
});
