/**
 * Deterministic shell command classifier.
 *
 * Spec §1 "Native tools become exact actions": a coding agent's shell call is
 * classified by argv[0] + subcommand against an allowlist, and **any** syntax the
 * parser cannot fully account for — command separators, substitution, variables,
 * escapes, redirects outside the worktree, a pipe into a shell — is `unknown`,
 * which the broker treats as needing approval. Jev is never asked whether a shell
 * command is safe.
 *
 * This is a policy filter, not a sandbox (spec §9): `pnpm test` runs whatever the
 * worktree's package.json says. What it guarantees is that nothing outside the
 * allowlist runs without a human seeing the exact command.
 */

import { containPath, rejectedPathShape, type ShellPlatform } from './pathContainment.js';

export type ShellClass = 'inspect' | 'verify' | 'mutate_env' | 'network' | 'unknown';

export interface ShellClassification {
  class: ShellClass;
  reversible: boolean;
  reason: string;
  /** The allowlist entry that matched, e.g. `git status` or `pnpm test`. */
  matched?: string;
}

export interface ShellContext {
  worktree: string;
  platform: ShellPlatform;
}

export interface ShellRedirect {
  op: '>' | '>>' | '<';
  target: string;
}

export interface ShellStage {
  argv: string[];
  redirects: ShellRedirect[];
}

export type ShellParse = { ok: true; stages: ShellStage[] } | { ok: false; reason: string };

const SEVERITY: Record<ShellClass, number> = {
  inspect: 0,
  verify: 1,
  mutate_env: 2,
  network: 3,
  unknown: 4,
};

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split a command line into pipeline stages of plain words and redirects.
 * Returns `ok: false` on anything outside the small grammar it understands.
 */
export function parseShell(command: string, platform: ShellPlatform): ShellParse {
  const fail = (reason: string): ShellParse => ({ ok: false, reason });
  const stages: ShellStage[] = [];
  let argv: string[] = [];
  let redirects: ShellRedirect[] = [];
  let word = '';
  let inWord = false;
  let pendingRedirect: ShellRedirect['op'] | null = null;

  const endWord = (): string | null => {
    if (!inWord) return null;
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      argv.push(word);
    }
    word = '';
    inWord = false;
    return null;
  };
  const endStage = (): string | null => {
    endWord();
    if (pendingRedirect) return 'redirect without a target';
    if (argv.length === 0) return 'empty pipeline stage';
    stages.push({ argv, redirects });
    argv = [];
    redirects = [];
    return null;
  };

  const s = command.trim();
  if (!s) return fail('empty command');

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];

    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return fail('unterminated single quote');
      word += s.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        const q = s[j]!;
        if (q === '$' || q === '`' || q === '\\' || (platform === 'win32' && q === '%')) {
          return fail('expansion or escape inside double quotes');
        }
      }
      if (j >= s.length) return fail('unterminated double quote');
      word += s.slice(i + 1, j);
      inWord = true;
      i = j;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === '|') {
      if (next === '|') return fail('`||` command list');
      const err = endStage();
      if (err) return fail(err);
      continue;
    }
    if (c === '>' || c === '<') {
      // `2>&1` / `>&2`: fd duplication, no file involved.
      const fdPrefix = inWord && /^[0-9]$/.test(word);
      if (inWord && !fdPrefix) endWord();
      if (fdPrefix) {
        word = '';
        inWord = false;
      }
      if (pendingRedirect) return fail('double redirect');
      if (c === '>' && next === '&') {
        const fd = s[i + 2];
        if (fd && /[0-9]/.test(fd) && (s[i + 3] === undefined || /\s/.test(s[i + 3]!))) {
          i += 2;
          continue;
        }
        return fail('unsupported `>&` redirect');
      }
      if (c === '>' && next === '>') {
        pendingRedirect = '>>';
        i++;
      } else if (c === '<' && next === '<') {
        return fail('here-document');
      } else {
        pendingRedirect = c;
      }
      if (s[i + 1] === '(') return fail('process substitution');
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r') return fail('command separator');
    if (c === '&') return fail(next === '&' ? '`&&` command list' : 'background or `&` operator');
    if (c === '$') return fail('variable or command substitution');
    if (c === '`') return fail(platform === 'win32' ? 'PowerShell escape character' : 'backtick substitution');
    if (c === '(' || c === ')' || c === '{' || c === '}') return fail('subshell, group or script block');
    if (c === '#' && !inWord) return fail('comment');
    if (c === '!' && !inWord) return fail('history expansion or negation');
    if (c === '\\' && platform === 'posix') return fail('backslash escape');
    if (platform === 'win32' && (c === '%' || c === '^')) return fail('cmd variable or escape');
    if (c === '@' && !inWord && platform === 'win32') return fail('PowerShell splatting');

    word += c;
    inWord = true;
  }

  const err = endStage();
  if (err) return fail(err);
  return { ok: true, stages };
}

