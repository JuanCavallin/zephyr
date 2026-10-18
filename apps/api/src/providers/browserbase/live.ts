/**
 * Browserbase — cloud browser automation. LIVE ADAPTER via Stagehand v4.
 *
 * ============================================================================
 * PRIVACY NOTE — DO NOT BREAK THIS: this browser runs in Browserbase's cloud.
 * Anything typed into a page here HAS LEFT THE MACHINE — inputs, screenshots
 * and cookies alike. The rule is encoded in the descriptors
 * (core/tools/browserDescriptors.ts): no Browserbase descriptor allows
 * `local_only` context or `secret` data, so a sensitive step never sees this
 * backend as a candidate. If a sensitive value must be TYPED into a form, that
 * is the local Playwright adapter's job, not this one's.
 *
 * VERIFIED AGAINST @browserbasehq/stagehand@4.1.0's own .d.ts (not docs, not
 * memory). Re-check against dist/index.d.mts if the version moves.
 *
 * ---------------------------------------------------------------------------
 * THE `model` OPTION IS OPTIONAL, AND OMITTING IT IS THE WHOLE FIX.
 *
 * This adapter used to pass `model: { apiKey: config...anthropic.apiKey, ... }`
 * unconditionally. With no ANTHROPIC_API_KEY that object is present but empty,
 * which fails the SDK's own `min(1)` validation, so `openSession` died with a
 * raw zod dump and NOTHING worked — verified live, that was this repo's state.
 *
 * Two things had to be true at once:
 *   - Stagehand MUST be attached before `browser.context` is usable at all.
 *     Skipping it raises "Browser context is unavailable". So it cannot be
 *     created lazily.
 *   - `model` is `z.ZodOptional`. Leaving the key OUT entirely is valid.
 *
 * So Stagehand is created eagerly, without a model unless we have one:
 *
 *   openSession / snapshot / perform / closeSession  -> Browserbase creds only
 *   act / extract (natural language)                 -> also need an LLM key
 *
 * The element-level path — the one the Jev design actually depends on —
 * therefore works with the credentials we have. Verified live.
 * ---------------------------------------------------------------------------
 *
 * FACTS ESTABLISHED AGAINST THE LIVE API — do not re-derive:
 *   - Project concurrency limit is 25. BROWSER_MAX_SESSIONS defaults to 2.
 *   - The session replay/recording API is DEPRECATED and returns 404. Do not
 *     plan on it as demo evidence; use the live-view URL plus our own trace.
 *   - The live-view URL returns 410 GONE once the session stops. Capture it
 *     while the session is open — it cannot be fetched afterwards.
 *   - Egress is region-specific (connect.usw2.browserbase.com, not the generic
 *     host), and approvals bind to a destination, so bind to the per-session
 *     value where we can learn it.
 *   - REQUEST_RELEASE works; sessions reach COMPLETED. Release on every exit
 *     path or you burn a slot and money.
 * ============================================================================
 */

import { browserbase, Stagehand, type StagehandBrowser } from '@browserbasehq/stagehand';
import type {
  BrowserAdapter,
  BrowserViewer,
  BrowserPerformResult,
  ElementRow,
  ElementTable,
  ProviderCallContext,
  ProviderResult,
  TargetRejection,
} from '@htn/shared';
import { BROWSERBASE_API_DESTINATION, needsTarget } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';
import { browserLocation, browserFailure } from '../browserSafety.js';
import {
  COLLECT_ROWS,
  INTERACTIVE_SELECTOR,
  NON_TEXT_INPUT,
  inferRole,
  truncate,
  rejectionFor,
  validateTargetScript,
  type RawRow,
  type TargetState,
} from '../browserPage.js';
import { notifyBrowserSessionClosed } from '../withBrowserOwnership.js';

import { credentials, type ResolvedCredential } from '../../services/credentials.js';

/**
 * The live-view URL comes from Browserbase's REST API, called directly.
 *
 * This USED to go through `@browserbasehq/sdk` via a variable specifier, so the
 * file would still compile without it. The catch was that the package is only a
 * transitive dependency under pnpm's strict layout, so the import never
 * resolved, the URL was always `undefined`, and a live session reported no live
 * view at all -- silently, because the whole path was written to degrade
 * quietly. Measured against a real Browserbase run: `interactive: false`, no URL.
 *
 * Two plain `fetch` calls do the same job with NO new dependency, which also
 * keeps this off the "only the dependency owner adds packages" path and out of
 * the hour-30 freeze. If the SDK is ever added for other reasons, this can go
 * back to using it -- the shape returned here is the contract, not the transport.
 */
