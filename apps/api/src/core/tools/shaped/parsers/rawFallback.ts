/**
 * Plain-text test output: what is left when a runner wrote neither JUnit nor TAP.
 *
 * Recognises the failure lines and summary lines of the common runners (vitest,
 * jest, pytest, mocha, go test, cargo test). Failing ids come from failure lines;
 * counts come from a summary line when one exists, otherwise from counting
 * pass/fail lines. The trace of a failure is the block that follows its first
 * detail anchor (jest's `●`, pytest's `____ name ____`, go's `--- FAIL:`, …), cut
 * at the next anchor.
 *
 * It never invents a pass: output with no recognisable test lines at all yields
 * total 0, and the caller reports the exit code alongside the digest.
 */

import type { ParsedFailure, ParsedTests } from '../types.js';

/** Lines that name one failing test. Group 1 is the id, group 2 an optional message. */
const FAILURE_LINES: RegExp[] = [
  // vitest/jest per-test, with an optional `3ms` / `[3ms]` duration. Not go's
  // package summary `FAIL<TAB>example.com/pkg<TAB>0.01s`, which names no test.
  /^\s*(?:FAIL|×|✗|✕|❌)(?!\t\S+\t[\d.]+s\s*$)\s+(.+?)(?:\s+\[?\d+(?:\.\d+)?m?s\]?)?\s*$/,
  /^FAILED\s+(\S+)(?:\s+-\s+(.*))?$/, // pytest short summary
  /^(\S+::\S+)\s+FAILED\b/, // pytest -v
  /^\s*--- FAIL: (\S+)/, // go test
  /^test (\S+) \.\.\. FAILED$/, // cargo test
];

const PASS_LINES: RegExp[] = [
  /^\s*(?:✓|√|✔)\s+/,
  /^\s*--- PASS: /,
  /^test \S+ \.\.\. ok$/,
  /^(\S+::\S+)\s+PASSED\b/,
];

/** Lines that open a failure's detail section. Group 1 holds (part of) the id. */
const ANCHORS: RegExp[] = [
  /^\s*● (.+)$/, // jest
  /^_{3,} (.+?) _{3,}$/, // pytest
  /^=== RUN\s+(\S+)/, // go -v: the test's log lines come before its --- FAIL
  /^\s*--- FAIL: (\S+)/, // go
  /^---- (\S+) stdout ----$/, // cargo
  /^\s*(?:FAIL|×)\s+(.+?)\s*$/, // vitest detail header
  /^\s*\d+\) (.+)$/, // mocha
];

const ASSERTION =
  /(AssertionError|Assertion|assert|Expected|expected|Received|toBe|toEqual|panicked at|Error:|E\s{2,}|FAIL)/;

const TRACE_LIMIT = 80;

interface Summary {
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
}

function num(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Number(text);
}

function summary(text: string): Summary | null {
  // jest: "Tests:       2 failed, 1 skipped, 8 passed, 11 total"
  const jest = /^Tests:\s+(.*?(\d+) total)\s*$/m.exec(text);
  if (jest) {
    const part = (word: string) => num(new RegExp('(\\d+) ' + word).exec(jest[1]!)?.[1]);
    return { failed: part('failed'), passed: part('passed'), skipped: part('skipped'), total: num(jest[2]) };
  }
  // vitest: "Tests  2 failed | 8 passed (10)"
  const vitest = /^\s*Tests\s+(.*?)\((\d+)\)\s*$/m.exec(text);
  if (vitest) {
    const part = (word: string) => num(new RegExp('(\\d+) ' + word).exec(vitest[1]!)?.[1]);
    return { failed: part('failed'), passed: part('passed'), skipped: part('skipped'), total: num(vitest[2]) };
  }
  // pytest: "==== 2 failed, 8 passed, 1 skipped in 0.12s ===="
  const pytest = /^=+ (.*?\d+ (?:passed|failed|error).*?) in [\d.]+s.*=+\s*$/m.exec(text);
  if (pytest) {
    const part = (word: string) => num(new RegExp('(\\d+) ' + word).exec(pytest[1]!)?.[1]);
    const failed = (part('failed') ?? 0) + (part('errors?') ?? 0);
    const passed = part('passed') ?? 0;
    const skipped = part('skipped') ?? 0;
    return { failed, passed, skipped, total: failed + passed + skipped };
  }
  // cargo: "test result: FAILED. 3 passed; 1 failed; 0 ignored; ..."
  const cargo = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/m.exec(text);
  if (cargo) {
    const [passed, failed, skipped] = [Number(cargo[1]), Number(cargo[2]), Number(cargo[3])];
    return { passed, failed, skipped, total: passed + failed + skipped };
  }
  // mocha: "  8 passing (12ms)" / "  2 failing"
  const passing = /^\s*(\d+) passing\b/m.exec(text);
  if (passing) {
    const failed = Number(/^\s*(\d+) failing\b/m.exec(text)?.[1] ?? 0);
    const skipped = Number(/^\s*(\d+) pending\b/m.exec(text)?.[1] ?? 0);
    const passed = Number(passing[1]);
    return { passed, failed, skipped, total: passed + failed + skipped };
  }
  return null;
}

