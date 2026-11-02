/**
 * Is this path inside the run's worktree?
 *
 * Shared by the shell classifier (redirect targets, path-like arguments) and the
 * native descriptors (Read/Write/Edit targets). Fails closed: anything it cannot
 * resolve with certainty is "outside".
 *
 * Pure apart from one optional `realpath` of the nearest existing ancestor, which
 * catches a symlink or junction inside the worktree pointing out of it. That check
 * only runs when the caller's platform matches the host's, since a win32 path cannot
 * be realpath'd on posix and vice versa.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

export type ShellPlatform = 'posix' | 'win32';

export interface ContainmentContext {
  worktree: string;
  platform: ShellPlatform;
}

export interface Containment {
  inside: boolean;
  /** Absolute, normalized target. Absent when the path was rejected before resolving. */
  resolved?: string;
  /** Worktree-relative, forward slashes. Present only when `inside`. */
  relative?: string;
  /** True when the target is in `.git/` or `.claude/` — readable, never writable. */
  protectedSegment?: boolean;
  reason: string;
}

const PROTECTED_SEGMENTS = new Set(['.git', '.claude']);

export function hostPlatform(): ShellPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

/** Shapes that are rejected outright, whatever the platform. */
export function rejectedPathShape(target: string): string | null {
  if (target.length === 0) return 'empty path';
  if (target.includes('\0')) return 'NUL byte in path';
  if (target.startsWith('~')) return 'home-relative path';
  if (/^\\\\[?.]\\/.test(target) || /^\/\/[?.]\//.test(target)) return 'device or extended-length path';
  if (/^(\\\\|\/\/)[^\\/]/.test(target)) return 'UNC path';
  if (/^[A-Za-z]:(?![\\/])/.test(target)) return 'drive-relative path';
  return null;
}

function nearestExistingRealpath(target: string, p: path.PlatformPath): string | null {
  let current = target;
  const tail: string[] = [];
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? p.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return null;
      tail.push(p.basename(current));
      current = parent;
    }
  }
  return null;
}

function relativeInside(root: string, target: string, p: path.PlatformPath): string | null {
  const rel = p.relative(root, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return null;
  return rel;
}

export function containPath(target: string, ctx: ContainmentContext): Containment {
  const shape = rejectedPathShape(target);
  if (shape) return { inside: false, reason: shape };

  const p = ctx.platform === 'win32' ? path.win32 : path.posix;
  // A drive path in a posix context is never a real file the agent meant; refuse it.
  if (ctx.platform === 'posix' && /^[A-Za-z]:[\\/]/.test(target)) {
    return { inside: false, reason: 'Windows drive path on a posix worktree' };
  }
  const root = p.resolve(ctx.worktree);
  const resolved = p.resolve(root, target);
  const rel = relativeInside(root, resolved, p);
  if (rel === null) return { inside: false, resolved, reason: 'outside the worktree' };

  if (ctx.platform === hostPlatform()) {
    const realRoot = nearestExistingRealpath(root, p);
    const realTarget = nearestExistingRealpath(resolved, p);
    if (!realRoot || !realTarget || relativeInside(realRoot, realTarget, p) === null) {
      return { inside: false, resolved, reason: 'symlink or junction escapes the worktree' };
    }
  }

  const relative = rel.split(p.sep).join('/');
  const segments = relative.split('/').map((s) => (ctx.platform === 'win32' ? s.toLowerCase() : s));
  return {
    inside: true,
    resolved,
    relative,
    protectedSegment: segments.some((s) => PROTECTED_SEGMENTS.has(s)),
    reason: 'inside the worktree',
  };
}
