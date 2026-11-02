/**
 * mockharness — a scripted, deterministic stand-in for a coding harness (Claude Code,
 * Codex) so the board, leases and broker can be built before a real harness is wired.
 *
 * Each `pollTask` advances the script by exactly one step: the harness raises a
 * `NativeToolRequest` through `onPermissionRequest` (which delegates to the injected
 * broker decision, the same path a real adapter uses), and only on `allow` (or
 * `revise`) applies the step to its workspace directory. No timers, no network, no
 * randomness: identical scripts produce identical results.
 *
 * Not a registered provider: it implements the AgentRuntimeAdapter capability methods
 * but has no ProviderId, so it never shows up in /api/providers or the registry.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  toRepoPath,
  type AgentRuntimeAdapter,
  type NativeToolRequest,
  type PermissionVerdict,
  type ProviderAdapter,
  type ProviderCallContext,
  type ProviderMeta,
  type ProviderResult,
} from '@htn/shared';

/** One scripted harness action. Paths are repo-relative to the workspace. */
export type MockHarnessStep =
  | { tool: 'Read'; path: string }
  | { tool: 'Write'; path: string; content: string }
  | { tool: 'Edit'; path: string; find: string; replace: string }
  | { tool: 'Bash'; command: string };

export interface MockHarnessStartContext {
  /** Directory the harness edits. A fresh temp dir is created when omitted. */
  workspaceDir?: string;
  /** Defaults to `defaultScript(goal)`. */
  script?: MockHarnessStep[];
  /** Board task id, copied onto every NativeToolRequest. */
  taskId?: string;
}

/** The capability half of AgentRuntimeAdapter, without the ProviderAdapter identity. */
export type HarnessRuntime = Omit<AgentRuntimeAdapter, keyof ProviderAdapter> & {
  readonly harness: 'mockharness';
};

export interface MockHarness extends HarnessRuntime {
  onPermissionRequest(req: NativeToolRequest, ctx: ProviderCallContext): Promise<PermissionVerdict>;
  /** The workspace a task is editing. */
  workspaceOf(taskId: string): string | undefined;
  /** Remove temp workspaces this harness created. */
  dispose(): Promise<void>;
}

export type BrokerDecision = (
  req: NativeToolRequest,
  ctx: ProviderCallContext,
) => Promise<PermissionVerdict>;

interface Session {
  id: string;
  goal: string;
  script: MockHarnessStep[];
  cursor: number;
  workspaceDir: string;
  ownsWorkspace: boolean;
  boardTaskId?: string;
  status: 'running' | 'done' | 'failed';
  cancelled: boolean;
  log: string[];
  toolCalls: { tool: string; args?: unknown; at: string }[];
  filesChanged: Set<string>;
  denied: number;
}

/** A small deterministic script derived from the goal: read, write, edit, run tests. */
export function defaultScript(goal: string): MockHarnessStep[] {
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'task';
  const file = 'src/' + slug + '.ts';
  return [
    { tool: 'Read', path: 'README.md' },
    { tool: 'Write', path: file, content: '// ' + goal + '\nexport const done = false;\n' },
    { tool: 'Edit', path: file, find: 'done = false', replace: 'done = true' },
    { tool: 'Bash', command: 'pnpm test' },
  ];
}

/** Fixed clock so tool-call timestamps are reproducible. */
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

const meta = (op: string): ProviderMeta => ({
  provider: 'hermes',
  op: 'mockharness.' + op,
  mode: 'mock',
  latencyMs: 0,
  destination: 'mock://mockharness',
});

function ok<T>(op: string, data: T): ProviderResult<T> {
  return { ok: true, data, meta: meta(op) };
}

function notFound<T>(op: string, taskId: string): ProviderResult<T> {
  return {
    ok: false,
    error: { code: 'BAD_INPUT', message: 'Unknown mockharness task ' + taskId, retryable: false },
    meta: meta(op),
  };
}

function rawInputOf(step: MockHarnessStep): Record<string, unknown> {
  const { tool: _tool, ...rest } = step;
  return rest;
}

