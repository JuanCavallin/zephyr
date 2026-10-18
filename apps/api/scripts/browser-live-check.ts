import type { BrowserAdapter, BrowserBackend, ProviderResult } from '@htn/shared';
import { config } from '../src/config.js';
import { createLiveBrowserbase } from '../src/providers/browserbase/live.js';
import { createLiveBrowserless } from '../src/providers/browserless/live.js';
import { createLiveLocalBrowser } from '../src/providers/localbrowser/live.js';
import { withBrowserOwnership } from '../src/providers/withBrowserOwnership.js';
import { createDeterministicDecider } from '../src/core/tools/browserDecision.js';

// Manual verification only. No real form is submitted, account changed, or message sent.
// Live provider credentials stay in the process; reports omit bearer URLs and payloads.
const backend = (process.env.VERIFY_BROWSER_BACKEND ?? config.browser.backend) as BrowserBackend;
if (!['browserbase', 'browserless', 'localbrowser'].includes(backend))
  throw new Error('Invalid VERIFY_BROWSER_BACKEND.');
const cfg = config.providers[backend];
if (backend !== 'localbrowser' && !cfg.apiKey && config.credentials.browserSource !== 'user') {
  console.log(
    JSON.stringify({
      backend,
      mode: 'live',
      status: 'blocked',
      reason: 'Provider credentials are missing. This is not a live pass.',
    }),
  );
  process.exit(2);
}
const raw =
  backend === 'browserbase'
    ? createLiveBrowserbase(cfg)
    : backend === 'browserless'
      ? createLiveBrowserless(cfg)
      : createLiveLocalBrowser(cfg);
const adapter: BrowserAdapter = withBrowserOwnership(raw);
const ctx = {
  runId: 'manual_browser_check_' + Date.now(),
  policyRule: 'authorized-public-site-and-synthetic-browser-rehearsal',
};
const decide = createDeterministicDecider();
function safeFailure(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const provider of Object.values(config.providers)) {
    for (const secret of [provider.apiKey, provider.projectId].filter((value): value is string =>
      Boolean(value),
    )) {
      message = message
        .replaceAll(secret, '[redacted]')
        .replaceAll(encodeURIComponent(secret), '[redacted]');
    }
  }
  return message
    .replace(/([?&](?:token|apikey|api_key|key)=)[^&\s"']+/gi, '$1[redacted]')
    .slice(0, 400);
}
function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(result.error.code + ': ' + safeFailure(result.error.message));
  return result.data;
}
const report: { backend: string; mode: string; results: unknown[] } = {
  backend,
  mode: 'live',
  results: [],
};
const sites = [
  { name: 'Google', url: 'https://www.google.com/search?q=agentos+browser+automation' },
  { name: 'ASOS', url: 'https://www.asos.com/search/?q=tshirt' },
  { name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=agentos+browser+automation' },
];
try {
  for (const site of process.env.VERIFY_BROWSER_SYNTHETIC_ONLY === 'true' ? [] : sites) {
    let sessionId: string | undefined;
    try {
      const opened = value(await adapter.openSession({ startUrl: site.url }, ctx));
      sessionId = opened.sessionId;
      const table = value(await adapter.snapshot!({ sessionId }, ctx));
      const evidence = value(
        await adapter.extract<{ text?: string }>({ sessionId, instruction: '' }, ctx),
      );
      const blocked =
        /verify.{0,20}(human|request)|captcha|access denied|unusual traffic|automated quer|robot|security check/i.test(
          evidence.text ?? '',
        );
      report.results.push({
        site: site.name,
        loaded: true,
        controls: table.rows.length,
        evidenceCharacters: evidence.text?.length ?? 0,
        blocked,
        actualSearchResultVerified: !blocked && (evidence.text?.length ?? 0) > 100,
        claim: 'Search result evidence only; no anti-bot guarantee.',
      });
    } catch (error) {
      report.results.push({
        site: site.name,
        loaded: false,
        status: 'failed',
        reason: safeFailure(error),
      });
    } finally {
      if (sessionId)
        await adapter
          .closeSession(sessionId, { ...ctx, policyRule: 'browser-test-release' })
          .catch(() => undefined);
    }
  }
  const fixture =
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      '<!doctype html><title>AgentOS synthetic handoff</title><label>Name <input aria-label="Name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Preview</button><output></output>',
    );
  for (
    let rehearsal = 1;
    rehearsal <= Number(process.env.VERIFY_BROWSER_REHEARSALS || 3);
    rehearsal++
  ) {
    let sessionId: string | undefined;
    try {
      sessionId = value(await adapter.openSession({ startUrl: fixture }, ctx)).sessionId;
      const watch = value(await adapter.viewer!({ sessionId, mode: 'watch' }, ctx));
      if (!watch.canWatch || watch.interactive) throw new Error('Watch enforcement unavailable');
      const table = value(await adapter.snapshot!({ sessionId }, ctx));
      const decision = await decide({ goal: 'Name', table, allowedOperations: ['TYPE_TEXT'] });
      value(
        await adapter.perform!(
          {
            sessionId,
            snapshotId: table.snapshotId,
            operation: 'TYPE_TEXT',
            index: decision.index,
            text: 'agent fixture',
          },
          ctx,
        ),
      );
      await adapter.setOwnership!({ sessionId, owner: 'human', expectedRevision: 0 }, ctx);
      const control = value(await adapter.viewer!({ sessionId, mode: 'control' }, ctx));
      if (!control.canControl || !control.interactive) throw new Error('Control unavailable');
      value(
        await adapter.humanInput!(
          { sessionId, expectedRevision: 1, input: { type: 'text', text: ' manual fixture' } },
          ctx,
        ),
      );
      await adapter.setOwnership!({ sessionId, owner: 'agent', expectedRevision: 1 }, ctx);
      const resumed = value(await adapter.snapshot!({ sessionId }, ctx));
      const observed = resumed.rows.find((row) => row.label === 'Name')?.value;
      if (!observed?.includes('manual fixture'))
        throw new Error('Manual state did not persist across resume');
      if (watch.kind === 'stream') value(await adapter.captureFrame!(sessionId, ctx));
      report.results.push({
        rehearsal,
        watch: true,
        syntheticHumanInput: true,
        revokedBeforeResume: true,
        sameSessionReadback: true,
        viewerRefresh: Boolean(
          value(await adapter.viewer!({ sessionId, mode: 'watch' }, ctx)).canWatch,
        ),
        interactiveViewerClientAttached: false,
        claim:
          'Provider protocol verified; real iframe/canvas client and representative human wait require a separate UI rehearsal.',
      });
    } catch (error) {
      report.results.push({ rehearsal, status: 'failed', reason: safeFailure(error) });
    } finally {
      if (sessionId)
        await adapter
          .closeSession(sessionId, { ...ctx, policyRule: 'browser-test-release' })
          .catch(() => undefined);
    }
  }
} finally {
  await adapter.releaseRun!(ctx.runId, { ...ctx, policyRule: 'browser-test-release' }).catch(
    () => undefined,
  );
  console.log(JSON.stringify(report, null, 2));
}
if (report.results.some((entry) => (entry as { status?: string }).status === 'failed'))
  process.exitCode = 1;
