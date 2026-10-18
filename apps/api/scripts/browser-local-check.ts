import assert from 'node:assert/strict';
import type { ProviderResult } from '@htn/shared';
import { createLiveLocalBrowser } from '../src/providers/localbrowser/live.js';
import { withBrowserOwnership } from '../src/providers/withBrowserOwnership.js';
import { createDeterministicDecider } from '../src/core/tools/browserDecision.js';

// Manual, harmless synthetic page only. This proves local viewer/input mechanics;
// it makes no claim that Google, ASOS, or DuckDuckGo accept automated Chrome.
const adapter = withBrowserOwnership(
  createLiveLocalBrowser({
    mode: 'live',
    channel: process.env.LOCALBROWSER_CHANNEL || 'chrome',
    headless: false,
    keyVar: 'LOCALBROWSER_CHANNEL',
  }),
);
const ctx = {
  runId: 'local_synthetic_check_' + Date.now(),
  policyRule: 'synthetic-local-browser-verification',
};
const decide = createDeterministicDecider();
function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
  return result.data;
}
const html =
  '<!doctype html><title>Local synthetic handoff</title><h1>AgentOS synthetic handoff</h1><label>Name <input aria-label="Name"></label><button>Preview</button>';
try {
  const sessionId = value(
    await adapter.openSession({ startUrl: 'data:text/html,' + encodeURIComponent(html) }, ctx),
  ).sessionId;
  const watch = value(await adapter.viewer!({ sessionId, mode: 'watch' }, ctx));
  assert.equal(watch.kind, 'stream');
  assert.equal(watch.interactive, false);
  const initialFrame = value(await adapter.captureFrame!(sessionId, ctx));
  assert.ok(initialFrame.bytes.byteLength > 1000);
  assert.equal(initialFrame.width, 1280);
  const table = value(await adapter.snapshot!({ sessionId }, ctx));
  const chosen = await decide({ goal: 'Name', table, allowedOperations: ['TYPE_TEXT'] });
  value(
    await adapter.perform!(
      {
        sessionId,
        snapshotId: table.snapshotId,
        operation: 'TYPE_TEXT',
        index: chosen.index,
        text: 'agent fixture',
      },
      ctx,
    ),
  );
  await adapter.setOwnership!({ sessionId, owner: 'human', expectedRevision: 0 }, ctx);
  value(
    await adapter.humanInput!(
      { sessionId, expectedRevision: 1, input: { type: 'key', key: 'End' } },
      ctx,
    ),
  );
  value(
    await adapter.humanInput!(
      { sessionId, expectedRevision: 1, input: { type: 'text', text: ' manual fixture' } },
      ctx,
    ),
  );
  await adapter.setOwnership!({ sessionId, owner: 'agent', expectedRevision: 1 }, ctx);
  const resumed = value(await adapter.snapshot!({ sessionId }, ctx));
  assert.match(resumed.rows.find((row) => row.label === 'Name')?.value ?? '', /manual fixture/);
  await assert.rejects(
    adapter.humanInput!(
      { sessionId, expectedRevision: 1, input: { type: 'text', text: 'blocked' } },
      ctx,
    ),
  );
  console.log(
    JSON.stringify({
      provider: 'localbrowser',
      mode: 'live',
      headed: true,
      syntheticPageOnly: true,
      frame: true,
      ownerCheckedHumanInput: true,
      revokedBeforeResume: true,
      sameSessionReadback: true,
      publicSitesTested: false,
    }),
  );
} finally {
  await adapter.releaseRun!(ctx.runId, { ...ctx, policyRule: 'browser-test-release' });
}
