/**
 * Compiler and linter diagnostics: tsc, eslint (stylish and unix), gcc-style
 * `file:line:col: error: msg`, rustc/clippy and go vet.
 *
 * Each diagnostic gets an id (`file:line:col CODE`) that `zephyr_test_output`
 * accepts, returning the diagnostic with the lines that followed it in the log.
 */

import type { Diagnostic } from '../types.js';

export interface ParsedDiagnostics {
  diagnostics: (Diagnostic & { detail: string })[];
}

type Severity = Diagnostic['severity'];

function severity(word: string | undefined): Severity {
  return word && /warn/i.test(word) ? 'warning' : 'error';
}

function makeId(file: string | undefined, line?: number, col?: number, code?: string): string {
  const where = file ? file + (line ? ':' + line + (col ? ':' + col : '') : '') : 'output';
  return code ? where + ' ' + code : where;
}

/** Lines after index `i` that belong to the same diagnostic (indented or code frames). */
function continuation(lines: string[], i: number, limit = 12): string[] {
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && out.length < limit; j++) {
    const line = lines[j]!;
    if (!line.trim()) break;
    if (!/^\s/.test(line) && !/^\s*[|>^~]|^\s*\d+\s*\|/.test(line)) break;
    out.push(line);
  }
  return out;
}

export function parseDiagnostics(text: string): ParsedDiagnostics {
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = clean.split(/\r?\n/);
  const diagnostics: ParsedDiagnostics['diagnostics'] = [];
  const seen = new Set<string>();
  let eslintFile: string | undefined;

  const push = (d: Omit<Diagnostic, 'id'>, i: number) => {
    const id = makeId(d.file, d.line, d.column, d.code);
    const key = id + '\u0000' + d.message;
    if (seen.has(key)) return;
    seen.add(key);
    const detail = [lines[i]!, ...continuation(lines, i)].join('\n');
    diagnostics.push({ id, ...d, detail });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    // tsc --pretty false: src/a.ts(12,5): error TS2322: Type ...
    if ((m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line))) {
      push({ file: m[1]!.trim(), line: +m[2]!, column: +m[3]!, severity: severity(m[4]), code: m[5], message: m[6]! }, i);
      continue;
    }
    // tsc --pretty: src/a.ts:12:5 - error TS2322: Type ...
    if ((m = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/.exec(line))) {
      push({ file: m[1]!.trim(), line: +m[2]!, column: +m[3]!, severity: severity(m[4]), code: m[5], message: m[6]! }, i);
      continue;
    }
    // eslint stylish: a file path line, then "  12:5  error  Message  rule-id"
    if ((m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(line)) && eslintFile) {
      push({ file: eslintFile, line: +m[1]!, column: +m[2]!, severity: severity(m[3]), ...(m[5] ? { code: m[5] } : {}), message: m[4]! }, i);
      continue;
    }
    // gcc / eslint unix / ruff: file:12:5: error: message  |  file:12:5: E501 message
    if ((m = /^((?:[A-Za-z]:)?[^\s:][^:]*?):(\d+):(\d+):\s*(?:(error|warning|note)\b:?\s*)?(?:\[?([A-Z]+\d+)\]?\s+)?(.*)$/.exec(line))) {
      if (m[4] === 'note') continue;
      push({ file: m[1]!, line: +m[2]!, column: +m[3]!, severity: severity(m[4]), ...(m[5] ? { code: m[5] } : {}), message: m[6]! }, i);
      continue;
    }
    // rustc / clippy: "error[E0308]: mismatched types" then " --> src/main.rs:4:5"
    if ((m = /^(error|warning)(?:\[([A-Za-z0-9_:]+)\])?: (.*)$/.exec(line))) {
      if (/^(warning|error): (aborting|could not compile|build failed|\d+ warnings? emitted)/.test(line)) continue;
      const where = /^\s*--> (.+?):(\d+):(\d+)/.exec(lines[i + 1] ?? '');
      push({
        ...(where ? { file: where[1]!, line: +where[2]!, column: +where[3]! } : {}),
        severity: severity(m[1]),
        ...(m[2] ? { code: m[2] } : {}),
        message: m[3]!,
      }, i);
      continue;
    }
    // go vet / go build: ./a.go:12:5: message
    if ((m = /^(\.?\/?[^\s:]+\.go):(\d+):(\d+): (.*)$/.exec(line))) {
      push({ file: m[1]!, line: +m[2]!, column: +m[3]!, severity: 'error', message: m[4]! }, i);
      continue;
    }
    // An eslint stylish file header: a bare path on its own line.
    if (/^(?:[A-Za-z]:)?[\\/]?[^\s:]+\.[A-Za-z0-9]+$/.test(line.trim()) && !/^\s/.test(line)) {
      eslintFile = line.trim();
    }
  }
  return { diagnostics };
}