function lastSegment(id: string): string {
  const parts = id.split(/::|›|>|\s+\/\s+/);
  return parts[parts.length - 1]!.trim();
}

/** A rule line (vitest's `⎯⎯⎯`, pytest's `=== short test summary ===`) ends a trace. */
const RULE = /^\s*[⎯─━=]{3,}/;

function blockAt(start: number, lines: string[], anchors: number[]): string[] {
  const next = anchors.find((i) => i > start) ?? lines.length;
  const block: string[] = [];
  for (let i = start + 1; i < Math.min(next, start + 1 + TRACE_LIMIT); i++) {
    if (RULE.test(lines[i]!)) break;
    block.push(lines[i]!);
  }
  while (block.length && !block[block.length - 1]!.trim()) block.pop();
  while (block.length && !block[0]!.trim()) block.shift();
  return block;
}

/**
 * The trace of a failure. A runner may mention one test at several anchors
 * (vitest: a one-line `×` row, then a `FAIL` section with the assertion; go -v:
 * `=== RUN` before the log, `--- FAIL` after it), so the richest block wins.
 */
function traceFor(id: string, lines: string[], anchors: number[]): { trace: string; assertion: string } {
  const tail = lastSegment(id);
  let block: string[] = [];
  for (const start of anchors) {
    const line = lines[start]!;
    if (!(line.includes(id) || (tail.length > 2 && line.includes(tail)))) continue;
    const candidate = blockAt(start, lines, anchors);
    if (candidate.join('\n').length > block.join('\n').length) block = candidate;
  }
  const assertion = block.find((l) => ASSERTION.test(l))?.trim() ?? block[0]?.trim() ?? '';
  return { trace: block.join('\n'), assertion };
}

export function parseRawTestOutput(text: string): ParsedTests {
  // Strip ANSI colour: runners colour even when piped unless told not to.
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = clean.split(/\r?\n/);
  const ids: { id: string; message?: string }[] = [];
  const seen = new Set<string>();
  let passLines = 0;
  const anchors: number[] = [];

  lines.forEach((line, index) => {
    if (ANCHORS.some((re) => re.test(line))) anchors.push(index);
    if (PASS_LINES.some((re) => re.test(line))) passLines++;
    for (const re of FAILURE_LINES) {
      const m = re.exec(line);
      if (!m) continue;
      const id = m[1]!.trim();
      // vitest prints `FAIL  path/to/file.test.ts > suite > case`; a bare file path
      // header is followed by per-case lines, so only skip exact duplicates.
      if (!seen.has(id)) {
        seen.add(id);
        ids.push({ id, ...(m[2] ? { message: m[2].trim() } : {}) });
      }
      break;
    }
  });

  // A vitest/jest file header ("FAIL src/a.test.ts") is redundant once a case in
  // that file is listed as "FAIL src/a.test.ts > suite > case".
  const filtered = ids.filter(
    ({ id }) => !ids.some((other) => other.id !== id && other.id.startsWith(id + ' > ')),
  );

  const failures: ParsedFailure[] = filtered.map(({ id, message }) => {
    const { trace, assertion } = traceFor(id, lines, anchors);
    const best = message || assertion || 'failed';
    return { id, assertion: best, trace: trace || best, detail: trace || best };
  });

  const s = summary(clean);
  const failed = s?.failed ?? failures.length;
  const skipped = s?.skipped ?? 0;
  const passed = s?.passed ?? passLines;
  const total = s?.total ?? passed + failed + skipped;
  return { format: 'raw', total, passed, failed: Math.max(failed, failures.length), skipped, failures };
}