/* -------------------------------------------------------------------------- */
/* Allowlist                                                                  */
/* -------------------------------------------------------------------------- */

type Rule = { class: Exclude<ShellClass, 'unknown'>; matched: string } | { unknown: string };

const INSPECT_BINARIES = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'grep', 'egrep', 'fgrep', 'rg',
  'tree', 'stat', 'which', 'diff', 'file', 'du', 'cut', 'tr', 'basename', 'dirname',
  'realpath', 'true', 'false', 'printf', 'nl', 'cmp', 'type',
]);

/** PowerShell cmdlets and their aliases (case-insensitive). */
const INSPECT_CMDLETS = new Set([
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'gl', 'select-string', 'sls',
  'test-path', 'get-item', 'gi', 'write-output', 'measure-object', 'measure',
  'select-object', 'select', 'sort-object', 'format-table', 'ft', 'format-list', 'fl',
  'out-string', 'resolve-path', 'split-path', 'join-path', 'get-command', 'gcm',
]);

const GIT_INSPECT = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'grep', 'describe',
  'shortlog', 'reflog', 'cat-file', 'ls-tree', 'merge-base', 'name-rev', 'whatchanged',
]);
const GIT_LOCAL_WRITE = new Set(['add', 'commit']);
const GIT_NETWORK = new Set(['fetch', 'pull', 'clone', 'push', 'ls-remote', 'submodule']);

const JS_PMS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const JS_VERIFY_SCRIPTS = new Set(['test', 'lint', 'typecheck', 'build', 'check', 'tsc']);
const JS_INSTALL = new Set(['install', 'i', 'add', 'ci', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'link']);

const NETWORK_BINARIES = new Set([
  'curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'ssh', 'scp',
  'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'gh',
]);
const PACKAGE_MANAGERS = new Set([
  'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk', 'choco', 'winget', 'scoop',
  'install-module', 'install-package', 'gem', 'npx', 'pnpx', 'bunx', 'pipx',
]);
const POWERSHELL = new Set(['powershell', 'pwsh']);

function hasArg(argv: string[], ...flags: string[]): boolean {
  return argv.some((a) => flags.some((f) => a === f || a.startsWith(f + '=')));
}

function commandName(raw: string, platform: ShellPlatform): string | null {
  // A path to a binary (`./ls`, `/usr/bin/curl`, `C:\x.exe`) is never on the allowlist:
  // the worktree could hold a planted script with an innocent name.
  if (raw.includes('/') || raw.includes('\\')) return null;
  if (raw.includes('=')) return null; // `FOO=bar cmd` env prefix
  let name = raw;
  if (platform === 'win32' || name.includes('-')) name = name.toLowerCase();
  if (platform === 'win32') name = name.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return name;
}

