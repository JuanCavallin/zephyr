/**
 * Task board state (docs/cacp-07-task-board.md). Pure: the hook feeds it the
 * GET /api/tasks/:boardId snapshot and then the task.* events from the board run's
 * stream, and each event touches one card only, so cards update independently.
 */

import type { Approval, Assignee, Run, Task, TaskProgress, TaskStatus } from '@htn/shared';

export interface BoardSnapshot {
  run: Run;
  tasks: Task[];
  waves: string[][];
}

/** Mirrors the API's edit ops (PATCH /api/tasks/:boardId). */
export type BoardEditOp =
  | { op: 'split'; taskId: string; parts: Array<{ title: string; acceptance?: string; writeScope: string[] }> }
  | { op: 'merge'; taskIds: string[]; title?: string; acceptance?: string }
  | { op: 'reorder'; order: string[] }
  | { op: 'scope'; taskId: string; writeScope: string[] }
  | { op: 'update'; taskId: string; title?: string; acceptance?: string; dependsOn?: string[]; variants?: number | null }
  | { op: 'pin'; taskId: string; assignee: Assignee | null };

export interface BoardState {
  run: Run | null;
  /** Board order. Cards render in this order inside each column. */
  order: string[];
  tasks: Record<string, Task>;
  waves: string[][];
  /** Recent lease denials and merge outcomes, newest last, per task. */
  notes: Record<string, string[]>;
}

export const emptyBoard: BoardState = { run: null, order: [], tasks: {}, waves: [], notes: {} };

/** The events the board reacts to. Anything else on the stream is ignored. */
export type BoardEvent =
  | { type: 'snapshot'; board: BoardSnapshot }
  | { type: 'run.updated'; run: Run }
  | { type: 'task.created'; task: Task }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.removed'; taskId: string; at: string }
  | { type: 'task.status'; taskId: string; from?: TaskStatus; to: TaskStatus; reason?: string; assignee?: Assignee; at: string }
  | { type: 'task.progress'; taskId: string; progress: TaskProgress; at: string }
  | { type: 'lease.denied'; taskId: string; path: string; reason: string; heldBy?: string; at: string }
  | { type: 'merge.result'; taskId: string; outcome: string; detail?: string; fixTaskId?: string };

const NOTE_LIMIT = 4;

function note(state: BoardState, taskId: string, text: string): BoardState {
  const list = [...(state.notes[taskId] ?? []), text].slice(-NOTE_LIMIT);
  return { ...state, notes: { ...state.notes, [taskId]: list } };
}

function patch(state: BoardState, taskId: string, fn: (t: Task) => Task): BoardState {
  const task = state.tasks[taskId];
  if (!task) return state;
  return { ...state, tasks: { ...state.tasks, [taskId]: fn(task) } };
}

