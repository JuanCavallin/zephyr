/**
 * The coding benchmark's task set: fixture repos plus a manifest (bench/coding/tasks.json).
 *
 * Every task carries a hidden acceptance test that lives under bench/coding/hidden,
 * outside every repo the agent sees. A run copies the task's fixture repo into a
 * fresh temp directory (its own git repo, one commit) and the agent works there; the
 * hidden test is copied in only after the agent has stopped (hiddenTests.ts).
 */

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

/** bench/coding at the root of apps/api. */
export const DEFAULT_TASK_SET_ROOT = fileURLToPath(new URL('../../../../bench/coding/', import.meta.url));

/** Where the hidden test is placed inside a worktree once the agent has stopped. */
export const HIDDEN_DIR_NAME = '.zephyr-hidden';

const stepSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('Read'), path: z.string().min(1) }),
  z.object({ tool: z.literal('Write'), path: z.string().min(1), content: z.string() }),
  z.object({ tool: z.literal('Edit'), path: z.string().min(1), find: z.string().min(1), replace: z.string() }),
  z.object({ tool: z.literal('Bash'), command: z.string().min(1) }),
]);

export const codingTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  repo: z.string().min(1),
  kind: z.enum(['bugfix', 'feature', 'refactor', 'ci']),
  /** The module of this repo the task mirrors. */
  origin: z.string().min(1),
  /** What the agent is told. Never mentions the hidden test. */
  prompt: z.string().min(1),
  /** Relative to the task-set root. */
  hiddenTest: z.string().min(1),
  /** Hidden-test time limit; a hang counts as a failure. */
  timeoutMs: z.number().int().positive().optional(),
  /** Reference fix the mock harness replays. Never shown to an agent. */
  solution: z.array(stepSchema).min(1),
});
export type CodingTask = z.infer<typeof codingTaskSchema>;

export const codingTaskSetSchema = z
  .object({
    version: z.literal(1),
    note: z.string().optional(),
    repos: z.record(z.string(), z.object({ dir: z.string().min(1), test: z.string().min(1) })),
    tasks: z.array(codingTaskSchema).min(1),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const t of set.tasks) {
      if (seen.has(t.id)) ctx.addIssue({ code: 'custom', message: 'duplicate task id ' + t.id });
      seen.add(t.id);
      if (!set.repos[t.repo]) ctx.addIssue({ code: 'custom', message: t.id + ': unknown repo ' + t.repo });
    }
  });

export interface CodingTaskSet {
  root: string;
  repos: Record<string, { dir: string; test: string }>;
  tasks: CodingTask[];
}

export async function loadCodingTaskSet(root: string = DEFAULT_TASK_SET_ROOT): Promise<CodingTaskSet> {
  const raw = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')) as unknown;
  const parsed = codingTaskSetSchema.parse(raw);
  return { root: resolve(root), repos: parsed.repos, tasks: parsed.tasks };
}

export const repoDirOf = (set: CodingTaskSet, task: CodingTask): string => resolve(set.root, set.repos[task.repo]!.dir);
export const hiddenTestOf = (set: CodingTaskSet, task: CodingTask): string => resolve(set.root, task.hiddenTest);

export interface PreparedRepo {
  /** A git repository with the fixture at HEAD; the agent's starting point. */
  dir: string;
  cleanup(): Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=zephyr-bench', '-c', 'user.email=bench@zephyr.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    windowsHide: true,
  });
}

/** Copy a task's fixture repo into a fresh temp dir and commit it. */
export async function prepareRepo(set: CodingTaskSet, task: CodingTask, parent: string = tmpdir()): Promise<PreparedRepo> {
  const dir = await mkdtemp(join(parent, 'zephyr-bench-' + task.repo + '-'));
  await cp(repoDirOf(set, task), dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'fixture: ' + task.repo]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

/** Every file under `dir`, repo-relative with forward slashes; `.git` skipped. */
export async function readableTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (e.name !== '.git') await walk(p);
      } else out.push(p);
    }
  }
  await walk('');
  return out.sort();
}

/**
 * The hidden test is not reachable from the agent's tree: its path is outside the
 * worktree, no hidden directory exists yet, and no file in the tree shares its name.
 * Returns the problems found; empty means isolated.
 */
export async function hiddenIsolationProblems(worktree: string, hiddenTest: string): Promise<string[]> {
  const problems: string[] = [];
  const rel = relative(resolve(worktree), resolve(hiddenTest));
  if (!rel.startsWith('..') && !isAbsolute(rel)) problems.push('hidden test is inside the worktree: ' + rel);
  const tree = await readableTree(worktree);
  if (tree.some((p) => p === HIDDEN_DIR_NAME || p.startsWith(HIDDEN_DIR_NAME + '/')))
    problems.push(HIDDEN_DIR_NAME + ' exists before the agent stopped');
  const name = basename(hiddenTest);
  const leaked = tree.filter((p) => p.split('/').pop() === name);
  if (leaked.length) problems.push('a file named like the hidden test is readable: ' + leaked.join(', '));
  return problems;
}
