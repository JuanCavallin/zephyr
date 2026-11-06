/**
 * `zephyr run "<task>"`: create a board over the HTTP API and, unless `--plan`, start it.
 * Same routes the board UI uses; the CLI holds no state of its own.
 */

import type { Task, TaskTemplateId } from '@htn/shared';
import type { ApiClient } from './api.js';

export interface BoardViewLite {
  run: { id: string; status: string };
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'writeScope' | 'dependsOn'>[];
  waves?: string[][];
}

export interface RunOptions {
  request: string;
  template?: TaskTemplateId;
  concurrency?: number;
  plan?: boolean;
  private?: boolean;
  base?: string;
  autoMergeGreen?: boolean;
  /** Build 2 or 3 variants of every task; a person picks one before it merges. */
  variants?: number;
  /** When every task merged: push the integration branch, and open a PR for 'pr'. */
  publish?: 'branch' | 'pr';
}

export interface RunResult {
  board: BoardViewLite;
  started: boolean;
}

export async function runTask(api: ApiClient, o: RunOptions): Promise<RunResult> {
  let board = await api.post<BoardViewLite>('/api/tasks', {
    request: o.request,
    ...(o.template ? { template: o.template } : {}),
    ...(o.private ? { private: true } : {}),
    ...(o.base ? { base: o.base } : {}),
    ...(o.publish ? { publish: o.publish } : {}),
  });
  // One atomic edit before anything runs, the same op the board's "Build" selector sends.
  if (o.variants && o.variants > 1 && board.tasks.length)
    board = await api.patch<BoardViewLite>(`/api/tasks/${encodeURIComponent(board.run.id)}`, {
      ops: board.tasks.map((t) => ({ op: 'update', taskId: t.id, variants: o.variants })),
    });
  if (o.plan) return { board, started: false };
  // Only send what the user set: the template's own concurrency and auto-merge stand otherwise.
  const started = await api.post<BoardViewLite>(`/api/tasks/${encodeURIComponent(board.run.id)}/run`, {
    ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
    ...(o.autoMergeGreen !== undefined ? { autoMergeGreen: o.autoMergeGreen } : {}),
  });
  return { board: started, started: true };
}

export type BoardOutcome = 'succeeded' | 'failed' | 'cancelled' | 'needs-you' | 'timeout';

export interface WaitOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** Called with one line per task status change. */
  onChange?: (line: string) => void;
  signal?: AbortSignal;
}

const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled']);

/** One "Needs you" entry; only the board it belongs to matters here. */
interface InboxItemLite {
  kind: string;
  boardRunId?: string;
  taskId?: string;
}

/**
 * Follow a board until it ends, or until nothing can move without a person: no task is
 * ready or running and the inbox holds something for this board (a merge approval, a
 * variant pick, a blocked task, a lease extension). A task in review alone is not enough: review also
 * covers a merge still running its tests and a task waiting on its fix task.
 */
export async function waitForBoard(
  api: ApiClient,
  boardId: string,
  o: WaitOptions = {},
): Promise<{ outcome: BoardOutcome; board: BoardViewLite }> {
  const pollMs = o.pollMs ?? 1_000;
  const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000);
  const seen = new Map<string, string>();
  for (;;) {
    const board = await api.get<BoardViewLite>(`/api/tasks/${encodeURIComponent(boardId)}`);
    for (const t of board.tasks) {
      if (seen.get(t.id) !== t.status) {
        seen.set(t.id, t.status);
        o.onChange?.(`  ${t.status.padEnd(8)} ${t.title}`);
      }
    }
    if (TERMINAL_RUN.has(board.run.status)) return { outcome: board.run.status as BoardOutcome, board };
    const running = new Set(board.tasks.filter((t) => t.status === 'running').map((t) => t.id));
    const moving = running.size > 0 || board.tasks.some((t) => t.status === 'ready');
    if (moving) {
      // A running task that asked for an approval (a harness tool call) is not moving:
      // it waits on the person, so say so instead of sitting here until the timeout.
      if (running.size) {
        const { items } = await api.get<{ items: InboxItemLite[] }>('/api/tasks/inbox');
        if (items.some((i) => i.kind === 'approval' && i.boardRunId === boardId && i.taskId && running.has(i.taskId)))
          return { outcome: 'needs-you', board };
      }
    } else {
      const { items } = await api.get<{ items: InboxItemLite[] }>('/api/tasks/inbox');
      if (items.some((i) => i.boardRunId === boardId)) return { outcome: 'needs-you', board };
    }
    if (Date.now() >= deadline) return { outcome: 'timeout', board };
    if (o.signal?.aborted) return { outcome: 'timeout', board };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function formatBoard(r: RunResult, webBase: string): string {
  const { board } = r;
  const lines = [`Board ${board.run.id}: ${board.tasks.length} task${board.tasks.length === 1 ? '' : 's'}`];
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const waves = board.waves?.length ? board.waves : [board.tasks.map((t) => t.id)];
  waves.forEach((wave, i) => {
    if (waves.length > 1) lines.push(`  wave ${i + 1}`);
    for (const id of wave) {
      const t = byId.get(id);
      if (!t) continue;
      const scope = t.writeScope.length ? `  [${t.writeScope.slice(0, 3).join(', ')}${t.writeScope.length > 3 ? ', …' : ''}]` : '';
      lines.push(`    ${t.status.padEnd(8)} ${t.title}${scope}`);
    }
  });
  lines.push(r.started ? 'Started. Approvals and blocked tasks show up under "Needs you".' : 'Planned only (--plan): review and start it on the board.');
  lines.push(`${webBase.replace(/\/+$/, '')}/board/${encodeURIComponent(board.run.id)}`);
  return lines.join('\n');
}
