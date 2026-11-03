/**
 * Task templates (docs/cacp-09-benchmark-cli-demo.md, "CLI and onboarding").
 *
 * A template is a named preset for a board: the policy a run starts with (token levers
 * and what verification must prove), the per-task budget, and how many tasks run at
 * once. Each carries a one-line explanation the CLI and UI show verbatim, so the user
 * knows what they picked without reading the numbers.
 *
 * A template only presets values. Anything the request sets explicitly (concurrency on
 * `run`, for example) wins, and authorization is unchanged: no template can approve an
 * action on the user's behalf.
 */

import { z } from 'zod';
import type { Levers, VerifyPolicy } from './coding.js';

export const TASK_TEMPLATE_IDS = ['add-feature', 'fix-ci', 'upgrade-dependency', 'polish-ui'] as const;
export const taskTemplateIdSchema = z.enum(TASK_TEMPLATE_IDS);
export type TaskTemplateId = z.infer<typeof taskTemplateIdSchema>;

export interface TaskTemplateBudget {
  /** Agent turns per task before it is blocked as over budget. */
  maxTurns: number;
  /** Model tokens (input + output) per task. */
  maxTokens: number;
  /** No observed progress for this long and the task is blocked as stuck. */
  stuckMs: number;
}

export interface TaskTemplate {
  id: TaskTemplateId;
  label: string;
  /** One line, shown as-is by `zephyr templates` and the board. */
  explain: string;
  /** Added under the user's request so the decomposer and agents see the intent. */
  guidance: string;
  levers: Levers;
  verify: Pick<VerifyPolicy, 'protectDefaults' | 'fullSuiteBeforePublish'> & { protectedGlobs: string[] };
  budget: TaskTemplateBudget;
  concurrency: number;
  /** Merge a task as soon as its tests are green, without a review stop. */
  autoMergeGreen: boolean;
}

const MIN = 60_000;
const ALL_LEVERS: Levers = { shapedTools: true, contextPack: true, schemaMin: true };

export const TASK_TEMPLATES: Readonly<Record<TaskTemplateId, TaskTemplate>> = Object.freeze({
  'add-feature': {
    id: 'add-feature',
    label: 'Add a feature',
    explain: 'Splits the feature into parallel tasks, 3 at a time; tests are protected and you review each merge.',
    guidance: 'Add the feature with tests for the new behaviour. Do not weaken existing tests.',
    levers: ALL_LEVERS,
    verify: { protectDefaults: true, fullSuiteBeforePublish: true, protectedGlobs: [] },
    budget: { maxTurns: 40, maxTokens: 400_000, stuckMs: 10 * MIN },
    concurrency: 3,
    autoMergeGreen: false,
  },
  'fix-ci': {
    id: 'fix-ci',
    label: 'Fix CI',
    explain: 'One task at a time with a tight budget; CI config edits need your approval and the full suite must pass.',
    guidance: 'Find why CI fails and fix the cause. Changing CI config or skipping tests is not a fix.',
    levers: ALL_LEVERS,
    verify: { protectDefaults: true, fullSuiteBeforePublish: true, protectedGlobs: ['.github/**'] },
    budget: { maxTurns: 25, maxTokens: 200_000, stuckMs: 8 * MIN },
    concurrency: 1,
    autoMergeGreen: false,
  },
  'upgrade-dependency': {
    id: 'upgrade-dependency',
    label: 'Upgrade a dependency',
    explain: 'Lockfile changes need your approval; the full suite runs before anything merges.',
    guidance: 'Upgrade the dependency, adapt call sites to its new API and keep behaviour unchanged.',
    levers: ALL_LEVERS,
    verify: { protectDefaults: true, fullSuiteBeforePublish: true, protectedGlobs: [] },
    budget: { maxTurns: 30, maxTokens: 300_000, stuckMs: 10 * MIN },
    concurrency: 2,
    autoMergeGreen: false,
  },
  'polish-ui': {
    id: 'polish-ui',
    label: 'Polish the UI',
    explain: 'Small cosmetic tasks, 4 at a time; green tasks merge without a stop, tests stay protected.',
    guidance: 'Make the visual change only. Keep markup semantics and accessibility intact.',
    levers: ALL_LEVERS,
    verify: { protectDefaults: true, fullSuiteBeforePublish: false, protectedGlobs: [] },
    budget: { maxTurns: 20, maxTokens: 150_000, stuckMs: 6 * MIN },
    concurrency: 4,
    autoMergeGreen: true,
  },
});

export function isTaskTemplateId(id: string): id is TaskTemplateId {
  return (TASK_TEMPLATE_IDS as readonly string[]).includes(id);
}

export function taskTemplate(id: TaskTemplateId): TaskTemplate {
  return TASK_TEMPLATES[id];
}

/**
 * A task's acceptance with the template's guidance appended. The guidance goes on every
 * task, not into the request: a decomposer would otherwise plan it as a task of its own.
 */
export function applyTemplateToAcceptance(acceptance: string, t: TaskTemplate): string {
  return acceptance.trim() + '\n' + t.label + ': ' + t.guidance;
}
