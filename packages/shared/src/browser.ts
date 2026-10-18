/**
 * The browser family's shared vocabulary — `3B-4`'s contract.
 *
 * THE CENTRAL IDEA: a page becomes a small NUMBERED TABLE of interactive
 * elements. Jev is asked which INDEX to act on and answers `7`. The live
 * element handle for index 7 never leaves the adapter, and no CSS selector is
 * ever generated, returned, or stored.
 *
 * Why that matters beyond tidiness:
 *   - Selectors go stale between the snapshot and the click; handles do not.
 *   - An accessibility snapshot is 2-5KB where a screenshot is 100KB+, and
 *     vision tokens cost 3-5x text tokens. The table IS the request state, and
 *     state dominates a batched System One request, so keeping it small is the
 *     single biggest latency lever we control.
 *   - A model that can only return an integer into a list WE built cannot be
 *     talked by page content into issuing an action. That constrains prompt
 *     injection structurally. It does NOT replace `authorize_action`.
 *
 * ADDITIVE EDITS ONLY — published API.
 */

import type { Iso } from './domain.js';
import type { ProviderId } from './providers.js';

/**
 * The operation vocabulary, matching `browser-use/jev-ultrafast`.
 *
 * `TYPE_TEXT` is the one people get wrong: Jev picks WHICH FIELD, a small
 * generative model supplies WHAT TO TYPE. Jev cannot write text.
 *
 * `DONE` / `BLOCKED` deliberately mirror the completion judge's vocabulary.
 */
export type BrowserOperation =
  'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' | 'BLOCKED';

export const BROWSER_OPERATIONS = [
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
  'DONE',
  'BLOCKED',
] as const satisfies readonly BrowserOperation[];

/** Operations that need a target index from the element table. */
export const TARGETED_OPERATIONS = ['CLICK', 'TYPE_TEXT', 'SELECT'] as const;

export function needsTarget(operation: BrowserOperation): boolean {
  return (TARGETED_OPERATIONS as readonly string[]).includes(operation);
}

/** One row of the table. `index` is what Jev returns. */
export interface ElementRow {
  /** 1-based. The `criteria` key handed to Jev. */
  index: number;
  /** Accessibility role: button, link, textbox, combobox, checkbox... */
  role: string;
  /** Accessible name, TRUNCATED. Long labels are the main table-size risk. */
  label: string;
  /** Current value for an input, truncated. Omitted when empty. */
  value?: string;
  /** Eligible for CLICK. */
  clickable: boolean;
  /** Eligible for TYPE_TEXT. */
  editable: boolean;
  /** Eligible for SELECT. */
  selectable: boolean;
}

/**
 * One snapshot of a page's interactive elements.
 *
 * `snapshotId` is the FRESHNESS TOKEN. An operation carries the id it was
 * decided against; if the adapter has since re-snapshotted, the operation is
 * refused rather than applied to a page that has moved underneath it. This is
 * where browser agents get flaky, so it is a hard check, not a warning.
 */
export interface ElementTable {
  snapshotId: string;
  sessionId: string;
  url: string;
  title: string;
  capturedAt: Iso;
  rows: ElementRow[];
  /** True when `totalInteractive` exceeded the cap and rows were dropped. */
  truncated: boolean;
  /** How many interactive elements the page actually had. */
  totalInteractive: number;
}

/** Outcome of applying one operation to one index. */
export interface BrowserPerformResult {
  operation: BrowserOperation;
  index?: number;
  /** URL after the operation. */
  url: string;
  /** True when the operation changed the page's document. */
  navigated: boolean;
}

/**
 * Why a chosen target was refused before execution. Both of these are normal
 * outcomes on a live page, not bugs — the caller re-snapshots and re-decides.
 */
export type TargetRejection =
  /** The page was re-snapshotted after the decision was made. */
  | 'stale_snapshot'
  /** The index is not in the table. */
  | 'unknown_index'
  /** The element is gone from the DOM. */
  | 'detached'
  /** Something (a modal, a cookie banner) is covering it. */
  | 'occluded'
  /** Present but not visible or not enabled. */
  | 'not_interactable'
  /** The operation does not apply to this element's role. */
  | 'wrong_operation';

/** The two destinations a browser step may run against. Recorded in the ledger. */
export const LOCAL_BROWSER_DESTINATION = 'local://chromium';

/**
 * Browserbase's egress host is REGION-SPECIFIC (`connect.usw2.browserbase.com`,
 * not the generic host). Approvals bind to a destination, so the per-session
 * value is what gets recorded — this constant is only the API control plane.
 */
