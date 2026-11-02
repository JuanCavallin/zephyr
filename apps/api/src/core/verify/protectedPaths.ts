/**
 * Protected paths (step 6): files a run may not quietly edit.
 *
 * With `protectDefaults` the guarded set is pre-existing test files, snapshots, CI
 * config, lint config and lockfiles; `protectedGlobs` adds more. An edit to a
 * protected path is classified irreversible and needs an approval that carries the
 * exact diff (see the permission bridge). New test files are not protected: the run
 * may add them, and they are flagged instead.
 *
 * "Pre-existing" is relative to the run: a test or snapshot the run itself created
 * (`runCreated`) stays editable. CI config, lint config, lockfiles and policy globs
 * are guarded whoever created them. A lockfile change that reaches the worktree
 * through a hot-file intent (step 7) is still an edit to a protected path.
 */

import type { HotFileIntent, VerifyPolicy } from '@htn/shared';
import { matchesAny } from './glob.js';
import { DEFAULT_RUNNERS, runnerFor, type TestRunnerSpec } from './testInventory.js';

export type ProtectionReason =
  | 'existing-test'
  | 'snapshot'
  | 'ci-config'
  | 'lint-config'
  | 'lockfile'
  | 'policy-glob';

export const SNAPSHOT_GLOBS = Object.freeze(['**/__snapshots__/**', '*.snap']);

export const CI_CONFIG_GLOBS = Object.freeze([
  '.github/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  'azure-pipelines.yml',
  '.buildkite/**',
  'Jenkinsfile',
]);

export const LINT_CONFIG_GLOBS = Object.freeze([
  '.eslintrc',
  '.eslintrc.*',
  'eslint.config.*',
  '.prettierrc',
  '.prettierrc.*',
  'prettier.config.*',
  'biome.json',
  'biome.jsonc',
  '.editorconfig',
  'ruff.toml',
  '.ruff.toml',
  '.flake8',
  '.pylintrc',
  '.golangci.yml',
  '.golangci.yaml',
]);

export const LOCKFILE_GLOBS = Object.freeze([
  '*.lock',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'go.sum',
]);

/** Test files living in a conventional test directory, whatever their name. */
const TEST_DIR_GLOBS = Object.freeze(['**/__tests__/**']);

export interface ProtectionOptions {
  runners?: readonly TestRunnerSpec[];
}

/** Is this path a test file (any runner, or a conventional test directory)? */
export function isTestPath(path: string, runners: readonly TestRunnerSpec[] = DEFAULT_RUNNERS): boolean {
  return runnerFor(path, runners) !== null || matchesAny(path, TEST_DIR_GLOBS);
}

/** Why `path` is protected, or null. Paths are POSIX repo-relative. */
export function protectionOf(
  path: string,
  policy: Pick<VerifyPolicy, 'protectDefaults' | 'protectedGlobs'>,
  runCreated: ReadonlySet<string>,
  options: ProtectionOptions = {},
): ProtectionReason | null {
  const p = normalize(path);
  if (policy.protectDefaults) {
    if (matchesAny(p, LOCKFILE_GLOBS)) return 'lockfile';
    if (matchesAny(p, CI_CONFIG_GLOBS)) return 'ci-config';
    if (matchesAny(p, LINT_CONFIG_GLOBS)) return 'lint-config';
  }
  if (matchesAny(p, policy.protectedGlobs)) return 'policy-glob';
  if (!policy.protectDefaults || runCreated.has(p)) return null;
  if (matchesAny(p, SNAPSHOT_GLOBS)) return 'snapshot';
  if (isTestPath(p, options.runners)) return 'existing-test';
  return null;
}

export function isProtected(
  path: string,
  policy: Pick<VerifyPolicy, 'protectDefaults' | 'protectedGlobs'>,
  runCreated: ReadonlySet<string>,
): boolean {
  return protectionOf(path, policy, runCreated) !== null;
}

/**
 * A hot-file intent targeting a protected path (a lockfile, usually) still needs the
 * protected-path approval when the integrator applies it. Intents never count as
 * run-created files.
 */
export function hotFileIntentProtection(
  intent: Pick<HotFileIntent, 'path'>,
  policy: Pick<VerifyPolicy, 'protectDefaults' | 'protectedGlobs'>,
): ProtectionReason | null {
  return protectionOf(intent.path, policy, new Set());
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