export function createMockHarness(opts: { decide: BrokerDecision }): MockHarness {
  const sessions = new Map<string, Session>();
  let nextId = 1;

  async function apply(session: Session, step: MockHarnessStep): Promise<string> {
    if (step.tool === 'Bash') return 'ran `' + step.command + '` (scripted: 0 failures)';
    const rel = toRepoPath(step.path);
    if (!rel) throw new Error('path escapes workspace: ' + step.path);
    const abs = join(session.workspaceDir, ...rel.split('/'));
    if (step.tool === 'Read') {
      const text = await readFile(abs, 'utf8').catch(() => '');
      return 'read ' + rel + ' (' + text.length + ' bytes)';
    }
    if (step.tool === 'Write') {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, step.content, 'utf8');
    } else {
      const before = await readFile(abs, 'utf8');
      if (!before.includes(step.find)) throw new Error('edit target not found in ' + rel);
      await writeFile(abs, before.replace(step.find, step.replace), 'utf8');
    }
    session.filesChanged.add(rel);
    return (step.tool === 'Write' ? 'wrote ' : 'edited ') + rel;
  }

  const harness: MockHarness = {
    harness: 'mockharness',

    onPermissionRequest(req, ctx) {
      return opts.decide(req, ctx);
    },

    async startTask(input, _ctx) {
      const context = (input.context ?? {}) as MockHarnessStartContext;
      const id = 'mh_' + nextId++;
      const ownsWorkspace = !context.workspaceDir;
      const workspaceDir =
        context.workspaceDir ?? (await mkdtemp(join(tmpdir(), 'zephyr-mockharness-')));
      sessions.set(id, {
        id,
        goal: input.goal,
        script: context.script ?? defaultScript(input.goal),
        cursor: 0,
        workspaceDir,
        ownsWorkspace,
        boardTaskId: context.taskId,
        status: 'running',
        cancelled: false,
        log: [],
        toolCalls: [],
        filesChanged: new Set(),
        denied: 0,
      });
      return ok('startTask', { taskId: id });
    },

    async pollTask(taskId, ctx) {
      const s = sessions.get(taskId);
      if (!s) return notFound('pollTask', taskId);
      if (s.status === 'running' && !s.cancelled) {
        const step = s.script[s.cursor];
        if (!step) s.status = 'done';
        else {
          const req: NativeToolRequest = {
            harness: 'mockharness',
            toolName: step.tool,
            rawInput: rawInputOf(step),
            sessionId: s.id,
            toolCallId: s.id + ':' + s.cursor,
            ...(s.boardTaskId ? { taskId: s.boardTaskId } : {}),
          };
          s.toolCalls.push({
            tool: step.tool,
            args: req.rawInput,
            at: new Date(EPOCH + s.cursor * 1000).toISOString(),
          });
          const verdict = await harness.onPermissionRequest(req, ctx);
          if (verdict === 'deny') {
            s.denied++;
            s.log.push('denied ' + step.tool + ' ' + JSON.stringify(req.rawInput));
          } else {
            const effective =
              verdict === 'allow'
                ? step
                : ({ tool: step.tool, ...(verdict.revise as object) } as MockHarnessStep);
            try {
              s.log.push(await apply(s, effective));
            } catch (err) {
              s.status = 'failed';
              s.log.push('error: ' + (err as Error).message);
            }
          }
          s.cursor++;
          if (s.status === 'running' && s.cursor >= s.script.length) s.status = 'done';
        }
      }
      return ok('pollTask', {
        status: s.status,
        partial: { step: s.cursor, of: s.script.length, filesChanged: [...s.filesChanged].sort(), denied: s.denied },
        ...(s.status === 'done' ? { result: { filesChanged: [...s.filesChanged].sort() } } : {}),
        log: [...s.log],
        toolCalls: [...s.toolCalls],
      });
    },

    async continueTask(taskId, input, _ctx) {
      const s = sessions.get(taskId);
      if (!s) return notFound('continueTask', taskId);
      s.log.push('continue: ' + input.instruction);
      return ok('continueTask', null);
    },

    async cancelTask(taskId, _ctx) {
      const s = sessions.get(taskId);
      if (!s) return notFound('cancelTask', taskId);
      s.cancelled = true;
      if (s.status === 'running') s.status = 'failed';
      s.log.push('cancelled');
      return ok('cancelTask', null);
    },

    workspaceOf(taskId) {
      return sessions.get(taskId)?.workspaceDir;
    },

    async dispose() {
      for (const s of sessions.values())
        if (s.ownsWorkspace) await rm(s.workspaceDir, { recursive: true, force: true });
      sessions.clear();
    },
  };
  return harness;
}
