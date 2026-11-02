/**
 * Step 5, lever L2: a deterministic index of a worktree, the input to the context
 * pack. Per file: path, exported names, top-level symbols, imports and the first
 * doc comment. No model is involved; the same tree always yields the same index.
 *
 * The index is cached by tree hash. In a git worktree the hash is HEAD's tree
 * plus the porcelain status and the size/mtime of every changed file, so an
 * uncommitted edit invalidates it; elsewhere it is a hash of every file's path,
 * size and mtime.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface IndexedFile {
  path: string;
  /** Names the file exports (or, for Python/Go, defines at top level). */
  exports: string[];
  /** Every top-level declaration found, exported or not. */
  symbols: string[];
  /** Import specifiers as written (`./foo`, `../lib/bar.js`, `os.path`). */
  imports: string[];
  /** First doc comment or docstring, collapsed to one line, capped at 160 chars. */
  doc: string;
  size: number;
  isTest: boolean;
}

export interface RepoIndex {
  root: string;
  treeHash: string;
  files: IndexedFile[];
  /** Whether `root` is a git worktree; candidates use `git log` only when it is. */
  git: boolean;
}

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.cs', '.php', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.vue', '.svelte',
]);

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo',
  'vendor', 'target', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
]);

/** Above this a file is listed by path only (generated bundles, fixtures). */
const MAX_PARSE_BYTES = 256 * 1024;
/** A hard ceiling so a monorepo cannot make indexing unbounded. */
const MAX_FILES = 5000;

const TEST_FILE = /(^|[/\\])(tests?|__tests__|spec)[/\\]|\.(test|spec)\.[a-z]+$|(^|[/\\])test_[^/\\]+\.py$|_test\.(py|go)$/i;

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  return out.sort();
}

/** Source files, sorted, POSIX separators. Git-tracked plus untracked-not-ignored when in git. */
async function listFiles(root: string): Promise<{ files: string[]; git: boolean }> {
  const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (listed === null) return { files: await walk(root), git: false };
  const files = listed
    .split('\0')
    .filter((p) => p && SOURCE_EXTENSIONS.has(extname(p)))
    .filter((p) => !p.split('/').some((part) => IGNORED_DIRS.has(part)));
  return { files: [...new Set(files)].sort().slice(0, MAX_FILES), git: true };
}

async function statLine(root: string, path: string): Promise<string> {
  try {
    const s = await stat(join(root, path));
    return `${path}\0${s.size}\0${Math.floor(s.mtimeMs)}`;
  } catch {
    return `${path}\0missing`;
  }
}

