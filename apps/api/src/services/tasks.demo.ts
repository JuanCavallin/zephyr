/**
 * Seeded fake board (step 1, milestone M1): three tasks that move through
 * pending → ready → running → review → done on a timer, driven entirely by mocks
 * (mock router, allow-all lease bridge, scripted mockharness). Every transition is a
 * `task.*` / `lease.*` / `harness.turn.ended` event on the board run, so the board UI
 * can be built against the real SSE stream before any real stream exists.
 *
 * Dev only; nothing here is reachable when `config.isDev` is false.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toRepoPath,
  type Assignee,
  type LeaseMode,
  type ProviderCallContext,
  type Run,
  type RunEvent,
  type Task,
  type TaskStatus,
} from '@htn/shared';
import type { RunBus } from '../core/bus.js';
import { createMockLeaseBridge } from '../core/coordination/leases.mock.js';
import { createMockRouter } from '../core/decisions/routing.mock.js';
import { mockEvidenceBundle } from '../core/verify/evidence.mock.js';
import { newId, nowIso } from '../lib/ids.js';
import { createMockHarness, type MockHarnessStep } from '../providers/mockharness/index.js';
import type { Store } from '../store/types.js';

export const DEMO_BOARD_KIND = 'task_board';

export interface DemoBoardDeps {
  bus: RunBus;
  store: Store;
  /** Delay between board ticks. Each tick advances every task by at most one stage. */
  tickMs: number;
}

export interface DemoBoard {
  run: Run;
  tasks: Task[];
  /** Resolves when every task is done (or the board failed). */
  finished: Promise<Run>;
}

interface Seed {
  title: string;
  acceptance: string;
  writeScope: string[];
  dependsOn: number[];
}

const SEEDS: Seed[] = [
  {
    title: 'Add rate-limit middleware',
    acceptance: 'Requests over the limit get 429; unit tests cover the window.',
    writeScope: ['src/middleware/rateLimit.ts'],
    dependsOn: [],
  },
  {
    title: 'Add rate-limit config',
    acceptance: 'Limit and window are read from config with sane defaults.',
    writeScope: ['src/config/rateLimit.ts'],
    dependsOn: [],
  },
  {
    title: 'Wire the limiter into the server',
    acceptance: 'Every /api route is limited; health check is exempt.',
    writeScope: ['src/server.ts', 'src/routes.ts', 'test/rateLimit.test.ts'],
    dependsOn: [0, 1],
  },
];

const CANDIDATES: Assignee[] = [
  { kind: 'agent', harness: 'mockharness', tier: 'cheap' },
  { kind: 'agent', harness: 'mockharness', tier: 'standard' },
];

function scriptFor(task: Task): MockHarnessStep[] {
  const first = task.writeScope[0];
  const steps: MockHarnessStep[] = [];
  for (const path of task.writeScope) {
    steps.push({ tool: 'Write', path, content: '// ' + task.title + '\nexport const ready = false;\n' });
  }
  if (first) steps.push({ tool: 'Edit', path: first, find: 'ready = false', replace: 'ready = true' });
  steps.push({ tool: 'Bash', command: 'pnpm test' });
  return steps;
}

/** Map a harness tool to the lease mode and path it touches, if any. */
function leaseTouch(toolName: string, rawInput: unknown): { path: string; mode: LeaseMode } | null {
  const path = (rawInput as { path?: unknown } | null)?.path;
  if (typeof path !== 'string') return null;
  return { path, mode: toolName === 'Read' ? 'read' : 'write' };
}