const BROWSERBASE_API = 'https://api.browserbase.com/v1';

interface Snapshot {
  id: string;
  table: ElementTable;
  domIndices: Map<number, number>;
}

interface Handle {
  browser: StagehandBrowser;
  /** Attached at openSession; has a model only when an LLM key exists. */
  stagehand?: Stagehand;
  /** The real Browserbase session id, for the live-view URL. */
  remoteSessionId?: string;
  /** Where the session was pointed, so liveView can re-pick the right tab. */
  startUrl?: string;
  /** Region-specific where known; approvals bind to this. */
  destination: string;
  credential: ResolvedCredential;
  runId: string;
  snapshot?: Snapshot;
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'browserbase' as const,
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
  destination: string | null = BROWSERBASE_API_DESTINATION,
  code: 'UPSTREAM' | 'BAD_INPUT' | 'AUTH' = 'UPSTREAM',
): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code,
      message: browserFailure(err),
      retryable: code === 'UPSTREAM',
    },
    meta: meta(op, started, destination),
  };
}

function rejected<T>(
  op: string,
  started: number,
  reason: TargetRejection,
  destination: string,
): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'BAD_INPUT',
      message: reason,
      retryable: reason === 'stale_snapshot' || reason === 'occluded',
    },
    meta: meta(op, started, destination),
  };
}

