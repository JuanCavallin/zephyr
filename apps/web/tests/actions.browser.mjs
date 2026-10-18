import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const root = process.env.WEB_TEST_URL ?? 'http://localhost:5173';
const output = resolve(process.env.SCREENSHOT_DIR ?? '../../.data/qa/action-workspace');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const passed = [];
const errors = [];
let page;

const waitReady = async () => {
  await page.getByRole('button', { name: 'Approve changes', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent.trim() === 'Approve changes',
    );
    return button && !button.disabled;
  });
};
const openExample = async (label) => {
  await page.goto(root + '/connections');
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL('**/runs/**');
  await page.getByRole('complementary', { name: 'Action workspace' }).waitFor();
};
const reviewNext = async () => {
  await page.getByRole('button', { name: 'Review & decide', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review & decide', exact: true }).click();
  await waitReady();
};
const createRun = async (nodes) => {
  const created = await page.request.post(root + '/api/graphs', {
    headers: { Origin: root },
    data: { name: 'Action workspace UI regression', nodes, edges: [] },
  });
  assert.equal(created.status(), 201, await created.text());
  const { graph } = await created.json();
  const started = await page.request.post(root + '/api/runs', {
    headers: { Origin: root },
    data: { kind: 'graph', input: { graphId: graph.id, variables: {} } },
  });
  assert.equal(started.status(), 201, await started.text());
  const { run } = await started.json();
  await page.goto(root + '/runs/' + run.id);
  await page.getByRole('complementary', { name: 'Action workspace' }).waitFor();
  return run.id;
};

try {
  await mkdir(output, { recursive: true });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(root + '/connections');
  await page.getByText('Model credential source:', { exact: false }).waitFor();
  const status = await (await page.request.get(root + '/api/providers')).json();
  assert.equal(
    status.providers.find((item) => item.id === 'hermes')?.mode,
    'mock',
    'This suite must use an explicitly mock API.',
  );
  assert.equal(status.providers.find((item) => item.id === 'browserbase')?.mode, 'mock');
  assert.equal(status.providers.find((item) => item.id === 'composio')?.mode, 'mock');
  await page
    .getByText(
      'Deprecated · compatibility backend. Switch to Browserless after hosted validation.',
      { exact: true },
    )
    .waitFor();

  // Exercise secret entry/clearing against an isolated transport fixture. No stored key is changed.
  const fixtureSecret = 'ui-regression-synthetic-not-a-key';
  let configured = false;
  const credentials = () => ({
    source: 'user',
    browserSource: 'user',
    lifetime: 'process',
    providers: [{ providerId: 'gemini', purpose: 'model', source: 'user', configured }],
  });
  await page.route('**/api/credentials', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(credentials()) }),
  );
  await page.route('**/api/credentials/gemini', async (route) => {
    if (route.request().method() === 'PUT') {
      assert.equal(route.request().postDataJSON().secret, fixtureSecret);
      configured = true;
    } else if (route.request().method() === 'DELETE') configured = false;
    else throw new Error('Unexpected credential fixture method.');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ provider: credentials().providers[0] }),
    });
  });
  await page.reload();
  await page.getByLabel('API key', { exact: true }).fill(fixtureSecret);
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
  await page.getByLabel('Provider', { exact: true }).selectOption('gemini');
  await page.getByLabel('API key', { exact: true }).fill(fixtureSecret);
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await page.getByText('Credential saved for this local session.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
  assert.equal((await page.locator('body').innerText()).includes(fixtureSecret), false);
  await page.getByRole('button', { name: 'Remove your gemini key', exact: true }).click();
  await page.getByText(/Your saved credential was removed/).waitFor();
  await page.unroute('**/api/credentials');
  await page.unroute('**/api/credentials/gemini');
  passed.push(
    'Credential UI clears password on provider switch/save, never redisplays a key, and supports removing a user key using an isolated transport fixture',
  );

  await openExample('Review a document change');
  await waitReady();
  assert.match(await page.locator('.action-workspace-header').innerText(), /mock/i);
  assert.equal(
    await page
      .locator('.action-workspace')
      .getByText('Connected account (ID)', { exact: true })
      .count(),
    0,
    'Local artifacts cannot invent a connected account',
  );
  assert.match(await page.locator('.action-workspace').innerText(), /Before state unavailable/);
  await page.screenshot({ path: resolve(output, 'document-approval.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve changes', exact: true }).click();
  await page
    .getByRole('button', { name: 'agentos.document_update Simulated completion', exact: true })
    .waitFor();
  await page
    .locator('.action-workspace')
    .getByText('Simulated completion', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator('.action-workspace')
      .getByText('Simulated completion', { exact: true })
      .count(),
    1,
    'New proposals must not replace the action being reviewed.',
  );
  await reviewNext();
  await page.getByRole('button', { name: 'Revise', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Revised exact action payload' });
  const envelope = JSON.parse(await draft.inputValue());
  assert.equal(envelope.arguments.artifactId, 'supervision-example');
  assert.match(envelope.arguments.content, /Reviewed and ready/);
  await draft.fill(
    JSON.stringify(
      { ...envelope, arguments: { ...envelope.arguments, artifactId: 'another-target' } },
      null,
      2,
    ),
  );
  await page.getByRole('button', { name: 'Send revised payload', exact: true }).click();
  await page.getByText(/Revision cannot change reviewed target/).waitFor();
  assert.equal(await draft.isEnabled(), true, 'A refused revision must remain reviewable.');
  await draft.fill(
    JSON.stringify(
      {
        ...envelope,
        arguments: { ...envelope.arguments, content: envelope.arguments.content.slice(0, 22) },
      },
      null,
      2,
    ),
  );
  await page.getByRole('button', { name: 'Send revised payload', exact: true }).click();
  await page.locator('.completion-line').filter({ hasText: 'Run complete' }).waitFor();
  await page.getByRole('region', { name: 'Simulated after', exact: true }).waitFor();
  assert.equal(await page.getByText('Readback verified', { exact: true }).count(), 0);
  await page.screenshot({ path: resolve(output, 'document-simulated-result.png'), fullPage: true });
  await page.reload();
  await page
    .getByRole('region', { name: 'Recorded actions' })
    .getByRole('button', { name: 'agentos.document_update Simulated completion', exact: true })
    .last()
    .waitFor();
  await page
    .getByRole('region', { name: 'Recorded actions' })
    .getByRole('button', { name: 'agentos.document_update Simulated completion', exact: true })
    .last()
    .click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByText('succeeded', { exact: true }).waitFor();
  passed.push(
    'Native document approval, rejected retargeting, narrowed revision, simulated results, stable selection, and terminal SSE replay',
  );

  await openExample('Review cell changes');
  await waitReady();
  await page.getByRole('table').getByText('Proposed after', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'spreadsheet-approval.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve changes', exact: true }).click();
  await reviewNext();
  await page.getByRole('button', { name: 'Revise', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Revised exact action payload', exact: true })
    .fill('{not-valid-json');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.locator('.completion-line').filter({ hasText: 'Run failed' }).waitFor();
  assert.match(await page.locator('.action-workspace').innerText(), /Rejected/);
  assert.match(await page.locator('.action-workspace').innerText(), /did not execute/);
  assert.equal(
    await page
      .getByRole('region', { name: 'Recorded actions' })
      .getByRole('button', { name: 'agentos.spreadsheet_update Simulated completion', exact: true })
      .count(),
    1,
  );
  passed.push(
    'Spreadsheet cell preview and rejection during revision prevent the pending second write while retaining the completed first write',
  );

  await page.goto(root + '/connections');
  await page.route('**/api/runs/*/previews/*', (route) =>
    route.fulfill({
      status: 410,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'PREVIEW_EXPIRED', message: 'Preview has expired for this UI test.' },
      }),
    }),
  );
  await page.getByRole('button', { name: 'Review a document change', exact: true }).click();
  await page.getByText(/Preview has expired for this UI test/).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Approve changes', exact: true }).isEnabled(),
    false,
  );
  assert.equal(await page.getByRole('button', { name: 'Revise', exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Reject', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await page.getByText(/Preview has expired for this UI test/).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Approve changes', exact: true }).isEnabled(),
    false,
  );
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.locator('.completion-line').filter({ hasText: 'Run failed' }).waitFor();
  await page.unroute('**/api/runs/*/previews/*');
  passed.push('Expired preview disables approve/revise and preserves reject');

  await page.goto(root + '/connections');
  await page.getByText('Model credential source:', { exact: false }).waitFor();
  await createRun([
    {
      id: 'office',
      type: 'tool',
      label: 'Reviewed mock Word change',
      position: { x: 0, y: 0 },
      config: {
        tool: 'microsoft_word.update_document',
        args: {
          document_id: 'mock-document-ui',
          expectedVersion: '1',
          content: 'Reviewed synthetic Word content.',
        },
      },
    },
  ]);
  await waitReady();
  assert.match(
    await page.locator('.action-workspace-header').innerText(),
    /microsoft_word.update_document[\s\S]*mock/i,
  );
  assert.match(
    await page.locator('.action-status-line').innerText(),
    /Connected account \(ID\): composio:mock:office/,
    'The reviewer sees the actual trusted connected account ID',
  );
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByText('Connected account (ID)', { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.action-facts dd')
      .getByText('composio:mock:office', { exact: true })
      .count(),
    1,
  );
  assert.equal(
    (await page.locator('.action-workspace').innerText()).includes('composio-connected-account:'),
    false,
    'Vault credential references must not be shown as account identity',
  );
  await page.getByRole('button', { name: 'Proposed changes', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'composio-account-approval.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve changes', exact: true }).click();
  await page.locator('.completion-line').filter({ hasText: 'Run complete' }).waitFor();
  assert.match(await page.locator('.action-workspace').innerText(), /Simulated completion/i);
  assert.equal(
    await page.locator('iframe').count(),
    0,
    'An API call must not imply a live Office window.',
  );
  passed.push(
    'Mock Composio Word action shares the workspace and exact approval API without a fabricated Office screen',
  );

  await openExample('Rehearse browser handoff');
  await page.getByRole('button', { name: 'Done — continue', exact: true }).waitFor();
  await page.getByText('Mock browser activity.', { exact: false }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(
    await page.getByRole('button', { name: 'Pause & take control', exact: true }).count(),
    0,
  );
  await page.screenshot({ path: resolve(output, 'mock-browser-handoff.png'), fullPage: true });
  // Inspect live-phase controls using transient transport fixtures; the underlying session stays mock.
  let frozenRevision;
  await page.route('**/api/runs/*/browser/*/live-view', async (route) => {
    const source = await (await route.fetch()).json();
    frozenRevision = source.revision;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...source,
        mode: 'live',
        phase: 'verifying',
        kind: 'none',
        canControl: true,
        reason: 'Manual verification pending (UI fixture).',
      }),
    });
  });
  await page.route('**/api/runs/*/browser/*/take-control', async (route) => {
    assert.equal(route.request().postDataJSON().revision, frozenRevision);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        providerId: 'browserbase',
        mode: 'live',
        kind: 'none',
        owner: 'human',
        phase: 'human_control',
        revision: frozenRevision + 1,
        canWatch: false,
        canControl: true,
        width: 1280,
        height: 720,
        interactive: false,
        reason: 'Isolated UI control recovery fixture.',
      }),
    });
  });
  await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
  await page.getByText('Verifying manual step · agent blocked', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry verification', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Supervised browser', exact: true })
      .getByRole('application')
      .count(),
    0,
    'Frozen verification cannot expose browser input',
  );
  await page.getByRole('button', { name: 'Return to manual control', exact: true }).click();
  await page.getByText('Isolated UI control recovery fixture.', { exact: true }).waitFor();
  await page.unroute('**/api/runs/*/browser/*/live-view');
  await page.unroute('**/api/runs/*/browser/*/take-control');
  await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
  await page.getByText('Mock browser activity.', { exact: false }).waitFor();
  let releaseRequests = 0;
  const releaseObserver = (request) => {
    if (request.url().endsWith('/release-control')) releaseRequests += 1;
  };
  page.on('request', releaseObserver);
  await page.getByRole('button', { name: 'Done — continue', exact: true }).click();
  await page.locator('.completion-line').filter({ hasText: 'Run complete' }).waitFor();
  page.off('request', releaseObserver);
  assert.equal(releaseRequests, 0, 'Approval is the sole handoff resume authority');
  assert.match(await page.locator('.action-workspace').innerText(), /Session ended/i);
  passed.push(
    'Mock browser handoff exposes no real viewer/input and completes only through approval; isolated live-phase UI fixture freezes verification and recovers human control',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await openExample('Review cell changes');
  await waitReady();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(output, 'mobile-spreadsheet-approval.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  passed.push('Narrow viewport keeps readable decisions and no horizontal page overflow');
  assert.deepEqual(errors, []);
  const report = {
    verifiedAt: new Date().toISOString(),
    backendMode: 'mock',
    passed,
    pageErrors: errors,
    screenshots: output,
  };
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
