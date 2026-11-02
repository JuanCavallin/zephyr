/**
 * Evidence bundle assembly (step 6): what a run did, from the trace and the ledgers,
 * never from the agent's say-so.
 *
 * Pure: `buildEvidence` folds the run's stored events, its egress ledger and its
 * worktree diff into an `EvidenceBundle` and validates it against the shared schema.
 * The service (`services/evidence.service.ts`) gathers those sources and writes
 * `evidence.json`.
 *
 * Sources, field by field:
 *   diff                    the worktree patch (stat parsed here, hash from the workspace)
 *   checkpoints             `workspace.checkpoint` events, one per harness turn
 *   tests.selected/before/after
 *                           `verify.tests` events; the last of each phase wins, and a
 *                           full-suite run stands in for `after` when no selected run did
 *   tests.added/modified    test paths in the diff, by file status
 *   protectedPathApprovals  `tool.lifecycle` `approved` events whose action carries a
 *                           protected-path review (see the permission bridge)
 *   usage                   `gateway.call` events. `tokensIn` is the UNCACHED input;
 *                           cache reads and writes are separate counts, as billed
 *   egress                  the run's egress ledger
 *
 * Optional sections (walkthrough, baseline, `tests.before`) are simply absent when
 * their source is; assembly never fails on a missing optional section.
 */

import { createHash } from 'node:crypto';
import {
  evidenceBundleSchema,
  type EgressEvent,
  type EvidenceBundle,
  type RunEvent,
  type SelectedTest,
} from '@htn/shared';
import { isTestPath } from './protectedPaths.js';
import { summarizePatch } from './testImpact.js';

type Usage = EvidenceBundle['usage'];
type Tally = EvidenceBundle['tests']['after'];

export interface EvidenceSources {
  runId: string;
  taskId?: string;
  /** The run's events in stored order. */
  events: readonly RunEvent[];
  egress: readonly Pick<EgressEvent, 'destination'>[];
  /** The worktree diff against the run's base; null when there is no workspace. */
  diff: { patch: string; hash?: string } | null;
  /** Run start and end (wall time). */
  startedAt: string;
  endedAt: string;
  walkthrough?: EvidenceBundle['walkthrough'];
  /** Usage of the comparison run (cold run, or the task's baseline), when known. */
  baseline?: Usage;
  /** Stamped on the bundle. Defaults to `endedAt`. */
  createdAt?: string;
}

const HEX_HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ZERO_TALLY: Tally = { passed: 0, failed: 0, skipped: 0 };

export function buildEvidence(src: EvidenceSources): EvidenceBundle {
  const patch = src.diff?.patch ?? '';
  const summary = summarizePatch(patch);
  const hash = src.diff?.hash && HEX_HASH.test(src.diff.hash) ? src.diff.hash : summary.hash;

  const checkpoints: EvidenceBundle['checkpoints'] = [];
  const lastTests: Partial<Record<'before' | 'after' | 'full', { selected: SelectedTest[]; tally: Tally }>> = {};
  const approvals = new Map<string, string>();
  const usage: Usage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCents: 0, wallMs: 0 };

  for (const event of src.events) {
    switch (event.type) {
      case 'workspace.checkpoint':
        if (event.runId === src.runId) checkpoints.push({ turnId: event.turnId, ref: event.ref, at: event.at });
        break;
      case 'verify.tests':
        if (event.runId === src.runId) lastTests[event.phase] = { selected: event.selected, tally: event.tally };
        break;
      case 'gateway.call':
        if (event.runId !== src.runId) break;
        usage.tokensIn += event.usage.inputTokens;
        usage.tokensOut += event.usage.outputTokens;
        usage.cacheReadTokens += event.usage.cacheReadInputTokens;
        usage.cacheWriteTokens += event.usage.cacheCreationInputTokens;
        usage.costCents += event.costCents ?? 0;
        break;
      case 'tool.lifecycle': {
        const { lifecycle } = event;
        if (lifecycle.phase !== 'approved' || !lifecycle.approvalId) break;
        const review = lifecycle.action.review;
        const path =
          review && typeof review === 'object' && !Array.isArray(review) ? review['protectedPath'] : undefined;
        if (typeof path === 'string' && path) approvals.set(lifecycle.approvalId, path);
        break;
      }
      default:
        break;
    }
  }
  usage.costCents = Math.round(usage.costCents * 10_000) / 10_000;
  usage.wallMs = Math.max(0, Date.parse(src.endedAt) - Date.parse(src.startedAt) || 0);

  const after = lastTests.after ?? lastTests.full;
  const before = lastTests.before;
  const testFiles = summary.files.filter((f) => isTestPath(f.path));

  return evidenceBundleSchema.parse({
    id: 'evb_' + createHash('sha256').update(src.runId + '\0' + hash).digest('hex').slice(0, 16),
    runId: src.runId,
    ...(src.taskId ? { taskId: src.taskId } : {}),
    diff: { files: summary.files.length, insertions: summary.insertions, deletions: summary.deletions, hash },
    checkpoints,
    tests: {
      selected: (lastTests.after ?? before ?? lastTests.full)?.selected ?? [],
      ...(before ? { before: before.tally } : {}),
      after: after?.tally ?? ZERO_TALLY,
      added: testFiles.filter((f) => f.status === 'added').map((f) => f.path),
      modified: testFiles.filter((f) => f.status === 'modified' || f.status === 'renamed').map((f) => f.path),
    },
    protectedPathApprovals: [...approvals].map(([approvalId, path]) => ({ path, approvalId })),
    ...(src.walkthrough ? { walkthrough: src.walkthrough } : {}),
    usage,
    ...(src.baseline ? { baseline: src.baseline } : {}),
    egress: {
      calls: src.egress.length,
      destinations: [...new Set(src.egress.map((e) => e.destination).filter(Boolean))].sort(),
    },
    createdAt: src.createdAt ?? src.endedAt,
  });
}
