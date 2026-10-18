/**
 * Real installed Chrome, headless, synthetic inline page only.
 *
 * Proves the reviewed-identity re-check on the local engine (local Chrome, and
 * Browserless, which shares it): the in-page role/label computed before a
 * click must equal the snapshot's, for every kind of control, or every live
 * click would be refused as stale. Also proves an element the page relabelled
 * on its own IS refused.
 *
 *   pnpm --filter @htn/api check:browser-identity-local
 */
import assert from 'node:assert/strict';
import type { ProviderResult } from '@htn/shared';
import { createLiveLocalBrowser } from '../src/providers/localbrowser/live.js';

const adapter = createLiveLocalBrowser({
  mode: 'live',
  channel: process.env.LOCALBROWSER_CHANNEL || 'chrome',
  headless: true,
  keyVar: 'LOCALBROWSER_CHANNEL',
});
const ctx = {
  runId: 'identity_check_' + Date.now(),
  policyRule: 'synthetic-local-browser-verification',
};
function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
  return result.data;
}

const long =
  'Read the full guide to browser automation with typed decisions and calibrated confidence today';
const html =
  '<!doctype html><title>Identity check</title><main>' +
  '<button>Place order</button>' +
  '<a href="#guide">' +
  long +
  '</a>' +
  '<div role="button" tabindex="0">  Go   now </div>' +
  '<button aria-label="  Spaced   label ">x</button>' +
  '<input type="submit" value="Send">' +
  '<input aria-label="Name">' +
  '<button role="">Empty role</button>' +
  '<button id="t">Target</button>' +
  // The page relabels the button on its own, as async rendering does: the
  // agent took no action, so only the identity re-check can notice.
  '<script>setTimeout(function () { document.getElementById("t").textContent = "Changed"; }, 1500)</script>' +
  '</main>';

const sessionId = value(
  await adapter.openSession({ startUrl: 'data:text/html,' + encodeURIComponent(html) }, ctx),
).sessionId;
try {
  const early = value(await adapter.snapshot!({ sessionId }, ctx));
  const target = early.rows.find((row) => row.label === 'Target');
  assert.ok(target, 'snapshot has the target: ' + early.rows.map((r) => r.label).join(' | '));
  assert.ok(
    early.rows.some((row) => row.label === long.slice(0, 79) + '…'),
    'long labels are truncated identically',
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const relabelled = await adapter.perform!(
    { sessionId, snapshotId: early.snapshotId, operation: 'CLICK', index: target.index },
    ctx,
  );
  assert.ok(!relabelled.ok, 'a relabelled element is not clicked');
  assert.equal(!relabelled.ok && relabelled.error.message, 'stale_snapshot');

  // Every other control. An action invalidates the snapshot, so take a fresh
  // one per action, as the executor does.
  const labels = value(await adapter.snapshot!({ sessionId }, ctx))
    .rows.map((row) => row.label)
    .filter((label) => label !== 'Changed');
  for (const label of labels) {
    const table = value(await adapter.snapshot!({ sessionId }, ctx));
    const row = table.rows.find((candidate) => candidate.label === label)!;
    const operation = row.editable ? 'TYPE_TEXT' : 'CLICK';
    const result = await adapter.perform!(
      {
        sessionId,
        snapshotId: table.snapshotId,
        operation,
        index: row.index,
        ...(row.editable ? { text: 'x' } : {}),
      },
      ctx,
    );
    assert.ok(
      result.ok,
      'identity matches for ' +
        row.role +
        ' "' +
        row.label +
        '": ' +
        JSON.stringify(!result.ok && result.error),
    );
  }
  console.log(
    'PASS: real Chrome identity re-check matches the snapshot for ' +
      labels.length +
      ' controls and refuses an element the page relabelled.',
  );
} finally {
  await adapter.closeSession(sessionId, ctx);
}