export const BROWSERBASE_API_DESTINATION = 'https://api.browserbase.com';

export const BROWSERLESS_DEFAULT_DESTINATION = 'https://production-sfo.browserless.io';

export type BrowserBackend = 'browserbase' | 'browserless' | 'localbrowser';
export interface BrowserControlState {
  owner: 'agent' | 'human';
  revision: number;
  phase: 'agent_running' | 'draining' | 'human_control' | 'verifying' | 'closed';
}
export type BrowserHumanInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'scroll'; deltaX: number; deltaY: number };
export interface BrowserViewer extends BrowserControlState {
  providerId: BrowserBackend;
  mode: import('./providers.js').ProviderMode;
  kind: 'iframe' | 'stream' | 'none';
  liveViewUrl?: string;
  pageUrl?: string;
  interactive: boolean;
  canWatch: boolean;
  canControl: boolean;
  width: number;
  height: number;
  expiresAt?: string;
  simulated?: boolean;
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Session records — what the UI needs to show a live browser                  */
/* -------------------------------------------------------------------------- */

/**
 * One browser session, as the RUN knows about it.
 *
 * WHY THIS EXISTS AS A RUN-LEVEL RECORD rather than a field on a step: the
 * session's live-view URL is only obtainable at OPEN time (Browserbase's
 * `sessions.debug()` returns 410 Gone once a session stops — see
 * browserbase/live.ts), and the node that opens a session is frequently not
 * the node you want to watch. An `agent_task` opens one deep inside a harness
 * loop; a `dispatch` opens one via whichever tool it chose. Hanging the URL off
 * `browser.open`'s step output would mean the panel works for exactly one graph
 * shape and silently shows nothing for the rest.
 *
 * So the session is announced on the event stream (`browser.session.opened`)
 * and the UI keeps its own list. `nodeId` is best-effort attribution for the
 * canvas; a session with none still shows up, it just isn't pinned to a node.
 *
 * NOTHING SENSITIVE BELONGS HERE. This record crosses SSE to the browser and is
 * persisted in the run's event log. It carries a URL to a viewer and no page
 * content — never put form values, cookies or credentials on it.
 */
export interface BrowserSessionRecord {
  /** Truthful execution and viewer state, never a bearer URL. */
  mode?: import('./providers.js').ProviderMode;
  viewerKind?: BrowserViewer['kind'];
  owner?: BrowserControlState['owner'];
  revision?: number;
  runId: string;
  /** The adapter's own opaque id, as returned by openSession. */
  sessionId: string;
  /** The step that opened it, when one did. */
  stepId?: string;
  /** Best-effort: the graph node the opening step belonged to. */
  nodeId?: string;
  /** Which backend. Drives the "this ran locally" badge. */
  providerId: ProviderId;
  /**
   * Embeddable viewer. Undefined for localbrowser and every mock, which is a
   * NORMAL state the panel must render — fall back to the element table.
   */
  liveViewUrl?: string;
  /**
   * True when a human can actually type into `liveViewUrl`. Browserbase's
   * `debuggerFullscreenUrl` is interactive; a recording or screenshot strip is
   * not. A `handoff` node REQUIRES this to be true, so it must never be
   * guessed — an adapter that cannot promise it leaves it false.
   */
  interactive: boolean;
  /** Where the session was pointed when it opened, if anywhere. */
  startUrl?: string;
  openedAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Cross-run browser memory                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which element a graph node used on a page, remembered across runs so a
 * repeat visit needs no target decision. It records IDENTITY (role + label,
 * plus which of several equal matches), never an index, never page text,
 * typed values or query strings, and only for public pages. It remembers
 * WHICH element, never permission: approval is decided afresh every time.
 */
export interface BrowserTargetMemory {
  /** scope | operations | origin+path template | normalized goal. */
  key: string;
  /** `graphId|nodeId` for graph runs, `adhoc:<run kind>` otherwise. */
  scope: string;
  origin: string;
  pathTemplate: string;
  operation: BrowserOperation;
  role: string;
  label: string;
  /** 0-based position among rows sharing this role and label. */
  ordinal: number;
  /** A person's correction outranks a model pick. */
  source: 'jev' | 'deterministic' | 'human';
  hits: number;
  misses: number;
  consecutiveMisses: number;
  createdAt: Iso;
  lastSeen: Iso;
}

/** An origin that showed a challenge, sign-in wall or empty page to an automated read. */
export interface BrowserSiteBlock {
  origin: string;
  reason: 'empty_page' | 'browser_challenge';
  count: number;
  firstAt: Iso;
  lastAt: Iso;
}
