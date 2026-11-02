/**
 * JUnit XML (pytest --junitxml, vitest/jest junit reporters, surefire, go-junit-report).
 *
 * A small scanner rather than a DOM: reports are machine-written, the only
 * elements that matter are <testcase> and its <failure>/<error>/<skipped>
 * children, and a runner that died mid-write leaves a truncated file a strict
 * parser would reject outright. Here a truncated tail only loses the cases it
 * never finished.
 */

import type { ParsedFailure, ParsedTests } from '../types.js';
import { attributes, decodeXml } from './xml.js';

export function looksLikeJunit(text: string): boolean {
  return /<testsuites?[\s>]/.test(text) || /<testcase[\s>]/.test(text);
}

export function parseJunit(xml: string): ParsedTests {
  const failures: ParsedFailure[] = [];
  let total = 0;
  let skipped = 0;
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = caseRe.exec(xml); m; m = caseRe.exec(xml)) {
    total++;
    const attrs = attributes(m[1]!);
    const body = m[3] ?? '';
    const name = attrs.name ?? '(unnamed)';
    const owner = attrs.classname || attrs.file || '';
    const id = owner ? owner + ' > ' + name : name;
    const bad = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (bad) {
      const failAttrs = attributes(bad[2]!);
      const text = decodeXml(bad[4] ?? '').trim();
      const message =
        failAttrs.message?.trim() || text.split('\n').find((l) => l.trim())?.trim() || bad[1]!;
      failures.push({ id, assertion: message, trace: text || message });
      continue;
    }
    if (/<skipped\b/.test(body)) skipped++;
  }
  const failed = failures.length;
  return { format: 'junit', total, passed: total - failed - skipped, failed, skipped, failures };
}
