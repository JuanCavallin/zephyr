/**
 * Which command runs the tests, build or lint of a worktree.
 *
 * Detection is deterministic and reads only marker files: package.json (and the
 * lockfile for the package manager), pyproject/setup files, Cargo.toml, go.mod.
 * The model never supplies a command, only an optional test filter, which is
 * validated against a conservative character set before it reaches argv.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ShapedKind = 'test' | 'build' | 'lint';

export interface DetectedCommand {
  argv: string[];
  /** Where a JUnit report will be written, when the runner was asked for one. */
  junitPath?: string;
  ecosystem: 'node' | 'python' | 'rust' | 'go' | 'override';
}

export type DetectResult = { ok: true; command: DetectedCommand } | { ok: false; message: string };

export interface DetectOptions {
  filter?: string;
  /** Directory for report files (JUnit). Must exist. */
  reportDir: string;
  /** Fixed argv per kind; tests and unusual repos. `{filter}` is substituted. */
  overrides?: Partial<Record<ShapedKind, string[]>>;
}

const FILTER = /^[\w./:@=,*[\] -]{1,200}$/;

export function validateFilter(filter: string | undefined): string | null {
  if (filter === undefined || filter === '') return null;
  if (!FILTER.test(filter) || filter.startsWith('-')) {
    return 'filter may only hold letters, digits, spaces and . / : @ = , * [ ] _ - (and may not start with "-")';
  }
  return null;
}

function packageManager(worktree: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(worktree, 'bun.lockb')) || existsSync(join(worktree, 'bun.lock'))) return 'bun';
  return 'npm';
}

function readScripts(worktree: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

export function detectCommand(worktree: string, kind: ShapedKind, opts: DetectOptions): DetectResult {
  const bad = validateFilter(opts.filter);
  if (bad) return { ok: false, message: bad };
  const filter = opts.filter || undefined;

  const override = opts.overrides?.[kind];
  if (override) {
    const argv = override.flatMap((a) => (a === '{filter}' ? (filter ? [filter] : []) : [a]));
    return { ok: true, command: { argv, ecosystem: 'override' } };
  }

  const scripts = readScripts(worktree);
  if (scripts) {
    const pm = packageManager(worktree);
    const names: Record<ShapedKind, string[]> = {
      test: ['test'],
      build: ['build', 'typecheck', 'tsc'],
      lint: ['lint'],
    };
    const script = names[kind].find((n) => scripts[n]);
    if (!script) {
      return { ok: false, message: `package.json has no ${names[kind].map((n) => `"${n}"`).join(' or ')} script.` };
    }
    const argv = [pm, 'run', script];
    // npm and pnpm/yarn/bun all forward arguments after `--` to the script.
    if (filter && kind === 'test') argv.push('--', filter);
    return { ok: true, command: { argv, ecosystem: 'node' } };
  }

  const python = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'].some((f) =>
    existsSync(join(worktree, f)),
  );
  if (python) {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    if (kind === 'test') {
      const junitPath = join(opts.reportDir, 'junit.xml');
      const argv = [py, '-m', 'pytest', '-q', '--junitxml=' + junitPath];
      if (filter) argv.push('-k', filter);
      return { ok: true, command: { argv, junitPath, ecosystem: 'python' } };
    }
    if (kind === 'lint') return { ok: true, command: { argv: [py, '-m', 'ruff', 'check', '.'], ecosystem: 'python' } };
    return { ok: true, command: { argv: [py, '-m', 'compileall', '-q', '.'], ecosystem: 'python' } };
  }

  if (existsSync(join(worktree, 'Cargo.toml'))) {
    const argv =
      kind === 'test'
        ? ['cargo', 'test', ...(filter ? [filter] : [])]
        : kind === 'build'
          ? ['cargo', 'build', '--message-format=short']
          : ['cargo', 'clippy', '--message-format=short'];
    return { ok: true, command: { argv, ecosystem: 'rust' } };
  }

  if (existsSync(join(worktree, 'go.mod'))) {
    const argv =
      kind === 'test'
        ? ['go', 'test', ...(filter ? ['-run', filter] : []), './...']
        : kind === 'build'
          ? ['go', 'build', './...']
          : ['go', 'vet', './...'];
    return { ok: true, command: { argv, ecosystem: 'go' } };
  }

  return {
    ok: false,
    message: `No ${kind} command found: the worktree has no package.json, pyproject.toml, Cargo.toml or go.mod.`,
  };
}
