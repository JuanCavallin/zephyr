// The task board against a running API (mock providers are enough): plan a change,
// then every review edit -- scope, pin, reorder, merge, split -- and the inbox.
//   WEB_ROOT=http://localhost:5173 node tests/board.browser.mjs
// The API must allow the web origin for local control (WEB_ORIGIN, default :5173).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const root = process.env.WEB_ROOT ?? 'http://localhost:5173';
const output = process.env.SCREENSHOT_DIR;
const errors = [];
const passed = [];

const cards = (page) => page.locator('.board-card');
const titles = (page) => page.locator('.board-card h3').allInnerTexts();

try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(root + '/board');
  await page.getByLabel('What should change?').fill(
    'Add a rate limiter to the API\nAdd a settings page for the limiter\nDocument both in the README',
  );
  await page.getByRole('button', { name: 'Plan tasks' }).click();
  await page.waitForURL(/\/board\/[^/]+$/);
  await page.locator('.board-card').first().waitFor();
  const planned = await cards(page).count();
  assert.ok(planned >= 3, 'expected at least 3 planned tasks, got ' + planned);
  await page.getByText('Nothing runs until you start it').waitFor();
  await page.getByRole('complementary', { name: 'Needs you' }).waitFor();
  passed.push('Planning creates a board of ' + planned + ' tasks and runs nothing');

  // Edit scope.
  const first = cards(page).first();
  await first.getByRole('button', { name: 'Edit scope' }).click();
  await first.locator('textarea').fill('src/limiter/**\nsrc/limiter.test.ts');
  await first.getByRole('button', { name: 'Save scope' }).click();
  await first.locator('.board-scope li', { hasText: 'src/limiter.test.ts' }).waitFor();
  passed.push('Edit scope updates the card');

  // Pin an assignee.
  await first.getByRole('combobox').selectOption('codex-standard');
  await page.waitForFunction(() => document.querySelector('.board-card .board-pin span')?.textContent === 'Pinned to');
  assert.equal(await first.getByRole('combobox').inputValue(), 'codex-standard');
  passed.push('Pin assignee sticks');

  // Reorder.
  const before = await titles(page);
  await first.getByRole('button', { name: 'Move down' }).click();
  await page.waitForFunction((t) => document.querySelectorAll('.board-card h3')[1]?.textContent === t, before[0]);
  passed.push('Reorder moves the card');

  // Merge two.
  const boxes = page.locator('.board-card header input[type=checkbox]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole('button', { name: 'Merge selected' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.board-card').length === n, planned - 1);
  passed.push('Merge selected combines two cards');

  // Split one back into two.
  const target = cards(page).first();
  await target.getByRole('button', { name: 'Split' }).click();
  await target.getByLabel('Part 1 write scope').fill('src/a/**');
  await target.getByLabel('Part 2 write scope').fill('src/b/**');
  await target.locator('.board-editor').getByRole('button', { name: 'Split', exact: true }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.board-card').length === n, planned);
  assert.ok((await titles(page)).some((t) => t.endsWith('(part 2)')));
  passed.push('Split turns one card into two');

  if (output) await page.screenshot({ path: resolve(output, 'board.png'), fullPage: true });
  assert.equal(errors.length, 0, 'page errors: ' + errors.join('; '));
} finally {
  await browser.close();
}
for (const p of passed) console.log('  ok  ' + p);
console.log('board browser: ' + passed.length + ' passed');
