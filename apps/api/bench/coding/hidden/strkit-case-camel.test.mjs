import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelCase, kebabCase } from '../src/case.mjs';

test('camelCase', () => {
  assert.equal(camelCase('hello world-foo'), 'helloWorldFoo');
  assert.equal(camelCase('  Add USER id '), 'addUserId');
  assert.equal(kebabCase('Hello World'), 'hello-world');
});
