import { useState } from 'react';
import type { Approval, ApprovalDecision } from '@htn/shared';
import { api } from '../../lib/api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { redactCredentialFields } from '../../lib/actions';
import { isHandoffApproval } from '../../lib/handoff';

/**
 * The human half of the risk gate.
 *
 * Design rule: the proposed action is shown VERBATIM, never summarised. If a
 * person is being asked to authorise something irreversible, they get to see
 * exactly what would be sent.
 *
 * TWO KINDS OF STOP LIVE HERE, and the difference is the whole point:
 *
 *   ordinary approval  "may the agent do this?"  -> Approve / Revise / Reject
 *   handoff            "you do this part"        -> a link, then Done
 *
 * A handoff (interpreter.ts's runHandoff) is an approval mechanically -- same
 * blocking promise, same decide endpoint -- but asking someone to "approve"
 * their own typing is nonsense, so the wording and the controls change. It has
 * no Revise: there is no payload to narrow, because the agent is not the one
 * acting.
 *
 * For an ordinary approval there are three answers, not two. "Revise" edits the
 * exact payload and sends it back for reauthorization -- the server re-runs the
 * risk gate on the edit and refuses it (422) if it broadens the action, so that
 * textarea is a narrowing control, not a way around the gate. A refused
 * revision leaves the approval pending, which is why the panel stays open and
 * editable on that error.
 */
