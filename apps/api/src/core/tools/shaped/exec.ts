/**
 * Run one command with a timeout and an output cap, and never hang on it.
 *
 * stdout and stderr are merged in arrival order. Past `maxOutputBytes` the middle
 * of the log is dropped: the first quarter is kept as a head and the rest as a
 * rolling tail, with a marker where the cut is (a failing run's summary is at the
 * end, its first error usually near the start). Past `killAfterBytes` the process
 * tree is killed: a runaway loop printing forever must not keep the tool busy.
 *
 * The child gets an allowlisted environment, not the API's: provider keys and
 * gateway tokens in `process.env` never reach a test suite.
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ENV_ALLOWLIST } from '../../../providers/_acp/config.js';
import { killProcessTree } from '../../../providers/_acp/client.js';

export interface BoundedRunOptions {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Kill the process once it has written this much. Default 16× the cap. */
  killAfterBytes?: number;
  /** Extra variables on top of the allowlisted environment. */
  env?: Record<string, string>;
  /** Source environment to allowlist from. Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface BoundedRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Output went over `maxOutputBytes` and the middle was dropped. */
  truncated: boolean;
  /** Killed for writing more than `killAfterBytes`. */
  runaway: boolean;
  aborted: boolean;
  output: string;
  totalBytes: number;
  durationMs: number;
  /** The command could not be started at all (not found, bad cwd). */
  spawnError?: string;
}

const ALLOWED = new Set<string>(ENV_ALLOWLIST);

export function allowlistedEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED.has(key.toUpperCase())) out[key] = value;
  }
  return { ...out, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

/** cmd.exe quoting for one argument. Filters are validated upstream; paths may hold spaces. */
function quoteWin(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

export function describeCommand(argv: string[]): string {
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

export function runBounded(opts: BoundedRunOptions): Promise<BoundedRunResult> {
  const started = Date.now();
  const cap = Math.max(1024, opts.maxOutputBytes);
  const killAt = opts.killAfterBytes ?? cap * 16;
  const headCap = Math.floor(cap / 4);
  const tailCap = cap - headCap;
  const env = allowlistedEnv(opts.baseEnv ?? process.env, opts.env);

  const [cmd, ...args] = opts.argv;
  if (!cmd) {
    return Promise.resolve({
      exitCode: null, signal: null, timedOut: false, truncated: false, runaway: false, aborted: false,
      output: '', totalBytes: 0, durationMs: 0, spawnError: 'empty command',
    });
  }

  // Windows package managers are .cmd shims, which Node only runs through a shell.
  // An absolute .exe (process.execPath in tests) is spawned directly.
  const viaShell = process.platform === 'win32' && !(isAbsolute(cmd) && /\.exe$/i.test(cmd));

  return new Promise((resolve) => {
    let head = '';
    let headBytes = 0;
    let tailChunks: Buffer[] = [];
    let tailBytes = 0;
    let totalBytes = 0;
    let timedOut = false;
    let runaway = false;
    let aborted = false;
    let killing: Promise<void> | null = null;
    let settled = false;

    const child = viaShell
      ? spawn([cmd, ...args].map(quoteWin).join(' '), [], { cwd: opts.cwd, env, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: opts.cwd, env, detached: process.platform !== 'win32', windowsHide: true });

    const kill = () => {
      if (!killing) killing = killProcessTree(child, 3_000).catch(() => undefined);
      return killing;
    };

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (headBytes < headCap) {
        const take = chunk.subarray(0, headCap - headBytes);
        head += take.toString('utf8');
        headBytes += take.length;
        chunk = chunk.subarray(take.length);
      }
      if (chunk.length) {
        tailChunks.push(chunk);
        tailBytes += chunk.length;
        while (tailBytes - (tailChunks[0]?.length ?? 0) >= tailCap && tailChunks.length > 1) {
          tailBytes -= tailChunks.shift()!.length;
        }
        if (tailBytes > tailCap * 2) {
          const joined = Buffer.concat(tailChunks);
          tailChunks = [joined.subarray(joined.length - tailCap)];
          tailBytes = tailCap;
        }
      }
      if (totalBytes > killAt && !runaway) {
        runaway = true;
        void kill();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      void kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      void kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      let tail = Buffer.concat(tailChunks);
      if (tail.length > tailCap) tail = tail.subarray(tail.length - tailCap);
      const kept = headBytes + tail.length;
      const truncated = totalBytes > kept;
      const output = truncated
        ? head + `\n…[${totalBytes - kept} bytes of output omitted]…\n` + tail.toString('utf8')
        : head + tail.toString('utf8');
      resolve({
        exitCode, signal, timedOut, truncated, runaway, aborted, output, totalBytes,
        durationMs: Date.now() - started,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    child.once('error', (err) => finish(null, null, err.message));
    child.once('close', (code, signal) => finish(code, signal));
    // A grandchild that inherited the pipes can keep 'close' from ever firing after
    // the command itself exited. Give the pipes a moment to drain, then stop waiting.
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 2_000).unref();
    });
  });
}
