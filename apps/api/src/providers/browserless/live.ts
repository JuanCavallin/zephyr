import { chromium, type CDPSession, type Page } from 'playwright-core';
import type { BrowserAdapter } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';
import { credentials, type CredentialStore } from '../../services/credentials.js';
import { createLiveLocalBrowser } from '../localbrowser/live.js';
import { browserFailure } from '../browserSafety.js';

/** CDP transport only: Hermes writes text, Jev chooses indexed operations. */
export function createLiveBrowserless(
  cfg: ProviderConfig,
  connectOverCDP: typeof chromium.connectOverCDP = chromium.connectOverCDP.bind(chromium),
  credentialStore: CredentialStore = credentials,
): BrowserAdapter {
  const endpoint = new URL(cfg.baseUrl ?? 'https://production-sfo.browserless.io');
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'BROWSERLESS_BASE_URL must be a provider origin/path without credentials or query parameters.',
    );
  }
  const destination =
    (endpoint.protocol === 'ws:'
      ? 'http:'
      : endpoint.protocol === 'wss:'
        ? 'https:'
        : endpoint.protocol) +
    '//' +
    endpoint.host;
  const viewers = new Map<Page, { cdp: CDPSession; id?: string }>();
  const activeBrowsers = new Map<string, Set<import('playwright-core').Browser>>();
  credentialStore.onInvalidate((reference) => {
    const owned = activeBrowsers.get(reference);
    if (!owned) return;
    activeBrowsers.delete(reference);
    for (const browser of owned) void browser.close().catch(() => undefined);
  });

  async function revokePage(page: Page): Promise<void> {
    const current = viewers.get(page);
    if (!current?.id) return;
    const response = (await current.cdp.send(
      'Browserless.closeLiveURL' as never,
      { liveURLId: current.id } as never,
    )) as { error?: string | null; liveURLId?: string };
    if (response.error !== null || response.liveURLId !== current.id)
      throw new Error('Browserless did not confirm viewer revocation. Session remains paused.');
    current.id = undefined;
  }

  async function revoke(page: Page): Promise<void> {
    // A human can open a popup: the engine's active page may have changed while
    // the interactive link still targets its original page. Revoke every grant
    // in this session's context before any agent action can resume.
    for (const candidate of viewers.keys()) {
      if (candidate.context() === page.context()) await revokePage(candidate);
    }
  }

  async function closeUnknownGrant(page: Page): Promise<void> {
    for (const owned of activeBrowsers.values())
      for (const browser of owned) {
        if (browser.contexts().includes(page.context())) await browser.close();
      }
  }

  return createLiveLocalBrowser(cfg, {
    backend: 'browserless',
    destination,
    async connect(ctx) {
      const credential = await credentialStore.require({
        runId: ctx.runId,
        providerId: 'browserless',
        purpose: 'browser',
      });
      const url = new URL(endpoint);
      url.protocol = endpoint.protocol === 'http:' || endpoint.protocol === 'ws:' ? 'ws:' : 'wss:';
      if (url.pathname === '/') url.pathname = '/chromium';
      url.searchParams.set('token', credential.secret);
      url.searchParams.set('timeout', String(config.browser.sessionTimeoutMs));
      let browser: import('playwright-core').Browser;
      try {
        browser = await connectOverCDP(url.toString(), { timeout: config.browser.timeoutMs });
      } catch (error) {
        throw new Error(
          'Browserless connection failed: ' + browserFailure(error, [credential.secret]),
        );
      }
      const owned = activeBrowsers.get(credential.reference) ?? new Set();
      activeBrowsers.set(credential.reference, owned);
      owned.add(browser);
      let ownedContexts = browser.contexts();
      browser.on?.('disconnected', () => {
        for (const page of viewers.keys())
          if (ownedContexts.includes(page.context())) viewers.delete(page);
        owned.delete(browser);
        if (!owned.size) activeBrowsers.delete(credential.reference);
      });
      try {
        const context = browser.contexts()[0] ?? (await browser.newContext());
        ownedContexts = browser.contexts();
        const page = context.pages()[0] ?? (await context.newPage());
        return { browser, page, credentialRef: credential.reference };
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
    validate(reference, ctx) {
      if (!reference) throw new Error('Browser credential binding missing.');
      credentialStore.assertCurrent(reference, {
        runId: ctx.runId,
        providerId: 'browserless',
        purpose: 'browser',
      });
    },
    async viewer(page, mode) {
      await revoke(page);
      const current = viewers.get(page) ?? { cdp: await page.context().newCDPSession(page) };
      viewers.set(page, current);
      let response: {
        error?: string | null;
        liveURL?: string;
        liveURLId?: string;
        timeout?: number;
      };
      try {
        response = (await current.cdp.send(
          'Browserless.liveURL' as never,
          {
            interactable: mode === 'control',
            resizable: false,
            showBrowserInterface: false,
            quality: 65,
            timeout: config.browser.viewerTimeoutMs,
          } as never,
        )) as typeof response;
      } catch {
        await closeUnknownGrant(page).catch(() => undefined);
        throw new Error(
          'Browserless viewer creation was not confirmed; session closed to prevent an unknown control grant.',
        );
      }
      if (response.liveURLId) current.id = response.liveURLId;
      if (response.error || !response.liveURL || !response.liveURLId) {
        if (current.id) await revoke(page);
        else await closeUnknownGrant(page);
        throw new Error('Browserless live viewer unavailable for this session/account.');
      }
      let view: URL;
      try {
        view = new URL(response.liveURL);
      } catch {
        await revoke(page);
        throw new Error('Browserless returned an invalid viewer URL.');
      }
      if (
        view.origin !== destination ||
        view.protocol !== 'https:' ||
        view.username ||
        view.password ||
        view.search ||
        view.hash
      ) {
        await revoke(page);
        throw new Error('Browserless returned an unsafe viewer URL.');
      }
      return {
        kind: 'iframe',
        liveViewUrl: view.toString(),
        interactive: mode === 'control',
        expiresAt: new Date(
          Date.now() + (response.timeout ?? config.browser.viewerTimeoutMs),
        ).toISOString(),
      };
    },
    revoke,
  });
}
