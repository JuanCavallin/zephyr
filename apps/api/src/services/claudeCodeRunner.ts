/**
 * Claude Code in a worktree someone else opened: a board task's, or a graph
 * `coding_task` node's. One helper for both, so start, poll, budget and teardown
 * behave the same everywhere.
 *
 * The caller owns the worktree (opens it, commits or merges it, closes it); this
 * module only runs Claude Code in it. Every native tool call still goes through the
 * permission bridge, and a board task's bridge enforces its write lease.
 */

import type { Json, PermissionBridgeSeam, ProviderCallContext, Task } from '@htn/shared';
import { z } from 'zod';
import { config } from '../config.js';
import type { IntentSubmission } from '../core/coordination/integrator.js';
import type { Exec } from '../core/verify/publish.js';
import {
  createClaudeCodeRuntime,
  liveClaudeCodeDeps,
  type AttachedWorkspace,
  type ClaudeCodeRuntime,
  type ClaudeCodeRuntimeDeps,
} from '../providers/claudecode/live.js';
import { execArgv } from './publish.service.js';
import type { TaskExecutor } from './tasks.service.js';

/** A runtime whose tasks run in worktrees registered in `attachments`. */
export interface AttachableClaudeCode {
  runtime: ClaudeCodeRuntime;
  attachments: Map<string, AttachedWorkspace>;
}

const attachKey = (runId: string, stepId: string | undefined) => runId + '/' + (stepId ?? '');

export function createAttachableClaudeCode(deps: Omit<ClaudeCodeRuntimeDeps, 'attach'>): AttachableClaudeCode {
  const attachments = new Map<string, AttachedWorkspace>();
  const runtime = createClaudeCodeRuntime({
    ...deps,
    attach: (runId, stepId) => attachments.get(attachKey(runId, stepId)),
  });
  return { runtime, attachments };
}

let shared: AttachableClaudeCode | undefined;

/** The process-wide live runtime. Throws when Claude Code is not configured live. */
export function sharedClaudeCode(): AttachableClaudeCode {
  if (shared) return shared;
  const cfg = config.providers.claudecode;
  if (cfg.mode !== 'live') throw new Error('Claude Code is not live: set CLAUDECODE_MODE=live and CLAUDECODE_BINARY');
  shared = createAttachableClaudeCode({
    ...liveClaudeCodeDeps(cfg),
    // The caller here is Zephyr itself (a board or a graph node), not an untrusted
    // client, and api-mode model access is a per-run gateway token minted in
    // startTask. Subscription mode never needs a gateway binding.
    requireGatewayCredentials: false,
  });
  return shared;
}

export interface WorktreeRunInput {
  /** The run approvals, hooks and events belong to; its step must exist. */
  runId: string;
  stepId: string;
  workspace: { runId: string; path: string; branch: string };
  goal: string;
  /** Board task: writes must fall inside this task's lease. */
  taskId?: string;
  leases?: PermissionBridgeSeam;
  signal: AbortSignal;
  /** Default 30 minutes. */
  timeoutMs?: number;
  /** Default 1000 ms. */
  pollMs?: number;
  /** Called after every poll. What it throws (a budget breach) propagates after teardown. */
  onPoll?: () => Promise<void>;
  policyRule?: string;
}

export interface WorktreeRunResult {
  status: 'done' | 'failed';
  /** Claude Code's last message. */
  text: string;
  detail?: string;
  toolCalls: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Start Claude Code in the worktree, poll it to the end, and always tear it down. */
export async function runClaudeCodeInWorktree(
  cc: AttachableClaudeCode,
  input: WorktreeRunInput,
): Promise<WorktreeRunResult> {
  const key = attachKey(input.runId, input.stepId);
  if (cc.attachments.has(key)) throw new Error('Claude Code is already running for step ' + input.stepId);
  cc.attachments.set(key, {
    path: input.workspace.path,
    branch: input.workspace.branch,
    workspaceRunId: input.workspace.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.leases ? { leases: input.leases } : {}),
  });
  // The task's own signal: aborted at teardown, so a permission request still waiting
  // on a person ends (and its approval expires) with the task, not with the run.
  const task = new AbortController();
  const ctx: ProviderCallContext = {
    runId: input.runId,
    stepId: input.stepId,
    policyRule: input.policyRule ?? 'claudecode:worktree',
    signal: AbortSignal.any([input.signal, task.signal]),
  };
  const failed = (detail: string, toolCalls = 0): WorktreeRunResult => ({ status: 'failed', text: '', detail, toolCalls });
  let taskId: string | undefined;
  try {
    if (input.signal.aborted) return failed('cancelled');
    const started = await cc.runtime.startTask({ goal: input.goal, tools: [] }, ctx);
    if (!started.ok) return failed('could not start Claude Code: ' + started.error.message);
    taskId = started.data.taskId;
    const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (;;) {
      if (input.signal.aborted) return failed('cancelled');
      if (Date.now() > deadline) return failed('timed out after ' + Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000) + ' min');
      const polled = await cc.runtime.pollTask(taskId, ctx);
      if (!polled.ok) return failed(polled.error.message);
      const toolCalls = polled.data.toolCalls?.length ?? 0;
      await input.onPoll?.();
      if (polled.data.status === 'done') {
        const text = (polled.data.result as { text?: string } | undefined)?.text ?? '';
        return { status: 'done', text, toolCalls };
      }
      if (polled.data.status === 'failed') return failed(polled.data.log?.at(-1) ?? 'Claude Code failed', toolCalls);
      await pause(input.pollMs ?? 1_000, input.signal);
    }
  } finally {
    task.abort();
    cc.attachments.delete(key);
    // Not on the run's signal: teardown must still happen after the run is aborted.
    const teardown: ProviderCallContext = { runId: ctx.runId, stepId: input.stepId, policyRule: ctx.policyRule };
    if (taskId) await cc.runtime.cancelTask(taskId, teardown).catch(() => undefined);
  }
}

