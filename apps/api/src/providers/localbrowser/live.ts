/**
 * Local browser — LIVE ADAPTER, real Chrome via playwright-core.
 *
 * ============================================================================
 * WHY THIS EXISTS: Browserbase is a remote data recipient. Anything typed into
 * a page there has left the machine — inputs, screenshots and cookies alike.
 * This adapter is the destination policy names when a step carries `local_only`
 * context or `secret` data. It reports `local://chromium`, and that ledger row
 * is the proof.
 *
 * `playwright-core` SHIPS NO BROWSER BINARIES. It is a driver, not a browser.
 * So we launch an INSTALLED Chrome by channel (`LOCALBROWSER_CHANNEL=chrome`)
 * rather than a downloaded one. With no channel configured, config.ts has
 * already downgraded this provider to mock — this file is never reached.
 *
 * THE ELEMENT TABLE (3B-4) IS BUILT HERE, and this is the only place element
 * HANDLES exist. `ElementTable` carries integers and labels; the `Locator`s
 * behind them live in the closure below and never cross a function boundary
 * that leaves this process. Jev says "7"; this file knows what 7 is.
 *
 * THREE CHECKS BEFORE ANY OPERATION, because a snapshot is already stale by the
 * time a decision comes back, and this is exactly where browser agents get
 * flaky:
 *   1. FRESHNESS  — the snapshotId must still be the session's current one.
 *   2. ATTACHED + INTERACTABLE — the element is still in the DOM, visible, enabled.
 *   3. OCCLUSION  — what is actually at the element's centre point is the
 *      element (or a descendant), not a modal or a cookie banner on top of it.
 * All three refuse rather than act. A refusal is a normal outcome: re-snapshot
 * and re-decide.
 *
 * VENDOR TYPES DO NOT ESCAPE THIS FILE — `Browser`, `Page` and `Locator` appear
 * nowhere in our return types. That is the rule that keeps the adapter swappable.
 * ============================================================================
 */

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type {
  BrowserAdapter,
  BrowserBackend,
  BrowserViewer,
  BrowserHumanInput,
  BrowserPerformResult,
  ElementRow,
  ElementTable,
  ProviderCallContext,
  ProviderResult,
  TargetRejection,
} from '@htn/shared';
import { LOCAL_BROWSER_DESTINATION, needsTarget } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';
import { browserLocation, browserFailure } from '../browserSafety.js';
import {
  COLLECT_ROWS,
  INTERACTIVE_SELECTOR,
  NON_TEXT_INPUT,
  inferRole,
  rejectionFor,
  truncate,
  validateTargetScript,
  type RawRow,
  type TargetState,
} from '../browserPage.js';
import { notifyBrowserSessionClosed } from '../withBrowserOwnership.js';

interface Snapshot {
  id: string;
  table: ElementTable;
  /** index -> live handle. THE thing that never leaves this file. */
  handles: Map<number, Locator>;
  /** index -> position in the page's own query order, for the occlusion probe. */
  domIndices: Map<number, number>;
}

interface Handle {
  browser: Browser;
  page: Page;
  snapshot?: Snapshot;
  credentialRef?: string;
}

export interface BrowserTransport {
  backend: BrowserBackend;
  destination: string;
  connect(
    ctx: ProviderCallContext,
  ): Promise<{ browser: Browser; page: Page; credentialRef?: string }>;
  validate?(credentialRef: string | undefined, ctx: ProviderCallContext): void;
  viewer?(
    page: Page,
    mode: 'watch' | 'control',
    ctx: ProviderCallContext,
  ): Promise<Partial<BrowserViewer>>;
  revoke?(page: Page): Promise<void>;
}

