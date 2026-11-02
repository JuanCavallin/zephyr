/**
 * One task board, live. The snapshot comes from GET /api/tasks/:boardId; after that
 * every card change arrives as a task.* event on the board run's stream, which also
 * replays the history on connect, so a reload loses nothing.
 */

import { useCallback, useEffect, useReducer, useState } from 'react';
import { api } from '../lib/api';
import { boardReducer, emptyBoard, type BoardEvent, type BoardSnapshot, type InboxItem } from '../lib/board';

export function useBoard(boardId: string | undefined) {
  const [state, dispatch] = useReducer(boardReducer, emptyBoard);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!boardId) return;
    try {
      dispatch({ type: 'snapshot', board: await api.board(boardId) });
      setError('');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not load the board.');
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!boardId) return;
    const source = new EventSource('/api/runs/' + encodeURIComponent(boardId) + '/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        dispatch(JSON.parse(message.data) as BoardEvent);
      } catch {
        // A malformed frame must not tear down the stream.
      }
    };
    return () => {
      source.close();
      setConnected(false);
    };
  }, [boardId]);

  /** Apply an edit response (reorder emits no event, so the response is the truth). */
  const accept = useCallback((board: BoardSnapshot) => dispatch({ type: 'snapshot', board }), []);

  return { state, connected, error, reload: load, accept };
}

/** "Needs you": the server re-sends the whole inbox over SSE whenever it changes. */
export function useInbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/tasks/inbox/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('inbox', (message) => {
      try {
        setItems((JSON.parse((message as MessageEvent<string>).data) as { items: InboxItem[] }).items);
      } catch {
        // Keep the last good inbox.
      }
    });
    return () => source.close();
  }, []);

  return { items, connected };
}