export function ApprovalPanel({
  approval,
  handoffSessionId,
  decisionsDisabled = false,
  approvalDisabled = false,
  compact = false,
}: {
  approval: Approval;
  /**
   * The browser session a handoff is parked on, when there is one.
   *
   * DELIBERATELY NOT A URL. Browserbase signs its viewer with a short-lived
   * token, so a URL handed down through props is already stale by the time
   * anyone clicks it -- it opens a blank page that accepts no input, which is
   * exactly the bug this replaced. The id is stable; the URL is fetched on
   * click. Undefined is normal (local and mocked browsers have no viewer).
   */
  handoffSessionId?: string;
  decisionsDisabled?: boolean;
  approvalDisabled?: boolean;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  /**
   * Mint a viewer URL and open it. The window is opened FIRST, synchronously,
   * because a popup opened inside an await is a popup the browser blocks.
   *
   * No 'noopener' feature here: with it, window.open returns null, so the
   * pre-opened tab could never be navigated and the fallback below opened a
   * SECOND window. Severing the opener by hand gives the same isolation.
   */
  const openLiveView = async () => {
    setOpening(true);
    setError(null);
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const { liveViewUrl, pageUrl } = await api.browserLiveView(
        approval.runId,
        handoffSessionId as string,
      );
      if (!liveViewUrl) {
        tab?.close();
        setError('That browser session is no longer viewable. It may have already closed.');
        return;
      }
      // A blank page is not a broken viewer -- it is a browser that was opened
      // without a URL. Saying which is the difference between "this is broken"
      // and "the graph never told it where to go".
      if (!pageUrl || pageUrl === 'about:blank') {
        setError(
          'The browser is open but no page is loaded (about:blank). The step that opened it ' +
            'most likely had no url argument. Opening it anyway.',
        );
      }
      if (tab) tab.location.href = liveViewUrl;
      else window.open(liveViewUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      tab?.close();
      setError((err as Error).message);
    } finally {
      setOpening(false);
    }
  };

  // Set by runHandoff's proposedAction. Matching on `kind` rather than on the
  // presence of a URL keeps the handoff wording correct even when no viewable
  // session exists -- the person still has to go and do the thing.
  const action = approval.proposedAction;
  const isHandoff = isHandoffApproval(approval);
  const review =
    action && typeof action === 'object' && !Array.isArray(action) ? action.review : undefined;
  const [draft, setDraft] = useState<string | null>(null);

  const submit = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(approval.id, decision);
      setSubmitted(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const correctTarget = async (index: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.correctBrowserTarget(approval.id, index);
      setSubmitted(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitRevision = async () => {
    let revisedPayload: unknown;
    try {
      revisedPayload = JSON.parse(draft ?? '');
    } catch {
      // Caught here rather than sent: a payload that is not JSON cannot be
      // classified, and the gate would reject it with a far less useful message.
      setError('That is not valid JSON, so it cannot be reauthorized. Fix it and try again.');
      return;
    }
    await submit({ decision: 'revised', revisedPayload });
  };

  const startRevision = async () => {
    setBusy(true);
    setError(null);
    try {
      let payload = approval.proposedAction;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const exact = payload as Record<string, unknown>;
        const args = exact.arguments;
        if (
          args &&
          typeof args === 'object' &&
          !Array.isArray(args) &&
          typeof (args as Record<string, unknown>).previewRef === 'string'
        ) {
          const { preview } = await api.actionPreview(
            approval.runId,
            (args as Record<string, unknown>).previewRef as string,
          );
          payload = { ...exact, arguments: preview.arguments };
        }
      }
      setDraft(JSON.stringify(payload, null, 2));
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : 'The exact payload could not be loaded for revision.',
      );
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || submitted || decisionsDisabled;

  if (approval.status !== 'pending') {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge
            tone={
              approval.status === 'approved' ? 'ok' : approval.status === 'revised' ? 'warn' : 'bad'
            }
          >
            {approval.status}
          </Badge>
          <span className="text-sm text-slate-400">{approval.question}</span>
        </div>

        {/* Both survive on the record: what was asked for, and what ran. */}
        {approval.status === 'revised' && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Proposed</p>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                {JSON.stringify(redactCredentialFields(approval.proposedAction), null, 2)}
              </pre>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Executed (reauthorized
                {approval.reauthorizedRule ? ': ' + approval.reauthorizedRule : ''})
              </p>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-300">
                {JSON.stringify(redactCredentialFields(approval.revisedAction), null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (isHandoff) {
    return (
      <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="bad">you do this part</Badge>
          <span className="text-xs text-slate-500">the agent never performs this step</span>
        </div>

        <p className="mt-2 text-sm text-slate-100">{approval.question}</p>

        {handoffSessionId ? (
          <>
            <button
              type="button"
              onClick={() => void openLiveView()}
              disabled={opening}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-sky-400 disabled:bg-slate-700 disabled:text-slate-500"
            >
              {opening ? 'Opening…' : 'Open live browser ↗'}
            </button>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Opens in a new tab at full size. The run is holding this session open — do what you
              need to, then come back and confirm.
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-amber-400/90">
            This backend has no viewable session, so there is nothing to open. Do this in your own
            browser, then confirm.
          </p>
        )}

        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Manual input is sent only to this browser session. Agent actions stay blocked during
          handoff. After you continue, the agent may inspect the resulting page.
        </p>

        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

        {/* Short labels on purpose: the redesigned run view puts this in a
            narrow conversation lane, and "Done — continue" / "Skip and fail
            the run" both wrapped mid-word there. The consequence of skipping
            is spelled out in the line above rather than crammed into a button. */}
        <p className="mt-3 text-xs text-slate-500">
          Skipping fails the run — the agent will not attempt this itself.
        </p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => void submit({ decision: 'approved' })} disabled={disabled}>
            I&rsquo;m done
          </Button>
          <Button
            variant="danger"
            onClick={() => void submit({ decision: 'rejected' })}
            disabled={disabled}
          >
            Skip
          </Button>
        </div>
      </div>
    );
  }

  const revising = draft !== null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">approval required</Badge>
        <Badge tone="bad">{approval.reversibility}</Badge>
        <span className="text-xs text-slate-500">{approval.policyRule}</span>
      </div>

      <p className="mt-2 text-sm text-slate-100">{approval.question}</p>

      {review &&
        typeof review === 'object' &&
        !Array.isArray(review) &&
        review.kind === 'browser_target' && (
          <section className="mt-2" aria-label="Browser target review">
            <h3 className="text-sm font-medium">Prepared browser target</h3>
            <p className="text-xs text-slate-400">
              {review.consequential
                ? 'This click commits something (' +
                  String(review.risk ?? 'consequential') +
                  '), so it needs your approval at any confidence. '
                : ''}
              Approve only this operation and target; a changed target requires a fresh decision.
            </p>
            {review.remembered === 'human' && (
              <p className="mt-1 text-xs text-emerald-300">Remembered from your earlier choice.</p>
            )}
            {Array.isArray(review.candidates) && review.candidates.length > 1 && (
              <ul className="mt-2 space-y-1" aria-label="Other elements on this page">
                {review.candidates.slice(1).map((candidate) =>
                  candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? (
                    <li key={String(candidate.index)} className="flex items-center gap-2 text-xs">
                      <span className="text-slate-300">
                        [{String(candidate.index)}] {String(candidate.role)} “
                        {String(candidate.label)}”
                      </span>
                      <Button
                        variant="ghost"
                        disabled={busy || submitted}
                        onClick={() => void correctTarget(Number(candidate.index))}
                      >
                        Use this instead
                      </Button>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300">
              {JSON.stringify(redactCredentialFields(review), null, 2)}
            </pre>
          </section>
        )}

      {!compact && (
        <p className="mt-1 text-xs text-slate-500">
          The policy gate requires your decision before executing this exact action.
        </p>
      )}

      {revising ? (
        <>
          <textarea
            className="mt-2 h-48 w-full resize-y rounded bg-slate-950/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200 outline-none ring-1 ring-slate-800 focus:ring-amber-500/50"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Revised exact action payload"
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-slate-500">
            The edit goes back through the risk gate. It may narrow the action; a revision that
            makes it riskier is refused and the action stays pending.
          </p>
        </>
      ) : !compact ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          {JSON.stringify(redactCredentialFields(approval.proposedAction), null, 2)}
        </pre>
      ) : (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-400">Exact proposed action</summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] text-slate-400">
            {JSON.stringify(redactCredentialFields(approval.proposedAction), null, 2)}
          </pre>
        </details>
      )}

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {submitted && (
        <p className="mt-2 text-xs text-slate-400" role="status">
          Decision recorded. Waiting for the current run state…
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {revising ? (
          <>
            <Button onClick={() => void submitRevision()} disabled={disabled || approvalDisabled}>
              Send revised payload
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={disabled}>
              Cancel edit
            </Button>
            <Button
              variant="danger"
              onClick={() => void submit({ decision: 'rejected' })}
              disabled={disabled}
            >
              Reject
            </Button>
          </>
        ) : (
          <>
            <Button
              onClick={() => void submit({ decision: 'approved' })}
              disabled={disabled || approvalDisabled}
            >
              {compact ? 'Approve changes' : 'Approve and continue'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void startRevision()}
              disabled={disabled || approvalDisabled}
            >
              {compact ? 'Revise' : 'Revise payload'}
            </Button>
            <Button
              variant="danger"
              onClick={() => void submit({ decision: 'rejected' })}
              disabled={disabled}
            >
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
