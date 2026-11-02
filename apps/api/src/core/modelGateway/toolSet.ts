/**
 * Step 5, lever L3, observed from the wire: is the tool set byte-stable across a run?
 *
 * The `tools` array sits in front of the system prompt and the messages in
 * Anthropic's cache prefix, so ANY change to it, even reordering or reformatting,
 * turns every later turn into a cache miss. L3 fixes the tool set at session
 * start; this tracker is how that promise is checked. It hashes the exact bytes of
 * the `tools` value the gateway forwards (the gateway never edits that value) and
 * compares each request with the first one of the same run and model.
 *
 * Per model, because Claude Code's side calls (titles, summaries on a small model)
 * legitimately carry a different tool set or none. Requests without `tools` are
 * not tracked at all.
 */

import { createHash } from 'node:crypto';
import { entry, scanJson } from './rawJson.js';

export interface ToolSetObservation {
  /** sha256 of the forwarded `tools` bytes, first 16 hex characters. */
  hash: string;
  /** Tool names in request order. */
  names: string[];
  /** This request's tool set differs from the first one seen for this run and model. */
  changed: boolean;
}

export interface RunToolSet {
  runId: string;
  model: string;
  /** The first tool set seen; later requests are compared against it. */
  hash: string;
  names: string[];
  requests: number;
  /** Requests whose tool set differed from the first. 0 is the L3 promise. */
  changes: number;
}

/** The raw text of the request's `tools` value, or undefined when there is none. */
export function toolsText(body: string): string | undefined {
  let root;
  try {
    root = scanJson(body);
  } catch {
    return undefined;
  }
  const tools = entry(root, 'tools')?.value;
  if (tools?.kind !== 'array' || tools.items.length === 0) return undefined;
  return body.slice(tools.start, tools.end);
}

export function hashTools(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

export class ToolSetTracker {
  private readonly runs = new Map<string, RunToolSet>();

  /**
   * Record one request body (already known to be valid JSON). Undefined when the
   * request carries no tools.
   */
  observe(runId: string, model: string | undefined, body: string): ToolSetObservation | undefined {
    const raw = toolsText(body);
    if (raw === undefined) return undefined;
    const hash = hashTools(raw);
    const names = toolNames(raw);
    const key = runId + '\0' + (model ?? '');
    const run = this.runs.get(key);
    if (!run) {
      this.runs.set(key, { runId, model: model ?? '', hash, names, requests: 1, changes: 0 });
      return { hash, names, changed: false };
    }
    run.requests += 1;
    const changed = hash !== run.hash;
    if (changed) run.changes += 1;
    return { hash, names, changed };
  }

  /** Every model's tool set for one run. */
  run(runId: string): RunToolSet[] {
    return [...this.runs.values()].filter((r) => r.runId === runId).map((r) => ({ ...r, names: [...r.names] }));
  }

  forget(runId: string): void {
    for (const [key, r] of this.runs) if (r.runId === runId) this.runs.delete(key);
  }
}

function toolNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => (t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : '?'));
  } catch {
    return [];
  }
}