function classifyStage(stage: ShellStage, platform: ShellPlatform): Rule {
  const name = commandName(stage.argv[0]!, platform);
  if (!name) return { unknown: 'command is a path or env assignment: ' + stage.argv[0] };
  const args = stage.argv.slice(1);
  const sub = args[0];

  if (POWERSHELL.has(name)) {
    if (hasArg(args.map((a) => a.toLowerCase()), '-enc', '-e', '-ec', '-encodedcommand')) {
      return { unknown: 'encoded PowerShell command' };
    }
    return { unknown: 'nested PowerShell invocation' };
  }

  if (name === 'git') {
    if (!sub || sub.startsWith('-')) return { unknown: 'git global option before subcommand' };
    if (hasArg(args, '--output', '-O', '--open-files-in-pager', '--ext-diff', '--upload-pack', '--exec')) {
      return { unknown: 'git option that writes files or runs programs' };
    }
    if (GIT_INSPECT.has(sub)) return { class: 'inspect', matched: 'git ' + sub };
    if (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'stash') {
      const listing =
        sub === 'stash'
          ? args[1] === 'list' || args[1] === 'show'
          : args.length === 1 || args.slice(1).every((a) => /^(-a|-r|-v|-vv|--list|-l|--all|--show-current|list|show)$/.test(a));
      if (listing) return { class: 'inspect', matched: 'git ' + sub + ' (list)' };
      return { unknown: 'git ' + sub + ' that changes refs or config' };
    }
    if (GIT_LOCAL_WRITE.has(sub)) {
      return { class: 'verify', matched: 'git ' + sub };
    }
    if (GIT_NETWORK.has(sub)) return { class: 'network', matched: 'git ' + sub };
    return { unknown: 'git subcommand not on the allowlist: ' + sub };
  }

  if (JS_PMS.has(name)) {
    if (!sub || sub.startsWith('-')) return { unknown: name + ' flag before subcommand' };
    if (sub === 'test' || sub === 't') return { class: 'verify', matched: name + ' test' };
    if (sub === 'run' && args[1] && JS_VERIFY_SCRIPTS.has(args[1])) {
      return { class: 'verify', matched: name + ' run ' + args[1] };
    }
    if (name !== 'npm' && JS_VERIFY_SCRIPTS.has(sub)) return { class: 'verify', matched: name + ' ' + sub };
    if (JS_INSTALL.has(sub)) return { class: 'mutate_env', matched: name + ' ' + sub };
    return { unknown: name + ' subcommand not on the allowlist: ' + sub };
  }

  if (name === 'pip' || name === 'pip3' || name === 'uv' || name === 'poetry') {
    if (sub === 'install' || sub === 'uninstall' || sub === 'add' || sub === 'remove' || sub === 'sync' || sub === 'pip') {
      return { class: 'mutate_env', matched: name + ' ' + sub };
    }
    if (sub === 'list' || sub === 'show' || sub === 'freeze') return { class: 'inspect', matched: name + ' ' + sub };
    return { unknown: name + ' subcommand not on the allowlist: ' + (sub ?? '') };
  }

  if (name === 'python' || name === 'python3' || name === 'py') {
    if (sub === '-m' && (args[1] === 'pytest' || args[1] === 'unittest')) {
      return { class: 'verify', matched: name + ' -m ' + args[1] };
    }
    if (sub === '-m' && args[1] === 'pip' && (args[2] === 'install' || args[2] === 'uninstall')) {
      return { class: 'mutate_env', matched: name + ' -m pip ' + args[2] };
    }
    return { unknown: 'python invocation can run arbitrary code' };
  }
  if (name === 'pytest' || name === 'py.test') return { class: 'verify', matched: 'pytest' };
  if (name === 'tsc') return { class: 'verify', matched: 'tsc' };
  if (name === 'vitest' || name === 'jest') return { class: 'verify', matched: name };

  if (name === 'cargo') {
    if (sub && ['test', 'check', 'build', 'clippy'].includes(sub)) return { class: 'verify', matched: 'cargo ' + sub };
    if (sub && ['add', 'install', 'remove', 'update'].includes(sub)) return { class: 'mutate_env', matched: 'cargo ' + sub };
    return { unknown: 'cargo subcommand not on the allowlist: ' + (sub ?? '') };
  }
  if (name === 'go') {
    if (sub && ['test', 'vet', 'build'].includes(sub)) return { class: 'verify', matched: 'go ' + sub };
    if (sub && ['get', 'install', 'mod'].includes(sub)) return { class: 'mutate_env', matched: 'go ' + sub };
    return { unknown: 'go subcommand not on the allowlist: ' + (sub ?? '') };
  }

  if (PACKAGE_MANAGERS.has(name)) return { class: 'mutate_env', matched: name };
  if (NETWORK_BINARIES.has(name)) return { class: 'network', matched: name };

  if (name === 'find') {
    if (hasArg(args, '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls')) {
      return { unknown: 'find action that runs commands or writes files' };
    }
    return { class: 'inspect', matched: 'find' };
  }
  if (name === 'rg' && hasArg(args, '--pre')) return { unknown: 'rg --pre runs a program' };
  if (name === 'sort' && hasArg(args, '-o', '--output')) return { unknown: 'sort -o writes a file' };
  if (name === 'sort') return { class: 'inspect', matched: 'sort' };
  if (INSPECT_BINARIES.has(name)) return { class: 'inspect', matched: name };
  if (INSPECT_CMDLETS.has(name)) return { class: 'inspect', matched: name };

  return { unknown: 'command not on the allowlist: ' + name };
}

