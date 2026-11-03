/**
 * `zephyr up`: report what this machine can drive, start the server if it is not already
 * running, and open the board.
 *
 * The server is the repo's own `pnpm dev` (API on 8787, web on 5173), so `up` adds no
 * second way to run Zephyr. When the API already answers `/api/health`, nothing is
 * started: running `up` twice is safe.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from './api.js';
import { detect, formatDetection, probeVersion, quoteWin, type Detection, type HarnessBinary } from './detect.js';

export const DEFAULT_WEB = 'http://localhost:5173';

/** The monorepo root: the CLI lives at `<root>/packages/cli/src`. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export interface UpOptions {
  api: string;
  web: string;
  open: boolean;
  /** Only report; do not start or open anything. */
  check: boolean;
  log?: (line: string) => void;
}

export async function report(root: string, log: (l: string) => void): Promise<Detection> {
  const d = detect({ dotenvPath: join(root, '.env') });
  const versions: Partial<Record<HarnessBinary, string | null>> = {};
  await Promise.all(d.binaries.map(async (b) => b.path && (versions[b.name] = await probeVersion(b))));
  log(formatDetection(d, versions));
  return d;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, child?: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function webUp(web: string): Promise<boolean> {
  try {
    const res = await fetch(web, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args]: [string, string[]] =
    platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

/** Runs until the server it started exits (Ctrl+C stops both). Returns the exit code. */
export async function up(o: UpOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const root = repoRoot();
  await report(root, log);
  if (o.check) return 0;

  const api = new ApiClient({ base: o.api });
  const boardUrl = o.web.replace(/\/+$/, '') + '/board';
  if (await api.healthy()) {
    log(`\nZephyr is already running at ${o.api}.`);
    if (o.open) openUrl(boardUrl);
    log(`Board: ${boardUrl}`);
    return 0;
  }

  if (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    log(`\nCannot find the Zephyr repo at ${root}; start it there with \`pnpm dev\`.`);
    return 1;
  }
  log('\nStarting Zephyr (pnpm dev)…');
  const child =
    process.platform === 'win32'
      ? spawn('pnpm dev', { cwd: root, shell: true, stdio: 'inherit' })
      : spawn('pnpm', ['dev'], { cwd: root, stdio: 'inherit' });
  child.on('error', (err) => log(`Could not start pnpm: ${err.message}. Is pnpm installed (corepack enable)?`));
  const stop = () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid) spawn('taskkill /pid ' + quoteWin(String(child.pid)) + ' /T /F', { shell: true, stdio: 'ignore' });
    else child.kill('SIGINT');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const apiOk = await waitFor(() => api.healthy(), 120_000, child);
  const webOk = apiOk && (await waitFor(() => webUp(o.web), 60_000, child));
  if (!apiOk || !webOk) {
    log(`\nZephyr did not come up (${apiOk ? 'web' : 'API'} not answering). See the log above.`);
    stop();
    return 1;
  }
  log(`\nZephyr is up. Board: ${boardUrl}  (Ctrl+C to stop)`);
  if (o.open) openUrl(boardUrl);
  return await new Promise<number>((r) => child.on('exit', (code) => r(code ?? 0)));
}
