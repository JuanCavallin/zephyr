/**
 * Which browser actions need a human, decided by WHAT THEY DO, not by how sure
 * Jev was about the element.
 *
 * A low-confidence click on a search result costs nothing if it is wrong; a
 * confident click on "Place order" can spend money. So Jev's target pick is
 * followed at any confidence (see the Jev-verdicts rule), and approval is
 * required for consequential targets instead. This is the DETERMINISTIC FLOOR:
 * Jev's action policy also sees the target and may add caution, but cannot
 * remove an approval this requires — it holds in mock mode and when Jev is down.
 */

import type { BrowserOperation, ElementRow } from '@htn/shared';

/**
 * Labels whose click commits something outside the page: money, messages,
 * publication, deletion, account or booking changes. Matched as whole words on
 * the accessible name. "Add to bag", "Next" or "Sign in" are not here: they are
 * reversible, or (credentials) already a human handoff.
 */
const CONSEQUENTIAL_PHRASES = [
  // money
  'buy',
  'buy now',
  'purchase',
  'pay',
  'pay now',
  'checkout',
  'check out',
  'place order',
  'place your order',
  'order now',
  'complete order',
  'complete purchase',
  'transfer',
  'withdraw',
  'donate',
  // commitments
  'confirm',
  'submit',
  'submit application',
  'apply now',
  'accept offer',
  'accept terms',
  'book now',
  'reserve',
  'subscribe',
  'sign up',
  // messages and publication
  'send',
  'send message',
  'send email',
  'post',
  'publish',
  // destruction and account changes
  'delete',
  'close account',
  'cancel subscription',
  'cancel order',
  'cancel membership',
  'unsubscribe',
];
const normalizedLabel = (label: string) =>
  ' ' +
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() +
  ' ';

export type BrowserRiskReason = 'submit_operation' | 'consequential_label';

/** Null when the action is reversible enough to run on Jev's pick alone. */
export function consequentialBrowserAction(
  toolOperation: string,
  decided: BrowserOperation,
  target: Pick<ElementRow, 'label' | 'role'>,
): BrowserRiskReason | null {
  if (toolOperation === 'submit') return 'submit_operation';
  // Typing stays on the page until something submits it; that click is gated.
  if (decided !== 'CLICK') return null;
  const label = normalizedLabel(target.label);
  return CONSEQUENTIAL_PHRASES.some((phrase) => label.includes(' ' + phrase + ' '))
    ? 'consequential_label'
    : null;
}
