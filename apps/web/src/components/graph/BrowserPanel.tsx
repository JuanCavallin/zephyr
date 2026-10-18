/**
 * Reusable supervised browser renderer. Native Browserless viewers enforce watch/control
 * on the server; Browserbase and local sessions use a bounded authenticated frame/input
 * bridge. Mock sessions show recorded decisions and never imply a connected browser.
 * Viewer grants remain transient and are refreshed from the session's actual provider.
 */
import { useEffect, useRef, useState } from 'react';
import type { Approval, BrowserSessionRecord, Iso, Step } from '@htn/shared';
import { api, type BrowserViewer } from '../../lib/api';
import { providerLabel } from '../../lib/workspace';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';

export type PanelSession = BrowserSessionRecord & { closedAt?: Iso };

/** The allowlisted fields interpreter.ts streams onto a browser tool's step. */
interface StreamedDecision {
  operation: string;
  index: number | null;
  target: string | null;
  url: string | null;
  navigated: boolean;
  decisionSource: string;
  confidence: number | null;
  rationale: string | null;
}

function decisionOf(step: Step): StreamedDecision | null {
  const output = step.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const decision = (output as Record<string, unknown>).decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null;
  return decision as unknown as StreamedDecision;
}

/**
 * Truthful labelling, per core/tools/browser.ts: a string match must not read
 * as a model decision, and a cache replay must not read as a live call. The
 * tone carries that distinction too -- `cache` is GOOD news (it was free), so
 * it is not the muted "nothing happened" grey.
 */
const SOURCE_TONE: Record<string, Tone> = {
  jev: 'accent',
  cache: 'ok',
  label: 'muted',
  deterministic: 'muted',
};

function sourceLabel(source: string): string {
  if (source === 'cache') return 'cache · 0 model calls';
  if (source === 'jev') return 'jev · 1 model call';
  return source;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  // Low confidence is the interesting case: escalateForConfidence() re-gates a
  // coin flip up to ask_human, and this bar is the only place that shows the
  // coin flip that triggered it.
  const tone = value >= 0.8 ? 'bg-emerald-400' : value >= 0.5 ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800">
        <div className={'h-full rounded-full ' + tone} style={{ width: pct + '%' }} />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-slate-400">{value.toFixed(2)}</span>
    </div>
  );
}

