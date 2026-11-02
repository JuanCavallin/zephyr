/**
 * The coding-agent task board (docs/cacp-07-task-board.md).
 *
 *   /board       describe a change; Zephyr decomposes it into tasks. Nothing runs yet.
 *   /board/:id   review the decomposition (split, merge, reorder, scope, pin), then
 *                "Run ready tasks". Cards follow task.* events; "Needs you" is the inbox.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Task } from '@htn/shared';
import { Icon } from '../components/ui/Icon';
import { useBoard, useInbox } from '../hooks/useBoard';
import { api } from '../lib/api';
import {
  ASSIGNEES,
  COLUMNS,
  assigneeId,
  assigneeLabel,
  editable,
  inboxKey,
  moved,
  orderedTasks,
  parseScope,
  type BoardEditOp,
  type InboxItem,
} from '../lib/board';

function message(issue: unknown, fallback: string): string {
  return issue instanceof Error ? issue.message : fallback;
}

export function BoardHome() {
  const navigate = useNavigate();
  const [request, setRequest] = useState('');
  const [privateRun, setPrivateRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request.trim()) return;
    setBusy(true);
    setError('');
    try {
      const board = await api.createBoard({ request: request.trim(), private: privateRun });
      navigate('/board/' + board.run.id);
    } catch (issue) {
      setError(message(issue, 'Could not plan that change.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="library-page board-page">
      <header className="library-heading">
        <div>
          <h1>Split a change across agents.</h1>
          <p>
            Describe the change. Zephyr breaks it into tasks with write scopes; you review the
            plan before anything runs.
          </p>
        </div>
      </header>
      <div className="board-layout">
        <form className="board-compose" onSubmit={(e) => void submit(e)}>
          <label htmlFor="board-request">What should change?</label>
          <textarea
            id="board-request"
            rows={6}
            value={request}
            placeholder="Add rate limiting to the API, a settings page for it, and tests for both."
            onChange={(e) => setRequest(e.target.value)}
          />
          <label className="board-check">
            <input type="checkbox" checked={privateRun} onChange={(e) => setPrivateRun(e.target.checked)} />
            Private: keep routing decisions on a local model
          </label>
          {error && <p className="board-error">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy || !request.trim()}>
            <Icon name="spark" size={15} />
            {busy ? 'Planning…' : 'Plan tasks'}
          </button>
        </form>
        <Inbox />
      </div>
    </div>
  );
}

export function BoardPage() {
  const { id } = useParams();
  const { state, connected, error, reload, accept } = useBoard(id);
  const [selected, setSelected] = useState<string[]>([]);
  const [autoMerge, setAutoMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const tasks = orderedTasks(state);
  const anyStarted = tasks.some((t) => !editable(t));
  const ready = tasks.filter((t) => t.status === 'ready').length;

  const edit = async (ops: BoardEditOp[]) => {
    if (!id) return;
    setActionError('');
    try {
      accept(await api.editBoard(id, ops));
      setSelected([]);
    } catch (issue) {
      setActionError(message(issue, 'That edit was refused.'));
      void reload();
    }
  };

  const run = async () => {
    if (!id) return;
    setBusy(true);
    setActionError('');
    try {
      await api.runReadyTasks(id, { autoMergeGreen: autoMerge });
    } catch (issue) {
      setActionError(message(issue, 'Could not start the tasks.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!id) return;
    try {
      accept(await api.cancelBoard(id));
    } catch (issue) {
      setActionError(message(issue, 'Could not cancel the board.'));
    }
  };

  const toggle = (taskId: string) =>
    setSelected((s) => (s.includes(taskId) ? s.filter((x) => x !== taskId) : [...s, taskId]));

  const columns = useMemo(
    () => COLUMNS.map((c) => ({ ...c, tasks: tasks.filter((t) => c.statuses.includes(t.status)) })),
    [tasks],
  );

  if (error && !state.run) {
    return (
      <div className="library-empty">
        <h1>{error}</h1>
        <Link className="primary-button" to="/board">
          Plan a new change
        </Link>
      </div>
    );
  }

  return (
    <div className="library-page board-page">
      <header className="library-heading">
        <div>
          <h1>{state.run?.title ?? 'Loading board…'}</h1>
          <p>
            {tasks.length} task{tasks.length === 1 ? '' : 's'} · {state.waves.length} wave
            {state.waves.length === 1 ? '' : 's'} · board {state.run?.status ?? '…'}
            <span className={'board-live ' + (connected ? 'is-on' : '')}>
              {connected ? 'live' : 'reconnecting'}
            </span>
          </p>
        </div>
        <div className="board-actions">
          <label className="board-check">
            <input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} />
            Auto-merge green
          </label>
          <button className="primary-button" onClick={() => void run()} disabled={busy || ready === 0}>
            <Icon name="play" size={15} />
            Run ready tasks{ready ? ' (' + ready + ')' : ''}
          </button>
          {anyStarted && (
            <button className="secondary-button" onClick={() => void cancel()}>
              <Icon name="stop" size={15} />
              Cancel
            </button>
          )}
        </div>
      </header>

      {!anyStarted && tasks.length > 0 && (
        <div className="board-review-bar">
          <span>
            Review the plan. Nothing runs until you start it.
            {selected.length > 1 ? ' ' + selected.length + ' selected.' : ' Select two or more to merge.'}
          </span>
          <button
            className="secondary-button"
            disabled={selected.length < 2}
            onClick={() => void edit([{ op: 'merge', taskIds: selected }])}
          >
            Merge selected
          </button>
        </div>
      )}
      {actionError && <p className="board-error">{actionError}</p>}

      <div className="board-layout">
        <div className="board-columns">
          {columns.map((column) => (
            <section key={column.id} className="board-column" aria-label={column.title}>
              <h2>
                {column.title} <span>{column.tasks.length}</span>
              </h2>
              {column.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  all={state.tasks}
                  notes={state.notes[task.id] ?? []}
                  selected={selected.includes(task.id)}
                  onSelect={() => toggle(task.id)}
                  onMove={(delta) => {
                    const order = moved(state.order, task.id, delta);
                    if (order) void edit([{ op: 'reorder', order }]);
                  }}
                  onEdit={(ops) => void edit(ops)}
                  onResume={async () => {
                    if (!id) return;
                    try {
                      await api.resumeTask(id, task.id);
                    } catch (issue) {
                      setActionError(message(issue, 'Could not resume the task.'));
                    }
                  }}
                />
              ))}
            </section>
          ))}
        </div>
        <Inbox />
      </div>
    </div>
  );
}

function TaskCard({
  task,
  all,
  notes,
  selected,
  onSelect,
  onMove,
  onEdit,
  onResume,
}: {
  task: Task;
  all: Record<string, Task>;
  notes: string[];
  selected: boolean;
  onSelect: () => void;
  onMove: (delta: -1 | 1) => void;
  onEdit: (ops: BoardEditOp[]) => void;
  onResume: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'scope' | 'split'>('view');
  const canEdit = editable(task);
  const p = task.progress;

  return (
    <article className={'board-card is-' + task.status + (selected ? ' is-selected' : '')} data-task={task.id}>
      <header>
        {canEdit && (
          <input type="checkbox" aria-label={'Select ' + task.title} checked={selected} onChange={onSelect} />
        )}
        <h3>{task.title}</h3>
        <span className="board-status">{task.status}</span>
      </header>
      <p className="board-acceptance">{task.acceptance}</p>
      <ul className="board-scope" aria-label="Write scope">
        {task.writeScope.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
      {task.dependsOn.length > 0 && (
        <p className="board-meta">After: {task.dependsOn.map((d) => all[d]?.title ?? d).join(', ')}</p>
      )}
      {canEdit ? (
        <label className="board-pin">
          <span>{task.pinned ? 'Pinned to' : 'Assignee'}</span>
          <select
            value={task.pinned ? assigneeId(task.assignee) : 'auto'}
            onChange={(e) => {
              const choice = ASSIGNEES.find((a) => a.id === e.target.value);
              if (choice) onEdit([{ op: 'pin', taskId: task.id, assignee: choice.assignee }]);
            }}
          >
            {ASSIGNEES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="board-meta">{assigneeLabel(task.assignee)}</p>
      )}
      {p && (
        <p className="board-progress">
          {p.filesChanged} file{p.filesChanged === 1 ? '' : 's'} · tests {p.testsPassed}/{p.testsTotal} · {p.turns}{' '}
          turn{p.turns === 1 ? '' : 's'} · {p.tokens} tokens
        </p>
      )}
      {task.reason && (task.status === 'blocked' || task.status === 'failed') && (
        <p className="board-reason">{task.reason}</p>
      )}
      {notes.length > 0 && (
        <ul className="board-notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {mode === 'scope' && (
        <ScopeEditor
          initial={task.writeScope}
          onCancel={() => setMode('view')}
          onSave={(writeScope) => {
            setMode('view');
            onEdit([{ op: 'scope', taskId: task.id, writeScope }]);
          }}
        />
      )}
      {mode === 'split' && (
        <SplitEditor
          task={task}
          onCancel={() => setMode('view')}
          onSave={(parts) => {
            setMode('view');
            onEdit([{ op: 'split', taskId: task.id, parts }]);
          }}
        />
      )}

      <footer>
        {canEdit && mode === 'view' && (
          <>
            <button className="icon-button" aria-label="Move up" onClick={() => onMove(-1)}>
              ↑
            </button>
            <button className="icon-button" aria-label="Move down" onClick={() => onMove(1)}>
              ↓
            </button>
            <button className="secondary-button" onClick={() => setMode('scope')}>
              Edit scope
            </button>
            <button className="secondary-button" onClick={() => setMode('split')}>
              Split
            </button>
          </>
        )}
        {task.status === 'blocked' && (
          <button className="primary-button" onClick={onResume}>
            Resume
          </button>
        )}
        {task.runId && (
          <Link className="board-link" to={'/runs/' + task.runId}>
            Trace
          </Link>
        )}
      </footer>
    </article>
  );
}

function ScopeEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string[];
  onSave: (scope: string[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial.join('\n'));
  const scope = parseScope(text);
  return (
    <div className="board-editor">
      <label>
        Write scope, one glob per line
        <textarea rows={Math.max(2, scope.length + 1)} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div>
        <button className="primary-button" disabled={scope.length === 0} onClick={() => onSave(scope)}>
          Save scope
        </button>
        <button className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SplitEditor({
  task,
  onSave,
  onCancel,
}: {
  task: Task;
  onSave: (parts: Array<{ title: string; writeScope: string[] }>) => void;
  onCancel: () => void;
}) {
  const half = Math.ceil(task.writeScope.length / 2);
  const [parts, setParts] = useState([
    { title: task.title + ' (part 1)', scope: task.writeScope.slice(0, half).join('\n') },
    { title: task.title + ' (part 2)', scope: task.writeScope.slice(half).join('\n') },
  ]);
  const parsed = parts.map((p) => ({ title: p.title.trim(), writeScope: parseScope(p.scope) }));
  const valid = parsed.every((p) => p.title && p.writeScope.length > 0);
  const set = (i: number, key: 'title' | 'scope', value: string) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, [key]: value } : p)));
  return (
    <div className="board-editor">
      {parts.map((p, i) => (
        <fieldset key={i}>
          <legend>Part {i + 1}</legend>
          <input aria-label={'Part ' + (i + 1) + ' title'} value={p.title} onChange={(e) => set(i, 'title', e.target.value)} />
          <textarea
            aria-label={'Part ' + (i + 1) + ' write scope'}
            rows={2}
            value={p.scope}
            placeholder="src/feature/**"
            onChange={(e) => set(i, 'scope', e.target.value)}
          />
        </fieldset>
      ))}
      <div>
        <button className="secondary-button" onClick={() => setParts((ps) => [...ps, { title: task.title + ' (part ' + (ps.length + 1) + ')', scope: '' }])}>
          Add part
        </button>
        <button className="primary-button" disabled={!valid} onClick={() => onSave(parsed)}>
          Split
        </button>
        <button className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "Needs you": approvals, blocked tasks and lease extensions, oldest first. */
