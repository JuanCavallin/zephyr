/**
 * TAP 13/14, including node:test's indented subtests and YAML diagnostic blocks.
 *
 * Only leaf test points are counted: in node:test a suite reports its own
 * `ok`/`not ok` after its children, and counting it would double every failure.
 * A test point is a parent when the test point just before it was more deeply
 * indented. Ids are the `# Subtest:` path joined with ` > `.
 */

import type { ParsedFailure, ParsedTests } from '../types.js';

const POINT = /^(\s*)(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*)$/;
const SUBTEST = /^(\s*)# Subtest: (.*)$/;

export function looksLikeTap(text: string): boolean {
  return /^TAP version \d+/m.test(text) || /^\s*(not )?ok \d+ /m.test(text);
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** `error:` / `message:` from a YAML block, including `|-` multi-line values. */
function yamlField(block: string[], names: string[]): string | undefined {
  for (let i = 0; i < block.length; i++) {
    const m = /^(\s*)([A-Za-z_]+):\s*(.*)$/.exec(block[i]!);
    if (!m || !names.includes(m[2]!)) continue;
    const value = m[3]!;
    if (/^[|>]-?$/.test(value)) {
      const indent = m[1]!.length;
      const lines: string[] = [];
      for (let j = i + 1; j < block.length; j++) {
        const line = block[j]!;
        if (line.trim() && line.length - line.trimStart().length <= indent) break;
        lines.push(line.trim());
      }
      return lines.join('\n').trim();
    }
    return unquote(value);
  }
  return undefined;
}

export function parseTap(text: string): ParsedTests {
  const lines = text.split(/\r?\n/);
  const failures: ParsedFailure[] = [];
  const subtests: { indent: number; name: string }[] = [];
  let total = 0;
  let passed = 0;
  let skipped = 0;
  let previousIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sub = SUBTEST.exec(line);
    if (sub) {
      const indent = sub[1]!.length;
      while (subtests.length && subtests[subtests.length - 1]!.indent >= indent) subtests.pop();
      subtests.push({ indent, name: sub[2]!.trim() });
      continue;
    }
    const point = POINT.exec(line);
    if (!point) continue;
    const indent = point[1]!.length;
    const isParent = previousIndent > indent;
    previousIndent = indent;

    // YAML diagnostics follow the test point, opened by `---` and closed by `...`.
    const block: string[] = [];
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      for (; j < lines.length && lines[j]!.trim() !== '...'; j++) block.push(lines[j]!);
      i = j;
    }

    const [description = '', directive = ''] = point[4]!.split(/\s+#\s+/, 2);
    const ancestors = subtests.filter((s) => s.indent < indent).map((s) => s.name);
    while (subtests.length && subtests[subtests.length - 1]!.indent >= indent) subtests.pop();
    if (isParent) continue;

    total++;
    if (/^skip\b/i.test(directive)) {
      skipped++;
      continue;
    }
    if (point[2] === 'ok' || /^todo\b/i.test(directive)) {
      passed++;
      continue;
    }
    const id = [...ancestors, description.trim() || 'test ' + (point[3] ?? total)].join(' > ');
    const assertion = yamlField(block, ['error', 'message']) ?? 'failed';
    const stack = yamlField(block, ['stack', 'at']);
    const all = block.map((l) => l.trim()).join('\n');
    failures.push({ id, assertion, trace: stack ?? (all || assertion), detail: all || assertion });
  }
  return { format: 'tap', total, passed, failed: failures.length, skipped, failures };
}