function DecisionRow({ decision }: { decision: StreamedDecision }) {
  return (
    <li className="rounded border border-slate-800 bg-slate-950/60 px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-medium text-sky-300">{decision.operation}</span>
        {decision.index !== null && (
          <span className="font-mono text-[11px] text-slate-500">[{decision.index}]</span>
        )}
        {decision.target && (
          <span className="truncate text-[11px] text-slate-200" title={decision.target}>
            {decision.target}
          </span>
        )}
      </div>

      {decision.confidence !== null && (
        <div className="mt-1.5">
          <ConfidenceBar value={decision.confidence} />
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge tone={SOURCE_TONE[decision.decisionSource] ?? 'muted'}>
          {sourceLabel(decision.decisionSource)}
        </Badge>
        {decision.navigated && <Badge tone="muted">navigated</Badge>}
      </div>

      {decision.rationale && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{decision.rationale}</p>
      )}
    </li>
  );
}

export function BrowserPanel({
  session,
  steps,
  handoff,
  onResume,
  onClose,
  busy = false,
  embedded = false,
}: {
  session: PanelSession;
  steps: Step[];
  handoff?: Approval;
  onResume?: (approvalId: string) => void | Promise<void>;
  onClose: () => void;
  busy?: boolean;
  embedded?: boolean;
}) {
  const [viewer, setViewer] = useState<BrowserViewer>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [frame, setFrame] = useState<string>();
  const [frameError, setFrameError] = useState('');
  const inputQueue = useRef(Promise.resolve());
  const live = !session.closedAt;
  const decisions = steps.map(decisionOf).filter((item): item is StreamedDecision => item !== null);
  const handoffPayload = handoff?.proposedAction;
  const handoffReview =
    handoffPayload && typeof handoffPayload === 'object' && !Array.isArray(handoffPayload)
      ? handoffPayload.review
      : undefined;
  const manualInstruction =
    handoffReview &&
    typeof handoffReview === 'object' &&
    !Array.isArray(handoffReview) &&
    typeof handoffReview.instruction === 'string'
      ? handoffReview.instruction
      : undefined;
  const controlling =
    viewer?.owner === 'human' &&
    viewer.phase === 'human_control' &&
    viewer.canControl &&
    !busy &&
    !loading &&
    !frameError;
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setViewer(await api.browserLiveView(session.runId, session.sessionId));
    } catch (issue) {
      setViewer(undefined);
      setError(issue instanceof Error ? issue.message : 'Viewer unavailable.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    setViewer(undefined);
    setError('');
    setLoading(true);
    if (!live) {
      setLoading(false);
      return;
    }
    api
      .browserLiveView(session.runId, session.sessionId)
      .then((next) => {
        if (active) setViewer(next);
      })
      .catch((issue) => {
        if (active) setError(issue instanceof Error ? issue.message : 'Viewer unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.runId, session.sessionId, live, handoff?.id]);
  useEffect(() => {
    setFrame(undefined);
    setFrameError('');
    if (!live || viewer?.kind !== 'stream' || !viewer.canWatch) return;
    let active = true;
    let objectUrl: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(
          '/api/runs/' + session.runId + '/browser/' + session.sessionId + '/frame',
          { cache: 'no-store', signal: abort.signal },
        );
        if (!response.ok) throw new Error('Browser frame unavailable (' + response.status + ').');
        const blob = await response.blob();
        if (!active) return;
        const next = URL.createObjectURL(blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
        setFrame(next);
        setFrameError('');
      } catch (issue) {
        if (active) {
          setFrame(undefined);
          setFrameError(issue instanceof Error ? issue.message : 'Browser stream interrupted.');
        }
      } finally {
        if (active) timer = setTimeout(() => void poll(), 900);
      }
    };
    void poll();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [session.runId, session.sessionId, live, viewer?.kind, viewer?.canWatch]);

  const control = async (release: boolean) => {
    if (!viewer) return;
    setLoading(true);
    setError('');
    try {
      await inputQueue.current;
      setViewer(
        await (release ? api.browserReleaseControl : api.browserTakeControl)(
          session.runId,
          session.sessionId,
          viewer.revision,
        ),
      );
    } catch (issue) {
      await refresh();
      setError(issue instanceof Error ? issue.message : 'Control transfer failed.');
    } finally {
      setLoading(false);
    }
  };
  const input = (value: Parameters<typeof api.browserInput>[3]) => {
    if (!controlling || !viewer) return;
    const revision = viewer.revision;
    inputQueue.current = inputQueue.current.then(async () => {
      try {
        await api.browserInput(session.runId, session.sessionId, revision, value);
      } catch (issue) {
        await refresh();
        setError(
          issue instanceof Error ? issue.message : 'Input refused. Refresh the session state.',
        );
      }
    });
  };
  const completeHandoff = async () => {
    if (!handoff || busy) return;
    setLoading(true);
    setError('');
    try {
      await inputQueue.current;
      await onResume?.(handoff.id);
    } catch (issue) {
      await refresh();
      setError(issue instanceof Error ? issue.message : 'Could not continue.');
    } finally {
      setLoading(false);
    }
  };
  return (
    <section
      className={embedded ? 'browser-renderer' : 'browser-renderer browser-docked'}
      aria-label="Supervised browser"
    >
      <header className="browser-toolbar">
        <Badge tone={(viewer?.mode ?? session.mode) === 'mock' ? 'warn' : 'accent'}>
          {viewer?.mode ?? session.mode ?? 'unconfirmed'} · {providerLabel(session.providerId)}
        </Badge>
        {session.providerId === 'browserbase' && <Badge tone="muted">deprecated</Badge>}
        <span>
          {!live
            ? 'Session ended'
            : viewer?.mode === 'mock'
              ? 'Mock rehearsal'
              : viewer?.phase === 'verifying'
                ? 'Verifying manual step · agent blocked'
                : viewer?.owner === 'human'
                  ? 'Human control · agent paused'
                  : 'Watching agent'}
        </span>
        {!embedded && (
          <button className="icon-button" onClick={onClose} aria-label="Close browser panel">
            ×
          </button>
        )}
      </header>
      <div className="browser-viewer">
        {live && viewer?.kind === 'iframe' && viewer.liveViewUrl && viewer.canWatch ? (
          <iframe
            src={viewer.liveViewUrl}
            title={controlling ? 'Browser under human control' : 'Read-only agent browser'}
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
            style={{ pointerEvents: loading || busy ? 'none' : undefined }}
          />
        ) : live && viewer?.kind === 'stream' && frame ? (
          <div
            className={'browser-frame' + (controlling ? ' is-controlling' : '')}
            tabIndex={controlling ? 0 : -1}
            role={controlling ? 'application' : 'img'}
            aria-label={
              controlling
                ? 'Interactive browser. Click the page, type, or paste. Tab stays in the page; Escape returns to controls.'
                : 'Read-only browser stream'
            }
            onClick={(event) => {
              if (!controlling) return;
              event.currentTarget.focus();
              const rect = event.currentTarget.getBoundingClientRect();
              input({
                type: 'click',
                x: Math.min(
                  1279,
                  Math.max(
                    0,
                    Math.round(((event.clientX - rect.left) / rect.width) * viewer.width),
                  ),
                ),
                y: Math.min(
                  719,
                  Math.max(
                    0,
                    Math.round(((event.clientY - rect.top) / rect.height) * viewer.height),
                  ),
                ),
              });
            }}
            onKeyDown={(event) => {
              if (!controlling) return;
              if (event.key === 'Escape') {
                event.currentTarget.blur();
                return;
              }
              if (['Control', 'Shift', 'Meta', 'Alt'].includes(event.key)) return;
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
              event.preventDefault();
              if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
                input({ type: 'text', text: event.key });
              else
                input({
                  type: 'key',
                  key: [
                    event.ctrlKey ? 'Control' : '',
                    event.metaKey ? 'Meta' : '',
                    event.altKey ? 'Alt' : '',
                    event.shiftKey ? 'Shift' : '',
                    event.key,
                  ]
                    .filter(Boolean)
                    .join('+'),
                });
            }}
            onPaste={(event) => {
              if (controlling) {
                event.preventDefault();
                input({ type: 'text', text: event.clipboardData.getData('text/plain') });
              }
            }}
            onWheel={(event) => {
              if (controlling)
                input({ type: 'scroll', deltaX: event.deltaX, deltaY: event.deltaY });
            }}
          >
            <img src={frame} draggable={false} alt="Current browser page" />
          </div>
        ) : (
          <div className="browser-empty-view">
            <span aria-hidden>▤</span>
            <p>
              {!live
                ? 'The session has ended.'
                : loading
                  ? 'Connecting to the browser…'
                  : viewer?.mode === 'mock'
                    ? 'Mock browser activity. No browser is connected and no real page is controlled.'
                    : (viewer?.reason ?? 'Live viewer unavailable for this session.')}
            </p>
            <small>The recorded decision trail remains available below.</small>
          </div>
        )}
      </div>
      {(error || frameError) && (
        <p className="error-note" role="alert">
          {error || frameError}
        </p>
      )}
      <div className="browser-control-bar">
        <button
          className="secondary-button"
          disabled={loading || !live}
          onClick={() => void refresh()}
        >
          {loading ? 'Connecting…' : 'Refresh view'}
        </button>
        {live &&
          viewer?.mode === 'live' &&
          viewer.canControl &&
          (!handoff || viewer.phase === 'verifying') && (
            <button
              className="primary-button"
              disabled={loading || busy}
              onClick={() => void control(viewer.owner === 'human' && viewer.phase !== 'verifying')}
            >
              {viewer.phase === 'verifying'
                ? 'Return to manual control'
                : viewer.owner === 'human'
                  ? 'Continue agent'
                  : 'Pause & take control'}
            </button>
          )}
        <span className="inline-note">
          {viewer?.mode === 'mock'
            ? 'Simulated handoff'
            : viewer?.kind === 'stream'
              ? 'Live frames · input is enabled only for the human owner'
              : viewer?.owner === 'human'
                ? 'Human control'
                : 'Read-only viewer'}
        </span>
      </div>
      {handoff && (
        <section className="browser-handoff">
          <Badge tone="warn">Your turn</Badge>
          <p>{handoff.question}</p>
          {manualInstruction && manualInstruction !== handoff.question && (
            <p>{manualInstruction}</p>
          )}
          <small>
            Complete the manual step, then continue. The agent may inspect the resulting page after
            handoff.
          </small>
          <div>
            <Button disabled={busy || loading || !onResume} onClick={() => void completeHandoff()}>
              {viewer?.phase === 'verifying' ? 'Retry verification' : 'Done — continue'}
            </Button>
          </div>
        </section>
      )}
      <details className="browser-decision-trail" open={viewer?.mode === 'mock'}>
        <summary>
          Decision trail <span>{decisions.length} actions</span>
        </summary>
        {!decisions.length ? (
          <p className="inline-note">No element decisions recorded yet.</p>
        ) : (
          <ol>
            {decisions.map((decision, index) => (
              <DecisionRow key={index} decision={decision} />
            ))}
          </ol>
        )}
      </details>
      {(viewer?.pageUrl ?? decisions.at(-1)?.url ?? session.startUrl) && (
        <p className="browser-location">
          {viewer?.pageUrl ?? decisions.at(-1)?.url ?? session.startUrl}
        </p>
      )}
    </section>
  );
}