function Inbox() {
  const { items, connected } = useInbox();
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (issue) {
      setError(message(issue, 'That did not go through.'));
    }
  };
  return (
    <aside className="board-inbox" aria-label="Needs you">
      <h2>
        Needs you <span>{items.length}</span>
        <span className={'board-live ' + (connected ? 'is-on' : '')}>{connected ? 'live' : 'offline'}</span>
      </h2>
      {error && <p className="board-error">{error}</p>}
      {items.length === 0 && <p className="board-meta">Nothing is waiting on you.</p>}
      <ul>
        {items.map((item) => (
          <li key={inboxKey(item)} className={'board-inbox-item is-' + item.kind}>
            <InboxRow item={item} act={act} />
          </li>
        ))}
      </ul>
    </aside>
  );
}

function InboxRow({ item, act }: { item: InboxItem; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const when = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (item.kind === 'approval') {
    const a = item.approval;
    return (
      <>
        <p className="board-inbox-kind">Approval · {when}</p>
        <p>{a.question}</p>
        <p className="board-meta">{a.policyRule} · {a.riskClass}</p>
        <div>
          <button className="primary-button" onClick={() => void act(() => api.decide(a.id, { decision: 'approved' }))}>
            Approve
          </button>
          <button className="secondary-button" onClick={() => void act(() => api.decide(a.id, { decision: 'rejected' }))}>
            Reject
          </button>
          {item.boardRunId && (
            <Link className="board-link" to={'/board/' + item.boardRunId}>
              Board
            </Link>
          )}
        </div>
      </>
    );
  }
  if (item.kind === 'blocked_task') {
    return (
      <>
        <p className="board-inbox-kind">Blocked · {when}</p>
        <p>
          <strong>{item.title}</strong>: {item.reason}
        </p>
        <div>
          <button className="primary-button" onClick={() => void act(() => api.resumeTask(item.boardRunId, item.taskId))}>
            Resume
          </button>
          <Link className="board-link" to={'/board/' + item.boardRunId}>
            Board
          </Link>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="board-inbox-kind">Wider lease · {when}</p>
      <p>
        {item.request.globs.join(', ')}
        {item.request.blockedBy.length > 0 && ' (held by ' + item.request.blockedBy.length + ' task(s))'}
      </p>
      <div>
        <button
          className="primary-button"
          onClick={() => void act(() => api.decideExtension(item.boardRunId, item.request.id, 'approve'))}
        >
          Approve
        </button>
        <button
          className="secondary-button"
          onClick={() => void act(() => api.decideExtension(item.boardRunId, item.request.id, 'reject'))}
        >
          Reject
        </button>
      </div>
    </>
  );
}