export function boardReducer(state: BoardState, event: BoardEvent | { type: string }): BoardState {
  const e = event as BoardEvent;
  switch (e.type) {
    case 'snapshot': {
      const tasks: Record<string, Task> = {};
      for (const t of e.board.tasks) tasks[t.id] = t;
      // Events may have arrived before the snapshot: keep any task the snapshot lacks.
      const extra = state.order.filter((id) => !tasks[id] && state.tasks[id]);
      for (const id of extra) tasks[id] = state.tasks[id];
      return {
        ...state,
        run: e.board.run,
        tasks,
        order: [...e.board.tasks.map((t) => t.id), ...extra],
        waves: e.board.waves,
      };
    }
    case 'run.updated':
      return state.run && e.run.id !== state.run.id ? state : { ...state, run: e.run };
    case 'task.created':
    case 'task.updated': {
      const known = e.task.id in state.tasks;
      return {
        ...state,
        tasks: { ...state.tasks, [e.task.id]: e.task },
        order: known ? state.order : [...state.order, e.task.id],
      };
    }
    case 'task.removed': {
      if (!(e.taskId in state.tasks)) return state;
      const { [e.taskId]: _gone, ...tasks } = state.tasks;
      return {
        ...state,
        tasks,
        order: state.order.filter((id) => id !== e.taskId),
        waves: state.waves.map((w) => w.filter((id) => id !== e.taskId)).filter((w) => w.length),
      };
    }
    case 'task.status':
      return patch(state, e.taskId, (t) => ({
        ...t,
        status: e.to,
        updatedAt: e.at,
        ...(e.assignee ? { assignee: e.assignee } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
      }));
    case 'task.progress':
      return patch(state, e.taskId, (t) => ({ ...t, progress: e.progress, updatedAt: e.at }));
    case 'lease.denied':
      return note(state, e.taskId, 'denied ' + e.path + ' (' + e.reason.replace(/_/g, ' ') + ')');
    case 'merge.result':
      return note(
        state,
        e.taskId,
        e.outcome.replace(/_/g, ' ') + (e.detail ? ': ' + e.detail : '') + (e.fixTaskId ? ' -> fix task' : ''),
      );
    default:
      return state;
  }
}

/** Board order with the board's tasks only, for rendering. */
export function orderedTasks(state: BoardState): Task[] {
  return state.order.map((id) => state.tasks[id]).filter((t): t is Task => Boolean(t));
}

export const COLUMNS: Array<{ id: string; title: string; statuses: TaskStatus[] }> = [
  { id: 'todo', title: 'To do', statuses: ['pending', 'ready'] },
  { id: 'running', title: 'Running', statuses: ['running'] },
  { id: 'review', title: 'In review', statuses: ['review'] },
  { id: 'done', title: 'Done', statuses: ['done'] },
  { id: 'stuck', title: 'Needs attention', statuses: ['blocked', 'failed'] },
];

/** Review is only possible while nothing has started. */
export function editable(task: Task): boolean {
  return task.status === 'pending' || task.status === 'ready';
}

/** Move one task up or down in the board order, as a `reorder` op. */
export function moved(order: string[], taskId: string, delta: -1 | 1): string[] | null {
  const at = order.indexOf(taskId);
  const to = at + delta;
  if (at === -1 || to < 0 || to >= order.length) return null;
  const next = [...order];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** One write-scope glob per line or comma. */
export function parseScope(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The pin options. `null` is "let Zephyr route it". */
export const ASSIGNEES: Array<{ id: string; label: string; assignee: Assignee | null }> = [
  { id: 'auto', label: 'Route automatically', assignee: null },
  { id: 'claudecode-standard', label: 'Claude Code (standard)', assignee: { kind: 'agent', harness: 'claudecode', tier: 'standard' } },
  { id: 'claudecode-frontier', label: 'Claude Code (frontier)', assignee: { kind: 'agent', harness: 'claudecode', tier: 'frontier' } },
  { id: 'codex-standard', label: 'Codex (standard)', assignee: { kind: 'agent', harness: 'codex', tier: 'standard' } },
  { id: 'hermes-local', label: 'Hermes (local)', assignee: { kind: 'agent', harness: 'hermes', tier: 'local' } },
  { id: 'mockharness-cheap', label: 'Mock harness (cheap)', assignee: { kind: 'agent', harness: 'mockharness', tier: 'cheap' } },
  { id: 'human', label: 'A person', assignee: { kind: 'human' } },
];

export function assigneeId(a: Assignee | undefined): string {
  if (!a) return 'auto';
  if (a.kind === 'human') return 'human';
  return a.harness + '-' + a.tier;
}

export function assigneeLabel(a: Assignee | undefined): string {
  if (!a) return 'Unassigned';
  if (a.kind === 'human') return 'A person';
  return a.harness + ' · ' + a.tier + (a.model ? ' · ' + a.model : '');
}

/* ---------------------------------------------------------------- Inbox */

export interface ExtensionRequest {
  id: string;
  taskId: string;
  globs: string[];
  blockedBy: string[];
  requestedAt: string;
}

export type InboxItem =
  | { kind: 'approval'; at: string; boardRunId?: string; taskId?: string; approval: Approval }
  | { kind: 'blocked_task'; at: string; boardRunId: string; taskId: string; title: string; reason: string }
  | { kind: 'lease_extension'; at: string; boardRunId: string; taskId: string; request: ExtensionRequest }
  | { kind: 'variant_pick'; at: string; boardRunId: string; taskId: string; title: string; variants: PendingVariant[] };

/** One built variant of a task, waiting for a person to pick it (spec §11). */
export interface PendingVariant {
  id: string;
  label: string;
  branch: string;
  filesChanged: number;
  files: string[];
}

/** A pending pick as the picker's choices: its label, and the files it changed as the preview. */
export function variantChoices(variants: PendingVariant[]): Array<{ id: string; label: string; preview?: string }> {
  return variants.map((v) => {
    const shown = v.files.slice(0, 8);
    const more = v.files.length - shown.length;
    const preview = shown.join('\n') + (more > 0 ? '\n+' + more + ' more' : '');
    return { id: v.id, label: v.label, ...(preview ? { preview } : {}) };
  });
}

export function inboxKey(item: InboxItem): string {
  if (item.kind === 'approval') return 'approval:' + item.approval.id;
  if (item.kind === 'blocked_task') return 'blocked:' + item.taskId;
  if (item.kind === 'variant_pick') return 'pick:' + item.taskId;
  return 'extension:' + item.request.id;
}

/**
 * The header's "Needs you" chip: how many things wait on a person, what they are, and
 * where to go. A single item links straight to it; several go to the board's inbox.
 */
export function needsYou(items: InboxItem[]): { count: number; label: string; to: string } | null {
  if (items.length === 0) return null;
  const counts = { approval: 0, blocked_task: 0, lease_extension: 0, variant_pick: 0 };
  for (const item of items) counts[item.kind]++;
  const parts = [
    counts.approval && `${counts.approval} approval${counts.approval === 1 ? '' : 's'}`,
    counts.blocked_task && `${counts.blocked_task} blocked`,
    counts.lease_extension && `${counts.lease_extension} scope request${counts.lease_extension === 1 ? '' : 's'}`,
    counts.variant_pick && `${counts.variant_pick} pick${counts.variant_pick === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const only = items.length === 1 ? items[0]! : undefined;
  const to = !only
    ? '/board'
    : only.boardRunId
      ? '/board/' + only.boardRunId
      : only.kind === 'approval'
        ? '/runs/' + only.approval.runId
        : '/board';
  return { count: items.length, label: parts.join(' · '), to };
}
