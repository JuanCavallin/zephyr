import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('no leading or trailing dashes', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify('--a--'), 'a');
  assert.equal(slugify('Add Login Page'), 'add-login-page');
});
