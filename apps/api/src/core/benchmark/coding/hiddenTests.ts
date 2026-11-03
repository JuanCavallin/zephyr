/**
 * Runs a task's hidden acceptance test against a worktree after the agent stopped.
 *
 * The test file is copied to `<worktree>/.zephyr-hidden/` (so its `../src/...` imports
 * resolve against the agent's code), executed directly with node as a single process
 * (node:test files run standalone), and removed again. A hang, such as an infinite
 * loop the agent left in, is killed at the time limit and counts as a failure.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HIDDEN_DIR_NAME } from './taskSet.js';

export interface HiddenTestResult {
  passed: boolean;
  pass: number;
  fail: number;
  timedOut: boolean;
  /** Tail of the test output, for the journal. */
  output: string;
}

export const DEFAULT_HIDDEN_TIMEOUT_MS = 15_000;

/** `# pass N` (TAP) or `ℹ pass N` (spec reporter). */
function count(output: string, word: 'pass' | 'fail'): number {
  const m = new RegExp('^(?:#|ℹ)\\s+' + word + '\\s+(\\d+)', 'm').exec(output);
  return m ? Number(m[1]) : 0;
}

export async function runHiddenTest(input: {
  worktree: string;
  hiddenTest: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HiddenTestResult> {
  const dir = join(input.worktree, HIDDEN_DIR_NAME);
  const file = join(dir, basename(input.hiddenTest));
  await mkdir(dir, { recursive: true });
  await copyFile(input.hiddenTest, file);
  try {
    return await new Promise<HiddenTestResult>((resolvePromise) => {
      const child = spawn(process.execPath, ['--max-old-space-size=256', '--test-reporter=tap', file], {
        cwd: input.worktree,
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const take = (b: Buffer) => {
        output = (output + b.toString('utf8')).slice(-20_000);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      let timedOut = false;
      const kill = () => child.kill('SIGKILL');
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, input.timeoutMs ?? DEFAULT_HIDDEN_TIMEOUT_MS);
      input.signal?.addEventListener('abort', kill, { once: true });
      const done = (code: number | null) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', kill);
        const pass = count(output, 'pass');
        const fail = count(output, 'fail');
        resolvePromise({
          passed: !timedOut && code === 0 && fail === 0 && pass > 0,
          pass,
          fail: timedOut && fail === 0 ? 1 : fail,
          timedOut,
          output: output.slice(-2_000),
        });
      };
      child.on('error', (err) => {
        output += '\n' + err.message;
        done(null);
      });
      child.on('close', done);
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
