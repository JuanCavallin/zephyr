/**
 * The single client-side reducer. Every component on the run page reads from this.
 *
 * Note what is NOT here: there is no initial fetch. The SSE endpoint replays the
 * run's whole event history on connect (cursor 0), so the stream alone rebuilds
 * complete state. On reconnect the browser sends Last-Event-ID automatically and
 * the server replays only the gap. Reloading mid-run is therefore lossless and
 * needs no extra code.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { emptyRunView, isTerminal, type RunEvent, type RunView } from '@htn/shared';
import { api } from '../lib/api';

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

export function runReducer(state: RunView, event: RunEvent | { type: 'reset' }): RunView {
  switch (event.type) {
    case 'reset':
      return emptyRunView;
    case 'run.updated':
      // A finished run holds no live browser: AgentOS releases every session a
      // run opened as it ends. Those `browser.session.closed` events can land
      // after the terminal update, when this stream has already closed, so a
      // finished run kept offering "Watch browser & take control".
      if (isTerminal(event.run.status)) {
        return {
          ...state,
          run: event.run,
          browserSessions: state.browserSessions.map((session) =>
            session.closedAt ? session : { ...session, closedAt: event.run.updatedAt },
          ),
        };
      }
      return { ...state, run: event.run };

    case 'step.upserted':
      return { ...state, steps: upsert(state.steps, event.step).sort((a, b) => a.seq - b.seq) };

    case 'approval.requested':
    case 'approval.resolved':
      return { ...state, approvals: upsert(state.approvals, event.approval) };

    case 'egress.logged':
      return { ...state, egress: [...state.egress, event.egress] };

    case 'pii.detected':
      return { ...state, piiSpans: upsert(state.piiSpans, event.span) };

    // Without this case the field stays empty forever and every tool-reduction
    // number (availableTools vs exposedTools) is invisible to the UI, even
    // though the server emits the event and RunView declares the field.
    case 'schedule.decided':
      return {
        ...state,
        scheduleDecisions: upsert(state.scheduleDecisions, event.decision),
      };

    // A session can be announced more than once on replay, so this is an
    // upsert keyed on sessionId rather than an append -- otherwise reconnecting
    // mid-run shows the same browser twice.
    case 'browser.session.opened': {
      const at = state.browserSessions.findIndex((s) => s.sessionId === event.session.sessionId);
      if (at !== -1) {
        const next = [...state.browserSessions];
        next[at] = { ...next[at], ...event.session };
        return { ...state, browserSessions: next };
      }
      return { ...state, browserSessions: [...state.browserSessions, event.session] };
    }

    // Marked closed IN PLACE, never removed: a finished run still has to list
    // the sessions it used so the panel can show their decision trail.
    case 'browser.session.closed':
      return {
        ...state,
        browserSessions: state.browserSessions.map((s) =>
          s.sessionId === event.sessionId ? { ...s, closedAt: event.at } : s,
        ),
      };

    // The tool plane and Jev's selections. Without these the graph cannot show which tools
    // were exposed or called: an agent run has ONE outer step, and everything a tool did
    // arrives only as these events.
    case 'control.decided':
      return { ...state, controlDecisions: upsert(state.controlDecisions, event.decision) };

    case 'model.lifecycle':
      return { ...state, modelCalls: upsert(state.modelCalls, event.lifecycle) };

    case 'harness.turn':
      return { ...state, harnessTurns: upsert(state.harnessTurns, event.turn) };

    // Several events per action (proposed ... succeeded), each with its own id, so this
    // appends; the trace groups them by `action.id`.
    case 'tool.lifecycle':
      return { ...state, toolLifecycle: upsert(state.toolLifecycle, event.lifecycle) };

    case 'session.updated':
      return { ...state, agentSessions: upsert(state.agentSessions, event.session) };

    case 'log':
      return {
        ...state,
        logs: [...state.logs, { level: event.level, message: event.message, at: event.at }],
      };

    default:
      // An older tab must not break when the server learns a new event type.
      return state;
  }
}

export interface RunStreamState extends RunView {
  connected: boolean;
  lastEventAt: number | null;
}

export function useRunStream(runId: string | undefined, reconnectKey = 0): RunStreamState {
  const [view, dispatch] = useReducer(runReducer, emptyRunView);
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  // A REST fallback for `view.run` specifically -- not steps/egress/approvals,
  // which stay SSE-only below. The stream can only replay what's still in the
  // runtime's in-memory event log (steps/egress/etc are NOT durable the way
  // the run row itself is -- see store/sqlite.ts), so a run whose history
  // didn't survive a server restart gets an open, healthy stream that replays
  // nothing: without this, the page hangs on "Connecting..." forever with no
  // error and no data. `run.updated` REPLACES state.run wholesale, so this is
  // safe to race against the stream's own replay in either order -- whichever
  // arrives second just reconfirms the same (or a fresher) run.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    api
      .getRun(runId)
      .then(({ run }) => {
        if (!cancelled) dispatch({ type: 'run.updated', run });
      })
      .catch(() => {
        // A genuinely missing run: the page's own "connecting" state stays
        // as-is, which is honest -- there is nothing to show either way.
      });
    return () => {
      cancelled = true;
    };
    // reconnectKey too: a manual reconnect resets the view below, and if the stream then
    // replays nothing the run -- and with it the graph snapshot the canvas is drawn from --
    // would stay gone. Refetching here is what brings the graph back.
  }, [runId, reconnectKey]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setConnected(false);
    setLastEventAt(null);
    if (!runId) return;

    const source = new EventSource('/api/runs/' + runId + '/stream');
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RunEvent;
        dispatch(event);
        setLastEventAt(Date.now());
        // REST may return a completed run before SSE replays its actions. Close only
        // after the terminal stream event so refreshes retain the full decision trail.
        if (event.type === 'run.updated' && isTerminal(event.run.status)) {
          source.close();
          sourceRef.current = null;
          setConnected(false);
        }
      } catch {
        // A malformed frame must not tear down the stream.
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [runId, reconnectKey]);

  return { ...view, connected, lastEventAt };
}
