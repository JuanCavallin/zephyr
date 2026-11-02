/**
 * Minimal repo-path glob matching for verification policy: `**` crosses directories,
 * `*` and `?` stay within one segment, `{a,b}` alternates. Paths are POSIX repo paths.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      depth += 1;
      out += '(?:';
    } else if (c === '}' && depth > 0) {
      depth -= 1;
      out += ')';
    } else if (c === ',' && depth > 0) out += '|';
    else out += /[.+^$()|[\]\\]/.test(c) ? '\\' + c : c;
  }
  const re = new RegExp('^' + out + '$');
  cache.set(glob, re);
  return re;
}

/** True when `path` matches the glob. A glob with no slash also matches the basename. */
export function matchesGlob(path: string, glob: string): boolean {
  if (globToRegExp(glob).test(path)) return true;
  if (!glob.includes('/')) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return globToRegExp(glob).test(base);
  }
  return false;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}