export async function startDemoBoard(deps: DemoBoardDeps): Promise<DemoBoard> {
  const { bus, store, tickMs } = deps;
  const createdAt = nowIso();
  let run = await store.createRun({
    id: newId('run'),
    kind: DEMO_BOARD_KIND,
    title: 'Demo board: rate limiting',
    status: 'running',
    input: { demo: true, tasks: SEEDS.length },
    createdAt,
    updatedAt: createdAt,
  });
  const emit = (event: RunEvent) => bus.emit(run.id, event);
  await emit({ type: 'run.updated', run });

  const workspaceDir = await mkdtemp(join(tmpdir(), 'zephyr-demo-board-'));
  const leases = createMockLeaseBridge();
  const router = createMockRouter();
  const harness = createMockHarness({
    async decide(req) {
      const touch = leaseTouch(req.toolName, req.rawInput);
      if (!touch) return 'allow';
      const path = toRepoPath(touch.path);
      if (!path || !req.taskId) return 'deny';
      const decision = leases.checkLease(req.taskId, path, touch.mode);
      if (!decision.allowed) {
        await emit({
          type: 'lease.denied',
          taskId: req.taskId,
          path,
          mode: touch.mode,
          reason: decision.reason,
          at: nowIso(),
        });
      }
      return decision.allowed ? 'allow' : 'deny';
    },
  });
  const ctx: ProviderCallContext = { runId: run.id, policyRule: 'demo-board:mock' };

  const ids = SEEDS.map(() => newId('task'));
  const tasks: Task[] = SEEDS.map((seed, i) => ({
    id: ids[i]!,
    boardRunId: run.id,
    title: seed.title,
    acceptance: seed.acceptance,
    writeScope: seed.writeScope,
    dependsOn: seed.dependsOn.map((d) => ids[d]!),
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
  }));
  for (const task of tasks) await emit({ type: 'task.created', task: { ...task } });

  /** Board-task id → mockharness session id and lease id. */
  const sessions = new Map<string, { session: string; leaseId: string; turns: number }>();

  async function setStatus(task: Task, to: TaskStatus, extra: { reason?: string } = {}) {
    const from = task.status;
    task.status = to;
    task.updatedAt = nowIso();
    if (extra.reason) task.reason = extra.reason;
    await emit({
      type: 'task.status',
      taskId: task.id,
      from,
      to,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(to === 'running' && task.assignee ? { assignee: task.assignee } : {}),
      at: task.updatedAt,
    });
  }

  async function advance(task: Task): Promise<void> {
    switch (task.status) {
      case 'pending': {
        const blockers = task.dependsOn.filter((d) => tasks.find((t) => t.id === d)?.status !== 'done');
        if (blockers.length === 0) await setStatus(task, 'ready');
        return;
      }
      case 'ready': {
        task.assignee = await router.routeTask(task, CANDIDATES);
        const grantedAt = nowIso();
        const lease = {
          id: newId('lease'),
          taskId: task.id,
          mode: 'write' as const,
          globs: task.writeScope,
          grantedAt,
          expiresAt: new Date(Date.parse(grantedAt) + 30 * 60_000).toISOString(),
        };
        await emit({ type: 'lease.granted', lease });
        const started = await harness.startTask(
          { goal: task.title, context: { workspaceDir, script: scriptFor(task), taskId: task.id } },
          ctx,
        );
        if (!started.ok) throw new Error(started.error.message);
        sessions.set(task.id, { session: started.data.taskId, leaseId: lease.id, turns: 0 });
        task.runId = run.id;
        task.branch = 'zephyr/' + task.id;
        await setStatus(task, 'running');
        return;
      }
      case 'running': {
        const s = sessions.get(task.id)!;
        const polled = await harness.pollTask(s.session, ctx);
        if (!polled.ok) throw new Error(polled.error.message);
        s.turns++;
        const partial = polled.data.partial as { filesChanged: string[] };
        const done = polled.data.status !== 'running';
        task.progress = {
          testsPassed: done ? 3 : 0,
          testsTotal: 3,
          filesChanged: partial.filesChanged.length,
          tokens: s.turns * 1200,
          turns: s.turns,
        };
        await emit({ type: 'task.progress', taskId: task.id, progress: { ...task.progress }, at: nowIso() });
        if (!done) return;
        const at = nowIso();
        await emit({
          type: 'harness.turn.ended',
          runId: run.id,
          sessionId: s.session,
          turnId: s.session + ':turn',
          harness: 'mockharness',
          stopReason: polled.data.status === 'done' ? 'end_turn' : 'error',
          taskId: task.id,
          at,
        });
        await emit({ type: 'lease.expired', leaseId: s.leaseId, taskId: task.id, at });
        if (polled.data.status === 'done') await setStatus(task, 'review');
        else await setStatus(task, 'failed', { reason: polled.data.log?.at(-1) ?? 'harness failed' });
        return;
      }
      case 'review':
        await setStatus(task, 'done');
        return;
      default:
        return;
    }
  }

  async function finish(status: Run['status'], summary: string): Promise<Run> {
    await harness.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
    const evidence = tasks
      .filter((t) => t.status === 'done')
      .map((t) => mockEvidenceBundle({ runId: run.id, taskId: t.id, files: t.writeScope }));
    run = await store.patchRun(run.id, {
      status,
      summary,
      result: { tasks: tasks.map((t) => ({ ...t })), evidence },
      updatedAt: nowIso(),
    });
    await emit({ type: 'run.updated', run });
    return run;
  }

  const finished = new Promise<Run>((resolve) => {
    const tick = async () => {
      try {
        for (const task of tasks) await advance(task);
        const terminal = tasks.every((t) => t.status === 'done' || t.status === 'failed');
        if (!terminal) {
          setTimeout(tick, tickMs).unref();
          return;
        }
        const failed = tasks.filter((t) => t.status === 'failed').length;
        resolve(
          await finish(
            failed ? 'failed' : 'succeeded',
            failed ? failed + ' of ' + tasks.length + ' tasks failed' : 'All ' + tasks.length + ' tasks done',
          ),
        );
      } catch (err) {
        await emit({
          type: 'log',
          runId: run.id,
          level: 'error',
          message: 'demo board: ' + (err as Error).message,
          at: nowIso(),
        }).catch(() => undefined);
        resolve(
          await finish('failed', 'Demo board crashed: ' + (err as Error).message).catch(() => run),
        );
      }
    };
    setTimeout(tick, tickMs).unref();
  });

  return { run, tasks: tasks.map((t) => ({ ...t })), finished };
}
