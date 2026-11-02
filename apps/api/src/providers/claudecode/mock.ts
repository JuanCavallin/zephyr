/**
 * Claude Code — MOCK. Deterministic, no subprocess, no worktree: a task polls
 * `running` once, then completes. With no live session there is nothing a native
 * permission request could be bound to, so every one is denied.
 */

import type { AgentRuntimeAdapter, Capability, PermissionVerdict } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';

const CAPABILITIES: readonly Capability[] = ['agent.runtime'];

interface MockTask {
  polls: number;
  goal: string;
}

export function createMockClaudeCode(cfg: ProviderConfig): AgentRuntimeAdapter {
  const base = mockBase('claudecode', CAPABILITIES, cfg.mode);
  const tasks = new Map<string, MockTask>();
  return {
    ...base,
    async startTask(input, ctx) {
      return mockCall(
        'claudecode',
        'startTask',
        cfg.mode,
        ctx,
        () => {
          const taskId = 'claudecode_task_' + Math.random().toString(36).slice(2, 10);
          tasks.set(taskId, { polls: 0, goal: input.goal });
          return { taskId };
        },
        { tokensIn: Math.ceil(input.goal.length / 3), tokensOut: 0 },
      );
    },
    async pollTask(taskId, ctx) {
      return mockCall(
        'claudecode',
        'pollTask',
        cfg.mode,
        ctx,
        () => {
          const task = tasks.get(taskId);
          const n = (task?.polls ?? 0) + 1;
          if (task) task.polls = n;
          if (n < 2) return { status: 'running' as const, log: ['working...'] };
          return {
            status: 'done' as const,
            result: { text: 'mock Claude Code completed: ' + (task?.goal ?? taskId) },
            log: ['working...', 'done'],
            toolCalls: [],
          };
        },
        { tokensIn: 0, tokensOut: 180 },
      );
    },
    async continueTask(taskId, _input, ctx) {
      return mockCall('claudecode', 'continueTask', cfg.mode, ctx, () => {
        const task = tasks.get(taskId);
        if (task) task.polls = 0;
        return null;
      });
    },
    async cancelTask(taskId, ctx) {
      return mockCall('claudecode', 'cancelTask', cfg.mode, ctx, () => {
        tasks.delete(taskId);
        return null;
      });
    },
    // No live session exists in mock mode, so nothing has authorized a native call.
    async onPermissionRequest(): Promise<PermissionVerdict> {
      return 'deny';
    },
  };
}
