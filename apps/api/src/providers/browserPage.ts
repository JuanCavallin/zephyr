/**
 * The in-page half of every browser engine: the scripts that run inside the
 * page, and the pure helpers that turn what they return into an element table.
 *
 * ONE COPY, three users: localbrowser/live.ts (local Chrome, and Browserless
 * through its transport), browserbase/live.ts (Stagehand), and
 * scripts/bench-browser.ts, which must measure exactly what the adapters run.
 *
 * No vendor types: every export is a string or plain data, so each engine
 * evaluates these through its own `page.evaluate`.
 */

import type { TargetRejection } from '@htn/shared';

/**
 * Interactive roles only. Static text, headings and images are dropped: they
 * are never an action target, and they are most of a page's element count.
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
].join(',');

/** One row as the in-page collector returns it. Serialisable, no DOM types. */
export interface RawRow {
  domIndex: number;
  tag: string;
  role: string | null;
  type: string | null;
  name: string;
  value: string;
  visible: boolean;
}

/**
 * The in-page collector. ONE call returns every row.
 *
 * WHY A STRING IIFE AND NOT AN ARROW FUNCTION: this package's tsconfig has no
 * `dom` lib — it is a server, and adding one would hand every other file in
 * apps/api a fake `document`. A string body runs in the page where those
 * globals are real and is invisible to tsc.
 *
 * WHY AN IIFE SPECIFICALLY: Playwright's and Stagehand's string forms evaluate
 * the string as an EXPRESSION in page context. A string containing
 * arrow-function SOURCE (`'el => el.tagName'`) therefore evaluates to a
 * function object, which is not serialisable, and comes back as `undefined` —
 * silently, with no error. That cost a real bug here: every role resolved to
 * 'element' and the occlusion probe always returned falsy, i.e. never blocked.
 * An IIFE is an expression that returns data, so it cannot fail that way.
 *
 * WHY ONE CALL: the previous shape made ~8 protocol round trips PER ELEMENT.
 * On a page with 60 controls that is ~480 round trips for one snapshot, which
 * is the opposite of the latency goal.
 */
export const COLLECT_ROWS = `(() => {
  const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const out = [];
  document.querySelectorAll(SEL).forEach((el, domIndex) => {
    const style = window.getComputedStyle(el);
    const visible =
      !el.closest('[hidden], [aria-hidden="true"]') &&
      el.getClientRects().length > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0;
    out.push({
      domIndex,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      name: (
        el.getAttribute('aria-label') ||
        (el.innerText || '').trim() ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        ''
      ),
      value: (el.type === 'password' || /password|passcode|secret|token|credential|otp|mfa|one-time-code/i.test([el.name || '', el.id || '', el.getAttribute('autocomplete') || '', el.getAttribute('aria-label') || ''].join(' ')) || el.value === undefined || el.value === null) ? '' : String(el.value),
      visible,
    });
  });
  return out;
})()`;

/**
 * PRE-FLIGHT VALIDATION IN ONE PROTOCOL CALL.
 *
 * The three checks before any action — attached, interactable, occluded — used
 * to be four separate round trips (`count`, `isVisible`, `isEnabled`, then an
 * `elementFromPoint` probe). Against a LOCAL browser that is merely wasteful;
 * against a cloud browser every one of them is a network RPC, so four round
 * trips per click is a real and avoidable cost.
 *
 * `browser-use/jev-ultrafast` reports cutting median protocol calls from 1,092
 * to 101 by making reads atomic like this. Same idea, same reason.
 *
 * The checks themselves are unchanged and still fail closed: anything this
 * cannot positively confirm comes back as not-actionable.
 */
export function validateTargetScript(
  domIndex: number,
  reviewed?: { label: string; role: string },
): string {
  return `(() => {
     const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
     const el = document.querySelectorAll(SEL)[${domIndex}];
     if (!el) return { exists: false };
     const reviewed = ${JSON.stringify(reviewed ?? null)};
     if (reviewed) {
       const tag = el.tagName.toLowerCase();
       const type = el.getAttribute('type');
       const inferred = tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : ['submit','button','reset'].includes(type) ? 'button' : 'textbox') : tag || 'element';
       const role = el.getAttribute('role') ?? inferred;
       const name = (el.getAttribute('aria-label') || (el.innerText || '').trim() || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g,' ').trim();
       const label = name.length > 80 ? name.slice(0,79)+'…' : name;
       if (role !== reviewed.role || label !== reviewed.label) return {exists:true,identityMatches:false};
     }

     const rect = el.getBoundingClientRect();
     const style = window.getComputedStyle(el);
     const visible =
       !el.closest('[hidden], [aria-hidden="true"]') &&
       rect.width > 0 && rect.height > 0 &&
       style.visibility !== 'hidden' && style.display !== 'none' &&
       Number(style.opacity) !== 0;

     const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';

     let occluded = true;
     if (visible) {
       const hit = document.elementFromPoint(
         rect.left + rect.width / 2,
         rect.top + rect.height / 2,
       );
       occluded = !hit || !(hit === el || el.contains(hit) || hit.contains(el));
     }

     return { exists: true, visible, enabled, occluded };
   })()`;
}

export interface TargetState {
  exists: boolean;
  visible?: boolean;
  enabled?: boolean;
  occluded?: boolean;
  identityMatches?: boolean;
}

/** Everything unproven is treated as not-actionable. */
export function rejectionFor(state: TargetState | null): TargetRejection | null {
  if (!state || typeof state !== 'object') return 'occluded';
  if (!state.exists) return 'detached';
  if (state.identityMatches === false) return 'stale_snapshot';
  if (!state.visible || !state.enabled) return 'not_interactable';
  if (state.occluded !== false) return 'occluded';
  return null;
}

/** Labels are the main table-size risk, and the table IS the request state. */
const MAX_LABEL_CHARS = 80;

export function truncate(text: string, max = MAX_LABEL_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

export const NON_TEXT_INPUT = new Set([
  'checkbox',
  'radio',
  'submit',
  'button',
  'reset',
  'file',
  'image',
  'range',
  'color',
]);

export function inferRole(tag: string, type: string | null): string {
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  return tag || 'element';
}
