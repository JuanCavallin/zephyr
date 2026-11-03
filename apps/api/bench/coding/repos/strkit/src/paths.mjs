/**
 * A repo-relative path with `.` and `..` resolved, or null when the input is
 * absolute or escapes the repo root.
 */
export function toRepoPath(input) {
  const parts = [];
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (input.startsWith('/')) return null;
  return parts.length > 0 ? parts.join('/') : null;
}
