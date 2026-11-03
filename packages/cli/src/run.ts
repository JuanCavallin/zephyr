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
}

export interface RunResult {
  board: BoardViewLite;
  started: boolean;
}

export async function runTask(api: ApiClient, o: RunOptions): Promise<RunResult> {
  const board = await api.post<BoardViewLite>('/api/tasks', {
    request: o.request,
    ...(o.template ? { template: o.template } : {}),
    ...(o.private ? { private: true } : {}),
    ...(o.base ? { base: o.base } : {}),
  });
  if (o.plan) return { board, started: false };
  // Only send what the user set: the template's own concurrency and auto-merge stand otherwise.
  const started = await api.post<BoardViewLite>(`/api/tasks/${encodeURIComponent(board.run.id)}/run`, {
    ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
    ...(o.autoMergeGreen !== undefined ? { autoMergeGreen: o.autoMergeGreen } : {}),
  });
  return { board: started, started: true };
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