/** A path-like argument, or the value half of `--flag=value`. */
function pathCandidates(arg: string): string[] {
  const value = /^--?[A-Za-z][\w-]*[=:](.*)$/.exec(arg)?.[1];
  const out = value !== undefined ? [value] : [];
  if (!arg.startsWith('-') || arg === '-') out.push(arg);
  return out.filter((a) => a.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a));
}

function looksLikePath(arg: string): boolean {
  return (
    arg.startsWith('/') ||
    arg.startsWith('\\') ||
    arg.startsWith('~') ||
    /^[A-Za-z]:/.test(arg) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(arg)
  );
}

const NULL_DEVICES = new Set(['/dev/null', 'nul', '$null']);

function checkPaths(stage: ShellStage, ctx: ShellContext): string | null {
  for (const arg of stage.argv.slice(1)) {
    for (const candidate of pathCandidates(arg)) {
      if (!looksLikePath(candidate)) continue;
      const shape = rejectedPathShape(candidate);
      if (shape) return shape + ': ' + candidate;
      if (!containPath(candidate, ctx).inside) return 'argument outside the worktree: ' + candidate;
    }
  }
  for (const r of stage.redirects) {
    if (NULL_DEVICES.has(r.target.toLowerCase())) continue;
    const contained = containPath(r.target, ctx);
    if (!contained.inside) return 'redirect outside the worktree: ' + r.op + ' ' + r.target;
    if (r.op !== '<' && contained.protectedSegment) return 'redirect into .git or .claude: ' + r.target;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* classifyShell                                                              */
/* -------------------------------------------------------------------------- */

function unknown(reason: string): ShellClassification {
  return { class: 'unknown', reversible: false, reason };
}

export function classifyShell(cmd: string, ctx: ShellContext): ShellClassification {
  const parsed = parseShell(cmd, ctx.platform);
  if (!parsed.ok) return unknown('unparseable: ' + parsed.reason);

  let worst: ShellClassification | null = null;
  const matched: string[] = [];
  for (const stage of parsed.stages) {
    const rule = classifyStage(stage, ctx.platform);
    if ('unknown' in rule) {
      return unknown(parsed.stages.length > 1 ? 'pipeline stage: ' + rule.unknown : rule.unknown);
    }
    const pathProblem = checkPaths(stage, ctx);
    if (pathProblem) return unknown(pathProblem);
    matched.push(rule.matched);
    if (!worst || SEVERITY[rule.class] > SEVERITY[worst.class]) {
      worst = {
        class: rule.class,
        reversible: rule.class === 'inspect' || rule.class === 'verify',
        reason: '',
      };
    }
  }

  const result = worst!;
  const label = matched.join(' | ');
  result.matched = label;
  result.reason =
    result.class === 'inspect'
      ? 'read-only command: ' + label
      : result.class === 'verify'
        ? 'test/build or worktree-local command: ' + label
        : result.class === 'mutate_env'
          ? 'changes the environment outside the worktree: ' + label
          : 'reaches the network: ' + label;
  return result;
}
