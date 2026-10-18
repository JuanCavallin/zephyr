/**
 * Matching a pending handoff approval to the browser session it is waiting on.
 *
 * ONE implementation, because two run surfaces need the same answer and a
 * second copy would drift: the redesigned `LiveRunWorkspace` renders approvals
 * in its conversation lane, and `RunDetail` renders them above the canvas.
 *
 * The join key is `sessionId`, which `runHandoff` (core/graph/interpreter.ts)
 * puts in the approval's payload precisely so the UI can do this. The session's
 * URL arrives separately, on the run stream as `browser.session.opened` -- see
 * BrowserSessionRecord for why it is announced rather than carried on a step.
 */

import type { Approval, BrowserSessionRecord, Iso } from '@htn/shared';

type SessionLike = BrowserSessionRecord & { closedAt?: Iso };

/** The payload shape runHandoff writes. Everything optional -- this is wire data. */
interface HandoffPayload {
  kind?: unknown;
  sessionId?: unknown;
  review?: unknown;
}

function payloadOf(approval: Approval): HandoffPayload | null {
  const action = approval.proposedAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const payload = action as HandoffPayload;
  if (
    payload.review &&
    typeof payload.review === 'object' &&
    !Array.isArray(payload.review) &&
    (payload.review as HandoffPayload).kind === 'browser_handoff'
  )
    return { ...(payload.review as HandoffPayload), kind: 'human_handoff' };
  return payload;
}

/** True when this approval is a handoff rather than an ordinary risk gate. */
export function isHandoffApproval(approval: Approval): boolean {
  return payloadOf(approval)?.kind === 'human_handoff';
}

/**
 * The browser session id a handoff approval is parked on, or undefined.
 *
 * DELIBERATELY RETURNS AN ID, NOT A URL. The viewer URL is signed with a
 * short-lived token and must be minted when the person actually clicks --
 * see api.browserLiveView. Returning a URL from here is what produced a blank,
 * uninteractive page in the first place.
 *
 * A CLOSED session returns undefined: its viewer cannot be re-minted, so
 * offering the control would hand someone a dead end.
 */
export function handoffSessionIdFor(
  approval: Approval,
  sessions: readonly SessionLike[],
): string | undefined {
  const payload = payloadOf(approval);
  if (payload?.kind !== 'human_handoff') return undefined;
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string') return undefined;

  const session = sessions.find((candidate) => candidate.sessionId === sessionId);
  // A session we never saw announced is still worth offering: the stream may
  // have been trimmed, and the server re-checks liveness when minting.
  if (session?.closedAt) return undefined;
  return sessionId;
}
