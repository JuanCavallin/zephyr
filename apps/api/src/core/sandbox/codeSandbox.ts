/**
 * Run a script in a sandbox: a fresh temp directory, a scrubbed environment, a wall
 * clock, an output cap, and Node's permission model (`--permission`) with NOTHING
 * granted but read access to that directory. Under it the script cannot open the
 * network, spawn processes, start workers or touch any other path.
 *
 * Contract with the script: `{ "inputs": … }` as JSON on stdin; ONE JSON value on
 * stdout (the last non-empty line). Anything else on stdout is kept as `stdout` but
 * is not the result.
 *
 * What this is NOT: a container or a VM. It trusts Node's permission model, which
 * Node documents as a seat belt and not a security boundary against hostile code,
 * and it does not limit CPU or memory beyond the timeout.
 *
 * TODO(code-node): before this runs code from anyone but the operator, move it to a
 * container/VM with cgroup limits, or add a deny-list/static check and an approval
 * on first sight of a source hash. Also decide where scripts persist for reuse (see
 * the memory TODO on `codeNodeSchema`).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SANDBOX_DEFAULT_TIMEOUT_MS = 10_000;
export const SANDBOX_MAX_OUTPUT_BYTES = 64 * 1024;
/** `--permission` denies network from Node 25; older Node leaves it open, so refuse them. */
export const SANDBOX_MIN_NODE_MAJOR = 25;

export type SandboxFailure = 'timeout' | 'exit' | 'no-result' | 'output-too-large' | 'unsupported';

export interface SandboxResult {
  ok: boolean;
  /** The parsed last JSON line of stdout, when `ok`. */
  result?: unknown;
  failure?: SandboxFailure;
  /** One line a person can act on; set whenever `ok` is false. */
  error?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** sha256 of the source, the key a future cache/review step should use. */
  sourceHash: string;
}

export interface SandboxOptions {
  inputs?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; default is the running Node. */
  nodeBinary?: string;
  /** Test seam; default is the running Node's major version. */
  nodeMajor?: number;
}

export const hashSource = (source: string): string => createHash('sha256').update(source).digest('hex');

export async function runInSandbox(source: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
  const started = Date.now();
  const sourceHash = hashSource(source);
  const base = { exitCode: null, stdout: '', stderr: '', durationMs: 0, sourceHash } as const;

  const major = opts.nodeMajor ?? Number(process.versions.node.split('.')[0]);
  if (major < SANDBOX_MIN_NODE_MAJOR) {
    return {
      ...base,
      ok: false,
      failure: 'unsupported',
      error: `The code sandbox needs Node ${SANDBOX_MIN_NODE_MAJOR}+ (this is ${major}): older Node does not block network under --permission.`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'zephyr-code-'));
  try {
    await writeFile(join(dir, 'main.mjs'), source, 'utf8');
    const timeoutMs = opts.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS;

    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(
        opts.nodeBinary ?? process.execPath,
        ['--permission', `--allow-fs-read=${dir}`, join(dir, 'main.mjs')],
        {
          cwd: dir,
          // No inherited secrets: the script gets an empty environment.
          env: {},
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let failure: SandboxFailure | undefined;
      let settled = false;

      const kill = (why: SandboxFailure) => {
        failure ??= why;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill('timeout'), timeoutMs);
      const onAbort = () => kill('timeout');
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (b: Buffer) => {
        outBytes += b.length;
        if (outBytes > SANDBOX_MAX_OUTPUT_BYTES) return kill('output-too-large');
        out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => {
        errBytes += b.length;
        if (errBytes <= SANDBOX_MAX_OUTPUT_BYTES) err.push(b);
      });
      child.stdin.on('error', () => {}); // the script may exit without reading stdin
      child.stdin.end(JSON.stringify({ inputs: opts.inputs ?? {} }));

      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        const durationMs = Date.now() - started;
        const done = { exitCode, stdout, stderr, durationMs, sourceHash };
        const fail = (f: SandboxFailure, error: string) => resolve({ ...done, ok: false, failure: f, error });

        if (spawnError) return fail('exit', `Could not start the sandbox: ${spawnError.message}`);
        if (failure === 'timeout') return fail('timeout', `Script exceeded ${timeoutMs}ms and was killed.`);
        if (failure === 'output-too-large')
          return fail('output-too-large', `Script wrote more than ${SANDBOX_MAX_OUTPUT_BYTES} bytes to stdout.`);
        if (exitCode !== 0) {
          // The message is the first `Error: …` line; stack frames after it are noise.
          const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const denied = lines.find((l) => /ERR_ACCESS_DENIED|Access to this API has been restricted/.test(l));
          const msg = denied
            ? `blocked by the sandbox (${denied.replace(/^\[cause\]:\s*/, '')})`
            : (lines.find((l) => /^[A-Za-z]*Error:/.test(l)) ?? lines.at(-1));
          return fail('exit', `Script exited with code ${exitCode}${msg ? ': ' + msg : ''}`);
        }
        const last = stdout.trim().split('\n').filter(Boolean).at(-1);
        if (last === undefined) return fail('no-result', 'Script printed nothing; it must print one JSON value.');
        try {
          resolve({ ...done, ok: true, result: JSON.parse(last) });
        } catch {
          fail('no-result', 'The last line of stdout was not JSON.');
        }
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code));
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