/** Paths `git status` reports changed in a worktree; empty when git cannot say. */
export async function changedFiles(worktree: string, exec: Exec = execArgv): Promise<string[]> {
  const r = await exec('git', ['status', '--porcelain', '-uall'], { cwd: worktree }).catch(() => undefined);
  if (!r || r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** What a board task asks Claude Code. The title is the first line. */
export function boardTaskPrompt(task: Pick<Task, 'title' | 'acceptance' | 'writeScope'>): string {
  return [
    task.title,
    '',
    ...(task.acceptance ? ['Done when: ' + task.acceptance, ''] : []),
    'Change files only inside: ' + task.writeScope.join(', ') + '. Writes anywhere else are denied.',
    'Run the tests you add. Do not commit, push or switch branches: Zephyr commits and merges your work.',
    '',
    'Shared files (barrels such as src/index.js, package.json) are never yours to edit. When the task',
    'needs one changed, end your final message with one line per change: the word ZEPHYR_INTENT, a',
    'space, then one JSON object on the same line. Zephyr applies it for you. The two kinds:',
    '  {"kind":"export_symbol","path":"src/index.js","payload":{"from":"./math.js","symbols":["clamp"]},"description":"export clamp"}',
    '  {"kind":"add_dependency","path":"package.json","payload":{"name":"zod","version":"^3.23.0"},"description":"add zod"}',
  ].join('\n');
}

const INTENT_LINE = /^\s*ZEPHYR_INTENT\s+(\{.*\})\s*$/;

const intentLineSchema = z.object({
  kind: z.enum(['export_symbol', 'add_dependency']),
  path: z.string().min(1).max(500),
  description: z.string().min(1).max(300),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * The hot-file intents in Claude Code's final message. Every `ZEPHYR_INTENT` line
 * must parse: a malformed one is returned as an error, never skipped, so an
 * export the task was asked for cannot vanish without a trace.
 */
export function parseIntents(text: string): { intents: Omit<IntentSubmission, 'taskId'>[]; errors: string[] } {
  const intents: Omit<IntentSubmission, 'taskId'>[] = [];
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*ZEPHYR_INTENT\b/.test(line)) continue;
    const json = INTENT_LINE.exec(line)?.[1];
    let parsed: unknown;
    try {
      parsed = json ? JSON.parse(json) : undefined;
    } catch {
      parsed = undefined;
    }
    const r = intentLineSchema.safeParse(parsed);
    if (!r.success) {
      errors.push('malformed ZEPHYR_INTENT line: ' + line.trim().slice(0, 200));
      continue;
    }
    intents.push({ ...r.data, payload: r.data.payload as Json });
  }
  return { intents, errors };
}

/** The board's executor on live Claude Code. */
export function claudeCodeExecutor(
  opts: { claudeCode?: () => AttachableClaudeCode; pollMs?: number; timeoutMs?: number; exec?: Exec } = {},
): TaskExecutor {
  return async (ctx) => {
    const cc = (opts.claudeCode ?? sharedClaudeCode)();
    const result = await runClaudeCodeInWorktree(cc, {
      runId: ctx.taskRunId,
      stepId: ctx.stepId,
      workspace: { runId: ctx.workspaceRunId, path: ctx.worktree, branch: ctx.branch },
      goal: boardTaskPrompt(ctx.task),
      taskId: ctx.task.id,
      leases: ctx.leases,
      signal: ctx.signal,
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      policyRule: 'board-task:claudecode',
      onPoll: async () => {
        ctx.tracker.observeFiles(await changedFiles(ctx.worktree, opts.exec));
        await ctx.step();
      },
    });
    ctx.tracker.observeTurn();
    if (result.status !== 'done') return { status: 'failed', detail: result.detail ?? 'Claude Code failed' };

    // Hot-file changes the task asked for, applied by the integrator.
    const { intents, errors } = parseIntents(result.text);
    if (errors.length) return { status: 'failed', detail: errors.join('; ') };
    for (const intent of intents) {
      const r = await ctx.submitIntent(intent);
      if (r.status === 'rejected') return { status: 'failed', detail: 'intent rejected: ' + (r.error ?? intent.description) };
    }
    const text = result.text.slice(0, 500);
    return { status: 'done', ...(text ? { detail: text } : {}) };
  };
}