/** One Browserbase REST GET. Returns null rather than throwing -- see liveViewUrl. */
async function bbGet<T>(apiKey: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(BROWSERBASE_API + path, {
      headers: { 'X-BB-API-Key': apiKey },
      // Generous but bounded: this runs inside openSession, and a hung metadata
      // call must not hold up a session the caller is waiting on.
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Why Browserbase refused a session. Stagehand catches the API error and
 * rethrows a bare "Failed to create a Browserbase session", which hid a 402
 * "Free plan browser minutes limit reached" for a whole debugging session.
 * Runs ONLY after a failed create: a refused create costs nothing, and the
 * rare one that now succeeds (a transient failure) is released at once.
 */
async function explainCreateFailure(apiKey: string, projectId: string): Promise<string | null> {
  try {
    const res = await fetch(BROWSERBASE_API + '/sessions', {
      method: 'POST',
      headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (res.ok) {
      if (body.id) {
        await fetch(BROWSERBASE_API + '/sessions/' + body.id, {
          method: 'POST',
          headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
          signal: AbortSignal.timeout(8_000),
        }).catch(() => undefined);
      }
      return 'transient; a retry may succeed';
    }
    return 'Browserbase HTTP ' + res.status + (body.message ? ': ' + body.message : '');
  } catch {
    return null;
  }
}

/**
 * The live-view URL and the session's region.
 *
 * BEST EFFORT BY DESIGN: a missing URL costs the UI a live view, while a thrown
 * error would cost the run its session. Every failure path here returns
 * partial data rather than raising -- that is deliberate, not sloppy.
 *
 * `debuggerFullscreenUrl` is the INTERACTIVE debug view: a person can click and
 * type in it. That is what `interactive: true` promises downstream and what
 * makes a `handoff` node possible, so it is the only field allowed to set it.
 *
 * MUST BE CALLED WHILE THE SESSION IS RUNNING. `/debug` returns 410 Gone once a
 * session stops, so there is no second chance at this after the fact.
 */
interface DebugPage {
  id?: string;
  url?: string;
  debuggerFullscreenUrl?: string;
}

interface DebugResponse {
  debuggerFullscreenUrl?: string;
  pages?: DebugPage[];
}

/** Trailing-slash-insensitive, so "https://x.com" matches "https://x.com/". */
function sameUrl(a: string, b: string): boolean {
  const trim = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  return trim(a) === trim(b);
}

/**
 * WHICH TAB the live view should show.
 *
 * The top-level `debuggerFullscreenUrl` points at the session's FIRST page,
 * and that was the wrong one when openSession called `context.newPage(startUrl)`,
 * which left page 0 on about:blank and put the real page second. openSession
 * now navigates page 0 instead, but a site can still open popups or new tabs,
 * so the selection stays. Measured on a live session -- page 0
 * `about:blank`, page 1 `https://example.com/` -- so someone following the
 * handoff link landed on a blank tab and had no idea why.
 *
 * Preference order: the page matching the start URL, then the last page that
 * is not blank, then whatever the top level said. The last fallback means this
 * can only improve on the old behaviour, never do worse than it.
 */
function pickPage(debug: DebugResponse, startUrl?: string): { url?: string; pageUrl?: string } {
  const pages = (debug.pages ?? []).filter((page) => page.debuggerFullscreenUrl);

  if (startUrl) {
    const exact = pages.find((page) => page.url && sameUrl(page.url, startUrl));
    if (exact) return { url: exact.debuggerFullscreenUrl, pageUrl: exact.url };
  }

  const real = [...pages].reverse().find((page) => page.url && page.url !== 'about:blank');
  if (real) return { url: real.debuggerFullscreenUrl, pageUrl: real.url };

  // Nothing but blank pages. Returning the blank one is still correct -- there
  // is genuinely nothing else to show -- but `pageUrl` reports that honestly so
  // the caller can say "no page is loaded" instead of handing over a white box.
  const fallback = pages[0];
  return {
    ...((fallback?.debuggerFullscreenUrl ?? debug.debuggerFullscreenUrl)
      ? { url: fallback?.debuggerFullscreenUrl ?? debug.debuggerFullscreenUrl }
      : {}),
    ...(fallback?.url ? { pageUrl: fallback.url } : {}),
  };
}

async function liveViewUrl(
  apiKey: string,
  sessionId: string,
  startUrl?: string,
): Promise<{ url?: string; pageUrl?: string; region?: string }> {
  const [debug, session] = await Promise.all([
    bbGet<DebugResponse>(apiKey, '/sessions/' + sessionId + '/debug'),
    bbGet<{ region?: string }>(apiKey, '/sessions/' + sessionId),
  ]);

  const picked = debug ? pickPage(debug, startUrl) : {};

  return {
    ...(picked.url ? { url: picked.url } : {}),
    ...(picked.pageUrl ? { pageUrl: picked.pageUrl } : {}),
    ...(session?.region ? { region: session.region } : {}),
  };
}

export function createLiveBrowserbase(cfg: ProviderConfig): BrowserAdapter {
  const sessions = new Map<string, Handle>();
  credentials.onInvalidate((reference, providerId) => {
    if (providerId !== 'browserbase') return;
    for (const [sessionId, handle] of sessions) {
      if (handle.credential.reference !== reference) continue;
      sessions.delete(sessionId);
      notifyBrowserSessionClosed(sessionId);
      void handle.browser.close().catch(() => undefined);
    }
  });

  /**
   * `model` is OPTIONAL on Stagehand.create, and that one fact is what makes
   * the element path usable with Browserbase credentials alone.
   *
   * The original bug was passing `model: { apiKey: config...anthropic.apiKey }`
   * with an empty key: an explicitly-present model object fails the SDK's
   * `min(1)` validation and openSession died with a raw zod dump. OMITTING the
   * key entirely is valid — Stagehand attaches, the browser works, and only
   * act()/extract() later complain about having no model.
   *
   * Verified live against a real Browserbase session with no LLM key set.
   */
  // Return type inferred on purpose: the SDK's `modelName` is a literal union,
  // and annotating it as `string` widens it and stops compiling.
  function modelOptions() {
    const llmKey = config.providers.anthropic.apiKey;
    return llmKey
      ? { model: { apiKey: llmKey, modelName: 'anthropic/claude-sonnet-5' as const } }
      : {};
  }

  /** act()/extract() are the only operations that genuinely need a model. */
  function requireModel(): void {
    if (!config.providers.anthropic.apiKey) {
      throw new Error(
        'Stagehand resolves natural-language act()/extract() with a model, so this needs ' +
          'ANTHROPIC_API_KEY in the root .env. Browserbase credentials alone are enough for ' +
          'openSession/snapshot/perform/closeSession — use the element-level path instead.',
      );
    }
  }

  async function activePage(handle: Handle) {
    credentials.assertCurrent(handle.credential.reference, {
      runId: handle.runId,
      providerId: 'browserbase',
      purpose: 'browser',
    });
    const page =
      (await handle.browser.context.activePage()) ?? (await handle.browser.context.newPage());
    await page.setViewportSize(1280, 720);
    return page;
  }

  async function buildTable(
    handle: Handle,
    sessionId: string,
    maxElements: number,
  ): Promise<Snapshot> {
    const page = await activePage(handle);
    const raw = (await page.evaluate<RawRow[], undefined>(COLLECT_ROWS)) ?? [];
    const visible = raw.filter((r) => r.visible);

    const rows: ElementRow[] = [];
    const domIndices = new Map<number, number>();

    for (const item of visible.slice(0, maxElements)) {
      const role = item.role ?? inferRole(item.tag, item.type);
      const index = rows.length + 1;
      rows.push({
        index,
        role,
        label: truncate(item.name),
        ...(item.value ? { value: truncate(item.value, 40) } : {}),
        clickable: true,
        editable:
          role === 'textbox' ||
          item.tag === 'textarea' ||
          (item.tag === 'input' && !NON_TEXT_INPUT.has(item.type ?? 'text')),
        selectable: role === 'combobox' || item.tag === 'select',
      });
      domIndices.set(index, item.domIndex);
    }

    const id = 'snap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    return {
      id,
      domIndices,
      table: {
        snapshotId: id,
        sessionId,
        url: browserLocation(await page.url()),
        title: await page.title().catch(() => ''),
        capturedAt: new Date().toISOString(),
        rows,
        truncated: rows.length < visible.length,
        totalInteractive: visible.length,
      },
    };
  }

  return {
    id: 'browserbase',
    mode: 'live',
    capabilities: ['browser'],

    async health() {
      const started = Date.now();
      if (config.credentials.browserSource === 'operator' && (!cfg.apiKey || !cfg.projectId)) {
        return {
          ok: false,
          error: {
            code: 'AUTH',
            message: 'Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID',
            retryable: false,
          },
          meta: meta('health', started, null),
        };
      }
      // Truthful labeling: report the degraded capability rather than looking
      // fully healthy and failing on the first act() call.
      const detail = config.providers.anthropic.apiKey
        ? 'live (element path + natural language)'
        : 'live (element path only — ANTHROPIC_API_KEY unset, so act()/extract() will fail)';
      return {
        ok: true,
        data: { detail },
        meta: meta('health', started, BROWSERBASE_API_DESTINATION),
      };
    },

    async invoke(op) {
      return failure(
        op,
        Date.now(),
        new Error('No generic invoke() op is defined for browserbase.'),
        BROWSERBASE_API_DESTINATION,
        'BAD_INPUT',
      );
    },

    async openSession(input, ctx: ProviderCallContext) {
      const started = Date.now();

      if (sessions.size >= config.browser.maxSessions) {
        return failure(
          'openSession',
          started,
          new Error(
            'BROWSER_MAX_SESSIONS=' +
              config.browser.maxSessions +
              ' reached. The project concurrency limit is 25; raise the cap only if the ' +
              'demo genuinely needs parallel browsers.',
          ),
          BROWSERBASE_API_DESTINATION,
          'BAD_INPUT',
        );
      }

      let browser: StagehandBrowser | undefined;
      let stagehand: Stagehand | undefined;
      let credential: ResolvedCredential | undefined;
      try {
        credential = await credentials.require({
          runId: ctx.runId,
          providerId: 'browserbase',
          purpose: 'browser',
        });
        const projectId = credential.metadata?.projectId;
        if (!projectId)
          throw new Error('Browserbase project ID is required with the browser credential.');
        browser = await browserbase.launch({ apiKey: credential.secret, projectId });

        // Stagehand MUST be attached before `browser.context` is usable — the
        // handle alone raises "Browser context is unavailable". So it is
        // created here, but WITHOUT a model unless we have a key. See
        // modelOptions().
        stagehand = await Stagehand.create({ browser, ...modelOptions() });
        const current = await browser.context.activePage();
        if (current) await current.setViewportSize(1280, 720);

        if (input.startUrl) {
          // Navigate the session's existing first tab. newPage(startUrl) left
          // that tab on about:blank and opened a second one, so the live view,
          // the human at a handoff, and the agent could each end up on a
          // different tab.
          const [first] = await browser.context.pages();
          if (first) {
            await first.setViewportSize(1280, 720);
            await first.goto(input.startUrl);
          } else await browser.context.newPage(input.startUrl);
        }

        const remoteSessionId = browser.sessionId;
        // Capture the live-view URL NOW. sessions.debug() returns 410 Gone once
        // the session stops, so there is no second chance at this.
        const view = remoteSessionId
          ? await liveViewUrl(credential.secret, remoteSessionId, input.startUrl)
          : {};

        const destination = view.region
          ? 'https://connect.' + view.region + '.browserbase.com'
          : BROWSERBASE_API_DESTINATION;

        // Our own id, so this adapter's sessionId format stays opaque to
        // callers, consistent with every other provider here.
        const sessionId = 'bb_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, {
          browser,
          stagehand,
          destination,
          credential,
          runId: ctx.runId,
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(input.startUrl ? { startUrl: input.startUrl } : {}),
        });

        return {
          ok: true as const,
          data: {
            sessionId,
            // Input is mediated by AgentOS's owner-checked stream bridge.
            interactive: true,
          },
          meta: meta('openSession', started, destination),
        };
      } catch (err) {
        // A half-launched browser is a RUNNING Browserbase session nobody holds
        // an id for. Release it here or it burns a slot until it times out.
        await browser?.close().catch(() => {});
        if (err instanceof Error && err.name === 'BrowserbaseSessionError') {
          const reason = credential?.metadata?.projectId
            ? await explainCreateFailure(credential.secret, credential.metadata.projectId)
            : undefined;
          if (reason) {
            return failure(
              'openSession',
              started,
              new Error(err.message + ' (' + reason + ')'),
              BROWSERBASE_API_DESTINATION,
              // Quota and auth refusals do not clear on retry.
              /HTTP 40[0-3]/.test(reason) ? 'AUTH' : 'UPSTREAM',
            );
          }
        }
        return failure('openSession', started, err);
      }
    },

    async act(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure('act', started, new Error('Unknown sessionId'), null, 'BAD_INPUT');
      }
      try {
        requireModel();
        if (!handle.stagehand) throw new Error('Stagehand is not attached to this session.');
        await handle.stagehand.act(input.instruction);
        handle.snapshot = undefined;
        const page = await handle.browser.context.activePage();
        return {
          ok: true as const,
          data: { url: browserLocation((await page?.url()) ?? '') },
          meta: meta('act', started, handle.destination),
        };
      } catch (err) {
        return failure('act', started, err, handle.destination);
      }
    },

    async navigate(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure('navigate', started, new Error('Unknown sessionId'), null, 'BAD_INPUT');
      }
      try {
        handle.snapshot = undefined;
        const page = await activePage(handle);
        await page.goto(input.url);
        return {
          ok: true as const,
          data: { url: browserLocation(await page.url()) },
          meta: meta('navigate', started, handle.destination),
        };
      } catch (err) {
        return failure('navigate', started, err, handle.destination);
      }
    },

    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      _ctx: ProviderCallContext,
    ) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<T>('extract', started, new Error('Unknown sessionId'), null, 'BAD_INPUT');
      }
      try {
        const page = await activePage(handle);

        // DETERMINISTIC PATH, and the default. Reading a page's text needs no
        // model, and requiring one here made this backend unusable without an
        // LLM key while the local adapter worked fine — the two must behave the
        // same or "local is equivalent for ordinary pages" is not a real claim.
        //
        // `instruction` is an optional CSS scope, matching localbrowser.extract.
        // Natural-language extraction is opt-in via `nl:` below.
        if (!input.instruction.startsWith('nl:')) {
          const scope = input.instruction.trim();
          const text = await page.evaluate<string, undefined>(
            scope
              ? `(() => { const el = document.querySelector(${JSON.stringify(scope)});
                   return el ? (el.innerText || '') : ''; })()`
              : `(() => (document.body && document.body.innerText) || '')()`,
          );
          return {
            ok: true as const,
            data: {
              url: browserLocation(await page.url()),
              title: await page.title().catch(() => ''),
              text: truncate(text ?? '', 4000),
            } as T,
            meta: meta('extract', started, handle.destination),
          };
        }

        // NATURAL-LANGUAGE PATH: only this one needs a model.
        requireModel();
        if (!handle.stagehand) throw new Error('Stagehand is not attached to this session.');
        // No zod schema -> Stagehand returns { extraction: string }. Pass a
        // schema as a second argument for structured extraction.
        const result = await handle.stagehand.extract(input.instruction.slice(3).trim());
        return {
          ok: true as const,
          data: result.data as T,
          meta: meta('extract', started, handle.destination),
        };
      } catch (err) {
        return failure<T>('extract', started, err, handle.destination);
      }
    },

    async snapshot(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<ElementTable>(
          'snapshot',
          started,
          new Error('Unknown sessionId'),
          null,
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
          meta: meta('snapshot', started, handle.destination),
        };
      } catch (err) {
        return failure<ElementTable>('snapshot', started, err, handle.destination);
      }
    },

    async perform(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<BrowserPerformResult>(
          'perform',
          started,
          new Error('Unknown sessionId'),
          null,
          'BAD_INPUT',
        );
      }

      try {
        const page = await activePage(handle);

        if (!needsTarget(input.operation)) {
          if (input.operation === 'SCROLL_DOWN') await page.scroll(0, 0, 0, 600);
          else if (input.operation === 'SCROLL_UP') await page.scroll(0, 0, 0, -600);
          else if (input.operation === 'WAIT') await page.waitForTimeout(500);
          handle.snapshot = undefined;
          return {
            ok: true as const,
            data: {
              operation: input.operation,
              url: browserLocation(await page.url()),
              navigated: false,
            },
            meta: meta('perform', started, handle.destination),
          };
        }

        /* -- 1. FRESHNESS. -------------------------------------------------- */
        const snap = handle.snapshot;
        if (!snap || snap.id !== input.snapshotId) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'stale_snapshot',
            handle.destination,
          );
        }
        if (input.index === undefined) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'wrong_operation',
            handle.destination,
          );
        }

        const row = snap.table.rows.find((r) => r.index === input.index);
        const domIndex = snap.domIndices.get(input.index);
        if (!row || domIndex === undefined) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'unknown_index',
            handle.destination,
          );
        }

        const eligible =
          input.operation === 'CLICK'
            ? row.clickable
            : input.operation === 'TYPE_TEXT'
              ? row.editable
              : row.selectable;
        if (!eligible) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'wrong_operation',
            handle.destination,
          );
        }

        const locator = page.locator(INTERACTIVE_SELECTOR).nth(domIndex);

        /* -- 2 AND 3, IN ONE ROUND TRIP: attached, interactable, occluded. -- */
        // Each of these used to be a separate call, and against a CLOUD browser
        // every call is a network hop. Collapsing them is the single cheapest
        // latency win available here.
        const state = await page
          .evaluate<TargetState | null, undefined>(
            validateTargetScript(domIndex, { label: row.label, role: row.role }),
          )
          .catch(() => null);

        const rejection = rejectionFor(state);
        if (rejection) {
          return rejected<BrowserPerformResult>('perform', started, rejection, handle.destination);
        }

        const urlBefore = await page.url();

        if (input.operation === 'CLICK') {
          await locator.click();
        } else if (input.operation === 'TYPE_TEXT') {
          // The decision picked the FIELD. The value came from a generative
          // model or from the caller's args — never from Jev.
          await locator.fill(input.text ?? '');
        } else {
          await locator.selectOption([input.text ?? '']);
        }

        // Let the page settle before anyone snapshots it again. A combobox
        // needs longer than a click because its suggestions render async;
        // these are jev-ultrafast's numbers (~200ms / ~50ms), not a guess.
        await page.waitForTimeout(
          input.operation === 'SELECT' ? config.browser.settleSelectMs : config.browser.settleMs,
        );

        const url = await page.url();
        handle.snapshot = undefined;

        return {
          ok: true as const,
          data: {
            operation: input.operation,
            index: input.index,
            url: browserLocation(url),
            navigated: url !== urlBefore,
          },
          meta: meta('perform', started, handle.destination),
        };
      } catch (err) {
        return failure<BrowserPerformResult>('perform', started, err, handle.destination);
      }
    },

    /**
     * A FRESH viewer URL, minted now.
     *
     * The URL captured at openSession is signed with a short-lived token, so it
     * is already dead by the time a person clicks a handoff link. Re-fetching
     * per request is the whole point of this method -- do not cache what it
     * returns. Verified: a stale URL renders "WebSocket disconnected" and
     * accepts no input; a freshly minted one for the SAME session renders the
     * live page and is interactive.
     */
    async viewer(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle)
        return failure('viewer', started, new Error('Unknown sessionId'), null, 'BAD_INPUT');
      try {
        const page = await activePage(handle);
        return {
          ok: true as const,
          data: {
            providerId: 'browserbase' as const,
            mode: 'live' as const,
            kind: 'stream' as const,
            owner: 'agent' as const,
            revision: 0,
            phase: 'agent_running' as const,
            pageUrl: browserLocation(await page.url()),
            interactive: input.mode === 'control',
            canWatch: true,
            canControl: true,
            width: 1280,
            height: 720,
          },
          meta: meta('viewer', started, handle.destination),
        };
      } catch (err) {
        return failure('viewer', started, err, handle.destination);
      }
    },
    async liveView(sessionId, _ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure('liveView', Date.now(), new Error('Unknown sessionId'), null, 'BAD_INPUT');
      const page = await activePage(handle);
      return {
        ok: true as const,
        data: { pageUrl: browserLocation(await page.url()), interactive: true },
        meta: meta('liveView', Date.now(), handle.destination),
      };
    },
    async captureFrame(sessionId, _ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure(
          'captureFrame',
          Date.now(),
          new Error('Unknown sessionId'),
          null,
          'BAD_INPUT',
        );
      try {
        const page = await activePage(handle);
        const bytes = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
        return {
          ok: true as const,
          data: { bytes, width: 1280, height: 720 },
          meta: meta('captureFrame', Date.now(), handle.destination),
        };
      } catch (err) {
        return failure('captureFrame', Date.now(), err, handle.destination);
      }
    },
    async humanInput(input, _ctx) {
      const handle = sessions.get(input.sessionId);
      if (!handle)
        return failure('humanInput', Date.now(), new Error('Unknown sessionId'), null, 'BAD_INPUT');
      try {
        const page = await activePage(handle);
        const entry = input.input;
        if (entry.type === 'click') await page.click(entry.x, entry.y);
        else if (entry.type === 'key') await page.keyPress(entry.key);
        else if (entry.type === 'text') await page.type(entry.text);
        else await page.scroll(0, 0, entry.deltaX, entry.deltaY);
        handle.snapshot = undefined;
        return {
          ok: true as const,
          data: null,
          meta: meta('humanInput', Date.now(), handle.destination),
        };
      } catch (err) {
        return failure('humanInput', Date.now(), err, handle.destination);
      }
    },
    async revokeControl(sessionId, _ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure(
          'revokeControl',
          Date.now(),
          new Error('Unknown sessionId'),
          null,
          'BAD_INPUT',
        );
      // No provider-native interactive link is ever issued. The wrapper changes
      // phase before drain, so every old HTTP input is rejected server-side.
      return {
        ok: true as const,
        data: null,
        meta: meta('revokeControl', Date.now(), handle.destination),
      };
    },
    async invalidateSnapshot(sessionId, _ctx) {
      const handle = sessions.get(sessionId);
      if (!handle)
        return failure(
          'invalidateSnapshot',
          Date.now(),
          new Error('Unknown sessionId'),
          null,
          'BAD_INPUT',
        );
      handle.snapshot = undefined;
      return {
        ok: true as const,
        data: null,
        meta: meta('invalidateSnapshot', Date.now(), handle.destination),
      };
    },

    async closeSession(sessionId, _ctx) {
      const started = Date.now();
      const handle = sessions.get(sessionId);
      // Idempotent, so a `finally` can call this unconditionally without
      // masking the error that sent it there.
      if (!handle) {
        return { ok: true as const, data: null, meta: meta('closeSession', started, null) };
      }
      // Delete FIRST: if close() throws we must still free the slot, or a
      // wedged session permanently consumes BROWSER_MAX_SESSIONS.
      sessions.delete(sessionId);
      try {
        await handle.browser.close();
        return {
          ok: true as const,
          data: null,
          meta: meta('closeSession', started, handle.destination),
        };
      } catch (err) {
        return failure('closeSession', started, err, handle.destination);
      }
    },
  };
}