/** Identity of the tree's current content; equal hashes mean an equal index. */
export async function treeHash(root: string): Promise<string> {
  const h = createHash('sha256');
  const head = await git(root, ['rev-parse', 'HEAD^{tree}']);
  if (head !== null) {
    const status = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) ?? '';
    h.update('git\0' + head.trim() + '\0' + status);
    const changed = status
      .split('\0')
      .map((line) => line.slice(3))
      .filter(Boolean)
      .sort();
    for (const path of changed) h.update(await statLine(root, path));
    return h.digest('hex').slice(0, 32);
  }
  const { files } = await listFiles(root);
  h.update('fs\0');
  for (const path of files) h.update(await statLine(root, path));
  return h.digest('hex').slice(0, 32);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function firstDoc(text: string, ext: string): string {
  let m: RegExpExecArray | null = null;
  if (ext === '.py') m = /^\s*(?:#[^\n]*\n\s*)*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(text);
  else m = /\/\*\*([\s\S]*?)\*\//.exec(text) ?? /^((?:\s*\/\/[^\n]*\n)+)/.exec(text);
  if (!m) return '';
  const line = m[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\*|\/\/+|#)\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'))
    .join(' ');
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}

/** Exports, top-level symbols and imports, by regex: deterministic and dependency-free. */
export function parseSource(path: string, text: string): Pick<IndexedFile, 'exports' | 'symbols' | 'imports' | 'doc'> {
  const ext = extname(path);
  const exports: string[] = [];
  const symbols: string[] = [];
  const imports: string[] = [];
  const all = (re: RegExp, into: string[][], group = 1) => {
    for (const m of text.matchAll(re)) for (const list of into) list.push(m[group]!);
  };
  if (ext === '.py') {
    all(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, [symbols]);
    all(/^class\s+([A-Za-z_]\w*)/gm, [symbols]);
    all(/^([A-Z_][A-Z0-9_]*)\s*=/gm, [symbols]);
    exports.push(...symbols.filter((s) => !s.startsWith('_')));
    all(/^\s*from\s+([.\w]+)\s+import\b/gm, [imports]);
    all(/^\s*import\s+([.\w]+)/gm, [imports]);
  } else if (ext === '.go') {
    all(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, [symbols]);
    all(/^type\s+([A-Za-z_]\w*)/gm, [symbols]);
    exports.push(...symbols.filter((s) => /^[A-Z]/.test(s)));
    all(/^\s*(?:import\s+)?"([^"]+)"\s*$/gm, [imports]);
  } else if (ext === '.rs') {
    all(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod)\s+([A-Za-z_]\w*)/gm, [exports, symbols]);
    all(/^(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, [symbols]);
    all(/^\s*use\s+([\w:]+)/gm, [imports]);
  } else {
    // JS/TS and the C-like rest: `export` forms first, then plain declarations.
    all(
      /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/gm,
      [exports, symbols],
    );
    for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exports.push(name);
      }
    }
    all(/^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm, [symbols]);
    all(/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, [symbols]);
    all(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, [symbols]);
    all(/\bfrom\s+['"]([^'"]+)['"]/g, [imports]);
    all(/\bimport\s+['"]([^'"]+)['"]/g, [imports]);
    all(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, [imports]);
  }
  return { exports: uniq(exports), symbols: uniq(symbols), imports: uniq(imports), doc: firstDoc(text, ext) };
}

async function indexFile(root: string, path: string): Promise<IndexedFile> {
  const base = { path, exports: [], symbols: [], imports: [], doc: '', size: 0, isTest: isTestPath(path) };
  try {
    const s = await stat(join(root, path));
    if (!s.isFile()) return base;
    if (s.size > MAX_PARSE_BYTES) return { ...base, size: s.size };
    const text = await readFile(join(root, path), 'utf8');
    return { ...base, size: s.size, ...parseSource(path, text) };
  } catch {
    return base;
  }
}

const cache = new Map<string, RepoIndex>();
const CACHE_LIMIT = 16;

/** Index `root`, reusing the cached index while the tree hash is unchanged. */
export async function buildRepoIndex(root: string): Promise<RepoIndex> {
  const hash = await treeHash(root);
  const key = root + '\0' + hash;
  const hit = cache.get(key);
  if (hit) return hit;
  const { files, git: isGit } = await listFiles(root);
  const indexed: IndexedFile[] = [];
  // Bounded parallelism: indexing thousands of files must not exhaust handles.
  for (let i = 0; i < files.length; i += 64) {
    indexed.push(...(await Promise.all(files.slice(i, i + 64).map((p) => indexFile(root, p)))));
  }
  const index: RepoIndex = { root, treeHash: hash, files: indexed, git: isGit };
  cache.set(key, index);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return index;
}

/** One line per file for a decision model or a map: never file contents. */
export function fileSummary(file: IndexedFile): string {
  const parts: string[] = [];
  if (file.doc) parts.push(file.doc);
  if (file.exports.length > 0) parts.push('exports ' + file.exports.slice(0, 8).join(', '));
  else if (file.symbols.length > 0) parts.push('defines ' + file.symbols.slice(0, 8).join(', '));
  if (file.isTest) parts.push('test');
  const line = parts.join('; ');
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
}

/** `git <args>` in `root`; null when git is missing or the command fails. */
export { git as runGit };
