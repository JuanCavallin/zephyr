/**
 * `zephyr summary <runId | path/to/evidence.json>`: the per-task summary, written from the
 * evidence bundle only. Reads the file the server wrote; no server needed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evidenceBundleSchema, summarizeEvidence, type EvidenceSummary } from '@htn/shared';

export function evidencePath(arg: string, repoRoot: string): string {
  if (arg.toLowerCase().endsWith('.json')) return resolve(arg);
  if (!/^[A-Za-z0-9_-]+$/.test(arg)) throw new Error(`"${arg}" is neither a run id nor a .json path.`);
  return join(repoRoot, '.data', 'evidence', arg, 'evidence.json');
}

export function summaryFromFile(path: string): EvidenceSummary {
  if (!existsSync(path)) throw new Error(`No evidence bundle at ${path}. A run writes one when its task reaches review.`);
  const parsed = evidenceBundleSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path} is not an evidence bundle: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return summarizeEvidence(parsed.data);
}

export function formatSummary(s: EvidenceSummary): string {
  return [s.headline, ...s.lines.map((l) => '  ' + l)].join('\n');
}
