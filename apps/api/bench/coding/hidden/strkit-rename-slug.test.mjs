import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as slug from '../src/slug.mjs';

test('toSlug with a deprecated slugify alias', () => {
  assert.equal(typeof slug.toSlug, 'function');
  assert.equal(slug.toSlug('Add Login'), 'add-login');
  assert.equal(slug.slugify('Add Login'), 'add-login');
});
