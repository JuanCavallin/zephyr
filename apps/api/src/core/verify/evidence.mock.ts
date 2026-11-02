/**
 * Mock EvidenceBundle factory. Pure: the same input always yields the same bundle (ids,
 * hash and timestamps are derived from the input, not from a clock or RNG).
 */

import { createHash } from 'node:crypto';
import { evidenceBundleSchema, type EvidenceBundle } from '@htn/shared';

export interface MockEvidenceInput {
  runId: string;
  taskId?: string;
  /** Repo-relative paths the run changed. */
  files?: string[];
  /** Stand-in diff text; hashed into `diff.hash`. Defaults to the file list. */
  diff?: string;
  testsPassed?: number;
  testsFailed?: number;
  /** ISO time stamped on the bundle. Defaults to a fixed epoch. */
  at?: string;
}

const FIXED_AT = '2026-01-01T00:00:00.000Z';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function mockEvidenceBundle(input: MockEvidenceInput): EvidenceBundle {
  const files = [...(input.files ?? ['src/index.ts'])].sort();
  const diff = input.diff ?? files.map((f) => '+++ b/' + f).join('\n');
  const hash = sha256(diff);
  const at = input.at ?? FIXED_AT;
  const passed = input.testsPassed ?? 3;
  const failed = input.testsFailed ?? 0;
  const insertions = diff.split('\n').filter((l) => l.startsWith('+')).length;
  const deletions = diff.split('\n').filter((l) => l.startsWith('-')).length;
  return evidenceBundleSchema.parse({
    id: 'evb_' + hash.slice(0, 16),
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    diff: { files: files.length, insertions, deletions, hash },
    checkpoints: [{ turnId: 'turn_1', ref: 'refs/zephyr/checkpoints/' + input.runId + '/1', at }],
    tests: {
      selected: [{ id: 'test_' + hash.slice(0, 8), fallback: true }],
      after: { passed, failed, skipped: 0 },
      added: [],
      modified: files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)),
    },
    protectedPathApprovals: [],
    usage: { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCents: 0, wallMs: 0 },
    egress: { calls: 0, destinations: [] },
    createdAt: at,
  });
}
