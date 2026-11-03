import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('slugify lowercases and dashes', () => {
  assert.equal(slugify('Add Login Page'), 'add-login-page');
});
