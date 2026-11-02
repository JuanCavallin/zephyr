/**
 * Evidence service (step 6): gathers a run's trace, egress ledger and worktree diff,
 * builds the `EvidenceBundle` (core/verify/evidence.ts), writes `evidence.json` and
 * the rendered markdown summary next to it.
 *
 *   <evidenceDir>/<runId>/evidence.json
 *   <evidenceDir>/<runId>/evidence.md
 *
 * Call it before the workspace is disposed: the diff comes from the live worktree.
 * A run without a diff cannot produce evidence, and assembly says so rather than
 * stamping an empty diff hash on the bundle.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isTerminal, type EvidenceBundle } from '@htn/shared';
import type { Store } from '../store/types.js';
import { buildEvidence, type EvidenceSources } from '../core/verify/evidence.js';
import { renderEvidence, type RenderOptions } from '../core/verify/render.js';
import type { WorkspacesService } from './workspaces.service.js';

export interface AssembleOptions {
  taskId?: string;
  walkthrough?: EvidenceSources['walkthrough'];
  baseline?: EvidenceSources['baseline'];
  /** A diff captured earlier (e.g. before the worktree was disposed). */
  diff?: { patch: string; hash?: string };
  /** Write evidence.json / evidence.md. Default true. */
  write?: boolean;
  render?: RenderOptions;
}

export interface EvidenceResult {
  bundle: EvidenceBundle;
  markdown: string;
  /** Where evidence.json was written, when it was. */
  path?: string;
}

export interface EvidenceService {
  assembleEvidence(runId: string, options?: AssembleOptions): Promise<EvidenceBundle>;
  /** Assemble, render and (by default) write both files. */
  produce(runId: string, options?: AssembleOptions): Promise<EvidenceResult>;
}

export interface EvidenceServiceDeps {
  store: Pick<Store, 'getRun' | 'eventsSince' | 'listEgress'>;
  workspaces: () => Promise<Pick<WorkspacesService, 'diff'>>;
  evidenceDir: string;
  clock?: () => string;
}

export function createEvidenceService(deps: EvidenceServiceDeps): EvidenceService {
  const now = deps.clock ?? (() => new Date().toISOString());

  async function assembleEvidence(runId: string, options: AssembleOptions = {}): Promise<EvidenceBundle> {
    const run = await deps.store.getRun(runId);
    if (!run) throw new Error(`evidence: no run ${runId}`);
    const [stored, egress] = await Promise.all([deps.store.eventsSince(runId, 0), deps.store.listEgress(runId)]);
    let diff = options.diff;
    if (!diff) {
      try {
        diff = await (await deps.workspaces()).diff(runId);
      } catch (error) {
        throw new Error(`evidence: no diff for run ${runId}: ${(error as Error).message}`);
      }
    }
    const endedAt = now();
    return buildEvidence({
      runId,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      events: stored.map((s) => s.event),
      egress,
      diff,
      startedAt: run.createdAt,
      endedAt: isTerminal(run.status) ? run.updatedAt : endedAt,
      createdAt: endedAt,
      ...(options.walkthrough ? { walkthrough: options.walkthrough } : {}),
      ...(options.baseline ? { baseline: options.baseline } : {}),
    });
  }

  return {
    assembleEvidence,
    async produce(runId, options = {}) {
      const bundle = await assembleEvidence(runId, options);
      const markdown = renderEvidence(bundle, options.render);
      if (options.write === false) return { bundle, markdown };
      const dir = join(deps.evidenceDir, safeSegment(runId));
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'evidence.json');
      await writeFile(path, JSON.stringify(bundle, null, 2) + '\n');
      await writeFile(join(dir, 'evidence.md'), markdown);
      return { bundle, markdown, path };
    },
  };
}

function safeSegment(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, '_');
}

let shared: EvidenceService | undefined;

/** The process-wide service over the runtime store and workspaces. */
export async function evidenceService(): Promise<EvidenceService> {
  if (!shared) {
    const [{ store }, { workspaces }, { config }] = await Promise.all([
      import('./runtime.js'),
      import('./workspaces.service.js'),
      import('../config.js'),
    ]);
    const repoRoot = config.providers.git.repoRoot ?? resolve(process.cwd(), '../..');
    shared = createEvidenceService({ store, workspaces, evidenceDir: resolve(repoRoot, '.data/evidence') });
  }
  return shared;
}

/** Spec interface: `assembleEvidence(runId)` on the process-wide service. */
export async function assembleEvidence(runId: string, options?: AssembleOptions): Promise<EvidenceBundle> {
  return (await evidenceService()).assembleEvidence(runId, options);
}