/** Shared Playwright execution engine for local Chrome and cloud CDP sessions. */
export function createLiveLocalBrowser(
  cfg: ProviderConfig,
  transport?: BrowserTransport,
): BrowserAdapter {
  const backend = transport?.backend ?? 'localbrowser';
  const destination = transport?.destination ?? LOCAL_BROWSER_DESTINATION;
  const sessions = new Map<string, Handle>();
  function meta(op: string, started: number, destination: string | null) {
    return {
      provider: backend,
      op,
      mode: 'live' as const,
      latencyMs: Date.now() - started,
      destination,
    };
  }

  function failure<T>(
    op: string,
    started: number,
    err: unknown,
    code: 'UPSTREAM' | 'BAD_INPUT' | 'TIMEOUT' = 'UPSTREAM',
  ): ProviderResult<T> {
    return {
      ok: false,
      error: {
        code,
        message: browserFailure(err),
        retryable: code !== 'BAD_INPUT',
      },
      meta: meta(op, started, destination),
    };
  }

  function rejected<T>(op: string, started: number, reason: TargetRejection): ProviderResult<T> {
    return {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: reason,
        // A stale snapshot is worth retrying after a re-snapshot; a wrong
        // operation for the element's role is not.
        retryable: reason === 'stale_snapshot' || reason === 'occluded',
      },
      meta: meta(op, started, destination),
    };
  }

  /** Shared by openSession — concurrency is money on one backend and RAM on this one. */
  function atCapacity(): boolean {
    return sessions.size >= config.browser.maxSessions;
  }

  async function buildTable(
    handle: Handle,
    sessionId: string,
    maxElements: number,
  ): Promise<Snapshot> {
    const all = handle.page.locator(INTERACTIVE_SELECTOR);
    const raw = (await handle.page.evaluate<RawRow[], undefined>(COLLECT_ROWS, undefined)) ?? [];

    // A hidden element is not a candidate: it would bloat the table and invite
    // a decision to pick something unclickable.
    const visible = raw.filter((r) => r.visible);

    const rows: ElementRow[] = [];
    const handles = new Map<number, Locator>();
    const domIndices = new Map<number, number>();

    for (const item of visible.slice(0, maxElements)) {
      const resolvedRole = item.role ?? inferRole(item.tag, item.type);
      const editable =
        resolvedRole === 'textbox' ||
        item.tag === 'textarea' ||
        (item.tag === 'input' && !NON_TEXT_INPUT.has(item.type ?? 'text'));
      const selectable = resolvedRole === 'combobox' || item.tag === 'select';

      const index = rows.length + 1;
      rows.push({
        index,
        role: resolvedRole,
        label: truncate(item.name),
        ...(item.value ? { value: truncate(item.value, 40) } : {}),
        clickable: true,
        editable,
        selectable,
      });
      // The handle, keyed by the index the decision will return. `nth` resolves
      // in document order, the same order querySelectorAll produced above.
      handles.set(index, all.nth(item.domIndex));
      domIndices.set(index, item.domIndex);
    }

    const id = 'snap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    return {
      id,
      handles,
      domIndices,
      table: {
        snapshotId: id,
        sessionId,
        url: browserLocation(handle.page.url()),
        title: await handle.page.title().catch(() => ''),
        capturedAt: new Date().toISOString(),
        rows,
        truncated: rows.length < visible.length,
        totalInteractive: visible.length,
      },
    };
  }

  return {
    id: backend,
    mode: 'live',
    capabilities: backend === 'localbrowser' ? ['browser.local'] : ['browser'],

    async health() {
      const started = Date.now();
      if (!transport && !cfg.channel) {
        return {
          ok: false,
          error: {
            code: 'AUTH',
            message:
              'LOCALBROWSER_CHANNEL is not set. playwright-core ships no browser binaries; ' +
              'set it to an installed channel such as "chrome".',
            retryable: false,
          },
          meta: meta('health', started, null),
        };
      }
      return {
        ok: true,
        data: { detail: 'live ' + backend + ', sessions=' + sessions.size },
        meta: meta('health', started, destination),
      };
    },

    async invoke(op) {
      return failure(
        op,
        Date.now(),
        new Error('No generic invoke() op is defined for localbrowser.'),
        'BAD_INPUT',
      );
    },

    async openSession(input, ctx: ProviderCallContext) {
      const started = Date.now();
      if (atCapacity()) {
        return failure(
          'openSession',
          started,
          new Error(
            'BROWSER_MAX_SESSIONS=' + config.browser.maxSessions + ' reached for localbrowser',
          ),
          'BAD_INPUT',
        );
      }

      let browser: Browser | undefined;
      try {
        const connected = transport ? await transport.connect(ctx) : undefined;
        browser =
          connected?.browser ??
          (await chromium.launch({
            channel: cfg.channel,
            headless: cfg.headless ?? true,
            timeout: config.browser.timeoutMs,
          }));
        const page = connected?.page ?? (await browser.newPage());
        await page.setViewportSize({ width: 1280, height: 720 });
        page.setDefaultTimeout(config.browser.timeoutMs);

        if (input.startUrl) {
          await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' });
        }

        const sessionId = backend + '_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, { browser, page, credentialRef: connected?.credentialRef });
        browser.on?.('disconnected', () => {
          sessions.delete(sessionId);
          notifyBrowserSessionClosed(sessionId);
        });
        page.context().on('page', (newPage) => {
          const handle = sessions.get(sessionId);
          if (handle) {
            handle.page = newPage;
            handle.snapshot = undefined;
          }
        });

        // No live view URL: the browser is on this machine. Reporting a fake
        // one would break the truthful-labeling acceptance criterion.
        return {
          ok: true as const,
          data: { sessionId, interactive: true },
          meta: meta('openSession', started, destination),
        };
      } catch (err) {
        // A half-launched browser is a leaked Chrome process. Close it here —
        // there is no session id yet, so nothing else can ever close it.
        await browser?.close().catch(() => {});
        return failure('openSession', started, err);
      }
    },

    async act(input, ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      transport?.validate?.(handle?.credentialRef, ctx);
      if (!handle) {
        return failure('act', started, new Error('Unknown sessionId'), 'BAD_INPUT');
      }
      try {
        // Deliberately NOT natural language: this adapter has no LLM. A plain
        // URL navigates; anything else is the Jev-driven `perform` path's job.
        if (/^https?:\/\//i.test(input.instruction)) {
          await handle.page.goto(input.instruction, { waitUntil: 'domcontentloaded' });
        } else {
          return failure(
            'act',
            started,
            new Error(
              'localbrowser.act takes a URL. For element-level actions use snapshot() + ' +
                'perform(), which is the Jev-driven path.',
            ),
            'BAD_INPUT',
          );
        }
        // Any navigation invalidates the snapshot the caller may hold.
        handle.snapshot = undefined;
        return {
          ok: true as const,
          data: { url: browserLocation(handle.page.url()) },
          meta: meta('act', started, destination),
        };
      } catch (err) {
        return failure('act', started, err);
      }
    },

    async navigate(input, ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      transport?.validate?.(handle?.credentialRef, ctx);
      if (!handle) {
        return failure('navigate', started, new Error('Unknown sessionId'), 'BAD_INPUT');
      }
      try {
        handle.snapshot = undefined;
        await handle.page.goto(input.url, { waitUntil: 'domcontentloaded' });
        return {
          ok: true as const,
          data: { url: browserLocation(handle.page.url()) },
          meta: meta('navigate', started, destination),
        };
      } catch (err) {
        return failure('navigate', started, err);
      }
    },

    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      ctx: ProviderCallContext,
    ) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      transport?.validate?.(handle?.credentialRef, ctx);
      if (!handle) {
        return failure<T>('extract', started, new Error('Unknown sessionId'), 'BAD_INPUT');
      }
      try {
        // Deterministic text extraction, no model. `instruction` is an optional
        // CSS scope; empty means the whole body.
        const scope = input.instruction.trim();
        const text = scope
          ? // Short wait: a scope that is absent (no <main>) should fall back
            // fast, not hold the tool for Playwright's 30s default.
            await handle.page.locator(scope).first().innerText({ timeout: 2_000 })
          : await handle.page.locator('body').innerText();
        return {
          ok: true as const,
          data: {
            url: browserLocation(handle.page.url()),
            title: await handle.page.title().catch(() => ''),
            text: truncate(text, 4000),
          } as T,
          meta: meta('extract', started, destination),
        };
      } catch (err) {
        return failure<T>('extract', started, err);
      }
    },

    async snapshot(input, ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      transport?.validate?.(handle?.credentialRef, ctx);
      if (!handle) {
        return failure<ElementTable>(
          'snapshot',
          started,
          new Error('Unknown sessionId'),
          'BAD_INPUT',
        );
      }
      try {
        const snap = await buildTable(
          handle,
          input.sessionId,
          input.maxElements ?? config.browser.maxElements,
        );
        handle.snapshot = snap;
        return {
          ok: true as const,
          data: snap.table,
          meta: meta('snapshot', started, destination),
        };
      } catch (err) {
        return failure<ElementTable>('snapshot', started, err);
      }
    },

    async perform(input, ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      transport?.validate?.(handle?.credentialRef, ctx);
      if (!handle) {
        return failure<BrowserPerformResult>(
          'perform',
          started,
          new Error('Unknown sessionId'),
          'BAD_INPUT',
        );
      }

      /* -- Untargeted operations first: no index, no freshness question. ---- */
      if (!needsTarget(input.operation)) {
        try {
          if (input.operation === 'SCROLL_DOWN') {
            await handle.page.mouse.wheel(0, 600);
          } else if (input.operation === 'SCROLL_UP') {
            await handle.page.mouse.wheel(0, -600);
          } else if (input.operation === 'WAIT') {
            await handle.page.waitForTimeout(500);
          }
          // DONE / BLOCKED touch the browser at all — they are the loop's
          // terminal signals, recorded and returned unchanged.
          handle.snapshot = undefined;
          return {
            ok: true as const,
            data: {
              operation: input.operation,
              url: browserLocation(handle.page.url()),
              navigated: false,
            },
            meta: meta('perform', started, destination),
          };
        } catch (err) {
          return failure<BrowserPerformResult>('perform', started, err);
        }
      }

      /* -- 1. FRESHNESS. ---------------------------------------------------- */
      const snap = handle.snapshot;
      if (!snap || snap.id !== input.snapshotId) {
        return rejected<BrowserPerformResult>('perform', started, 'stale_snapshot');
      }

      if (input.index === undefined) {
        return rejected<BrowserPerformResult>('perform', started, 'wrong_operation');
      }

      const locator = snap.handles.get(input.index);
      const row = snap.table.rows.find((r) => r.index === input.index);
      if (!locator || !row) {
        return rejected<BrowserPerformResult>('perform', started, 'unknown_index');
      }

      // The operation must match what the row actually is. Jev was offered only
      // eligible indices per operation, but the gate does not assume that.
      const eligible =
        input.operation === 'CLICK'
          ? row.clickable
          : input.operation === 'TYPE_TEXT'
            ? row.editable
            : row.selectable;
      if (!eligible) {
        return rejected<BrowserPerformResult>('perform', started, 'wrong_operation');
      }

      try {
        /* -- 2 AND 3, IN ONE ROUND TRIP: attached, interactable, occluded. -- */
        const domIndex = snap.domIndices.get(input.index);
        if (domIndex === undefined) {
          return rejected<BrowserPerformResult>('perform', started, 'unknown_index');
        }

        const state = await handle.page
          .evaluate<TargetState | null, undefined>(
            validateTargetScript(domIndex, { label: row.label, role: row.role }),
            undefined,
          )
          .catch(() => null);

        const rejection = rejectionFor(state);
        if (rejection) return rejected<BrowserPerformResult>('perform', started, rejection);

        const urlBefore = handle.page.url();

        if (input.operation === 'CLICK') {
          await locator.click({ timeout: config.browser.actionTimeoutMs });
        } else if (input.operation === 'TYPE_TEXT') {
          // Jev picked the FIELD. `text` came from a generative model, never
          // from Jev — Jev cannot produce text at all.
          await locator.fill(input.text ?? '', { timeout: config.browser.actionTimeoutMs });
        } else {
          await locator.selectOption(input.text ?? '', { timeout: config.browser.actionTimeoutMs });
        }

        // Let the page settle before anyone snapshots it again. A combobox
        // needs longer than a click because its suggestions render async;
        // these are jev-ultrafast's numbers (~200ms / ~50ms), not a guess.
        await handle.page.waitForTimeout(
          input.operation === 'SELECT' ? config.browser.settleSelectMs : config.browser.settleMs,
        );

        const url = handle.page.url();
        // Whatever just happened, the table we decided against is now suspect.
        handle.snapshot = undefined;

        return {
          ok: true as const,
          data: {
            operation: input.operation,
            index: input.index,
            url: browserLocation(url),
            navigated: url !== urlBefore,
          },
          meta: meta('perform', started, destination),
        };
      } catch (err) {
        return failure<BrowserPerformResult>('perform', started, err);
      }
    },

    async viewer(input, ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) return failure('viewer', started, new Error('Unknown sessionId'), 'BAD_INPUT');
      transport?.validate?.(handle.credentialRef, ctx);
      try {
        const supplied = transport?.viewer
          ? await transport.viewer(handle.page, input.mode, ctx)
          : {};
        return {
          ok: true as const,
          data: {
            providerId: backend,
            mode: 'live' as const,
            kind: 'stream' as const,
            owner: 'agent' as const,
            revision: 0,
            phase: 'agent_running' as const,
            pageUrl: browserLocation(handle.page.url()),
            canWatch: true,
            canControl: true,
            interactive: input.mode === 'control',
            width: 1280,
            height: 720,
            ...supplied,
          },
          meta: meta('viewer', started, destination),
        };
      } catch (err) {
        return failure('viewer', started, err);
      }
    },
    async liveView(sessionId, ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure('liveView', Date.now(), new Error('Unknown sessionId'), 'BAD_INPUT');
      transport?.validate?.(handle.credentialRef, ctx);
      return {
        ok: true as const,
        data: { pageUrl: browserLocation(handle.page.url()), interactive: true },
        meta: meta('liveView', Date.now(), destination),
      };
    },
    async captureFrame(sessionId, ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure('captureFrame', Date.now(), new Error('Unknown sessionId'), 'BAD_INPUT');
      transport?.validate?.(handle.credentialRef, ctx);
      try {
        const bytes = await handle.page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
        return {
          ok: true as const,
          data: { bytes, width: 1280, height: 720 },
          meta: meta('captureFrame', Date.now(), destination),
        };
      } catch (err) {
        return failure('captureFrame', Date.now(), err);
      }
    },
    async humanInput(input, ctx) {
      const handle = sessions.get(input.sessionId);
      if (!handle)
        return failure('humanInput', Date.now(), new Error('Unknown sessionId'), 'BAD_INPUT');
      transport?.validate?.(handle.credentialRef, ctx);
      try {
        const entry = input.input;
        if (entry.type === 'click') await handle.page.mouse.click(entry.x, entry.y);
        else if (entry.type === 'key') await handle.page.keyboard.press(entry.key);
        else if (entry.type === 'text') await handle.page.keyboard.insertText(entry.text);
        else await handle.page.mouse.wheel(entry.deltaX, entry.deltaY);
        handle.snapshot = undefined;
        return { ok: true as const, data: null, meta: meta('humanInput', Date.now(), destination) };
      } catch (err) {
        return failure('humanInput', Date.now(), err);
      }
    },
    async revokeControl(sessionId, _ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure('revokeControl', Date.now(), new Error('Unknown sessionId'), 'BAD_INPUT');
      try {
        await transport?.revoke?.(handle.page);
        return {
          ok: true as const,
          data: null,
          meta: meta('revokeControl', Date.now(), destination),
        };
      } catch (err) {
        return failure('revokeControl', Date.now(), err);
      }
    },
    async invalidateSnapshot(sessionId, _ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure(
          'invalidateSnapshot',
          Date.now(),
          new Error('Unknown sessionId'),
          'BAD_INPUT',
        );
      handle.snapshot = undefined;
      return {
        ok: true as const,
        data: null,
        meta: meta('invalidateSnapshot', Date.now(), destination),
      };
    },

    async closeSession(sessionId, _ctx) {
      const started = Date.now();
      const handle = sessions.get(sessionId);
      // Idempotent: closing an already-closed session is a success, so a
      // `finally` block can call this unconditionally without swallowing the
      // real error that sent it there.
      if (!handle) {
        return { ok: true as const, data: null, meta: meta('closeSession', started, null) };
      }
      // Delete FIRST. If close() throws we must still free the slot, or a
      // wedged browser permanently consumes BROWSER_MAX_SESSIONS.
      sessions.delete(sessionId);
      try {
        await handle.browser.close();
        return {
          ok: true as const,
          data: null,
          meta: meta('closeSession', started, destination),
        };
      } catch (err) {
        return failure('closeSession', started, err);
      }
    },
  };
}
