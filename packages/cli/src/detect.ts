/**
 * What `zephyr up` can drive on this machine: the harness binaries on PATH and the API
 * keys in the environment or the repo's `.env`. Values are never printed or returned,
 * only whether a key is present and where it came from.
 *
 * Windows is first-class: PATH is split on `;`, each entry is tried with every PATHEXT
 * extension, and a `.cmd`/`.bat` shim (what npm installs) is reported as one, because it
 * must be spawned through the shell.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter as hostDelimiter, extname, win32, posix } from 'node:path';
import { spawn } from 'node:child_process';

export type HarnessBinary = 'claude' | 'codex';

export interface FoundBinary {
  name: HarnessBinary;
  /** Absolute path of the first match on PATH, or null when absent. */
  path: string | null;
  /** `.cmd`/`.bat` on Windows: spawn with `shell: true` and quoted arguments. */
  shim: boolean;
}

export interface KeyStatus {
  name: string;
  present: boolean;
  source: 'env' | '.env' | null;
  /** What the key turns on, shown next to it. */
  enables: string;
  required: boolean;
}

export interface Detection {
  platform: NodeJS.Platform;
  binaries: FoundBinary[];
  keys: KeyStatus[];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** A `.env` file to read keys from when the environment lacks them. */
  dotenvPath?: string;
}

/** Keys Zephyr uses, in the order the report lists them. None is required for mock mode. */
export const KNOWN_KEYS: ReadonlyArray<Omit<KeyStatus, 'present' | 'source'>> = [
  { name: 'ANTHROPIC_API_KEY', enables: 'model gateway and Claude Code runs billed to an API key', required: false },
  { name: 'OPENAI_API_KEY', enables: 'Codex runs billed to an API key', required: false },
  { name: 'AI_GATEWAY_API_KEY', enables: 'Jev decisions (routing, test selection); mock without it', required: false },
  { name: 'MODEL_GATEWAY_API_KEY', enables: 'the hosted model gateway', required: false },
  { name: 'GEMINI_API_KEY', enables: 'Gemini as a planner model', required: false },
  { name: 'BROWSERBASE_API_KEY', enables: 'cloud browsers for walkthroughs', required: false },
];

const BINARIES: HarnessBinary[] = ['claude', 'codex'];

function pathOf(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** Windows env names are case-insensitive: `Path` is common. */
function envGet(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  if (!isFile(p)) return false;
  if (platform === 'win32') return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `name` on PATH, honouring PATHEXT on Windows. */
export function findExecutable(name: string, opts: DetectOptions = {}): { path: string; shim: boolean } | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const p = pathOf(platform);
  const delimiter = platform === 'win32' ? ';' : platform === process.platform ? hostDelimiter : ':';
  const dirs = (envGet(env, 'PATH', platform) ?? '').split(delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exts =
    platform === 'win32'
      ? (envGet(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (isExecutable(candidate, platform)) {
        const e = extname(candidate).toLowerCase();
        return { path: candidate, shim: platform === 'win32' && (e === '.cmd' || e === '.bat') };
      }
    }
  }
  return null;
}

/** `KEY=value` lines; `#` comments, optional `export`, and quoted values. No expansion. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const q = /^(['"])(.*)\1$/.exec(value);
    if (q) value = q[2]!;
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]!] = value;
  }
  return out;
}

export function detect(opts: DetectOptions = {}): Detection {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const dotenv = opts.dotenvPath && existsSync(opts.dotenvPath) ? parseDotenv(readFileSync(opts.dotenvPath, 'utf8')) : {};
  const binaries = BINARIES.map((name): FoundBinary => {
    const hit = findExecutable(name, { env, platform });
    return { name, path: hit?.path ?? null, shim: hit?.shim ?? false };
  });
  const keys = KNOWN_KEYS.map((k): KeyStatus => {
    const fromEnv = envGet(env, k.name, platform)?.trim();
    const fromFile = dotenv[k.name]?.trim();
    return { ...k, present: Boolean(fromEnv || fromFile), source: fromEnv ? 'env' : fromFile ? '.env' : null };
  });
  return { platform, binaries, keys };
}

/** Quote one argument for cmd.exe when spawning a shim with `shell: true`. */
export function quoteWin(arg: string): string {
  return /^[A-Za-z0-9_\-./:=@\\]+$/.test(arg) ? arg : '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * `<binary> --version`, first line, or null if it does not answer in time. Proves the
 * binary actually runs (a broken shim is found here, not mid-run).
 */
export function probeVersion(bin: FoundBinary, timeoutMs = 8_000): Promise<string | null> {
  const path = bin.path;
  if (!path) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = bin.shim
      ? spawn(quoteWin(path) + ' --version', { shell: true, windowsHide: true })
      : spawn(path, ['--version'], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.trim());
      resolve(code === 0 && line ? line.trim() : null);
    });
  });
}

export function formatDetection(d: Detection, versions: Partial<Record<HarnessBinary, string | null>> = {}): string {
  const lines: string[] = ['Harnesses'];
  const label: Record<HarnessBinary, string> = { claude: 'Claude Code', codex: 'Codex' };
  for (const b of d.binaries) {
    if (!b.path) {
      lines.push(`  ✗ ${label[b.name]} (${b.name}) not on PATH`);
      continue;
    }
    const v = versions[b.name];
    lines.push(
      `  ✓ ${label[b.name]} ${b.path}${b.shim ? ' (shim)' : ''}` +
        (v === undefined ? '' : v ? `, ${v}` : ', did not answer --version'),
    );
  }
  if (!d.binaries.some((b) => b.path))
    lines.push('  No harness found: boards run on the scripted mock harness. Install Claude Code or Codex for real runs.');
  lines.push('Keys (values are never shown)');
  for (const k of d.keys) lines.push(`  ${k.present ? '✓' : '·'} ${k.name}${k.source ? ` (${k.source})` : ''} — ${k.enables}`);
  return lines.join('\n');
}

