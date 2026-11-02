/**
 * Hot-file intents (spec §10).
 *
 * A hot file (`package.json`, lockfiles, route registries, barrel `index.ts`, shared
 * schemas) is never leased, because every task may need it. Instead an agent states
 * what it needs ("add dependency zod@4") as a `HotFileIntent`; the integrator applies
 * intents one at a time, per file, in submission order.
 *
 * This module is the typed edit for each intent kind: pure `(current, intent) -> next`.
 * Each applier is idempotent, so a retried intent never duplicates a line.
 */

import { z } from 'zod';
import type { HotFileIntent } from '@htn/shared';

export class IntentRejectedError extends Error {
  readonly code = 'INTENT_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'IntentRejectedError';
  }
}

const packageName = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/, 'not an npm package name');

export const addDependencyPayloadSchema = z.object({
  name: packageName,
  /** A semver range or a workspace/protocol spec; no shell metacharacters. */
  version: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w.^~<>=*|@:/+ -]+$/, 'not a version spec'),
  dev: z.boolean().optional(),
});

export const exportSymbolPayloadSchema = z.object({
  /** Relative module specifier, e.g. `./board.js`. */
  from: z.string().regex(/^\.{1,2}\/[\w./-]+$/, 'not a relative module specifier'),
  /** Named exports; omitted = `export *`. */
  symbols: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).min(1).optional(),
});

/** Detect a JSON file's indent so an edit does not reformat it. */
function indentOf(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m ? m[0] : 2;
}

export function applyAddDependency(current: string, payload: unknown): string {
  const p = addDependencyPayloadSchema.safeParse(payload);
  if (!p.success) throw new IntentRejectedError('add_dependency payload: ' + p.error.issues[0]?.message);
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(current) as Record<string, unknown>;
  } catch {
    throw new IntentRejectedError('package.json is not valid JSON');
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
    throw new IntentRejectedError('package.json is not an object');
  const field = p.data.dev ? 'devDependencies' : 'dependencies';
  const other = p.data.dev ? 'dependencies' : 'devDependencies';
  const otherDeps = pkg[other] as Record<string, string> | undefined;
  if (otherDeps && p.data.name in otherDeps)
    throw new IntentRejectedError(p.data.name + ' is already in ' + other + ' at ' + otherDeps[p.data.name]);
  const deps = { ...((pkg[field] as Record<string, string> | undefined) ?? {}) };
  const existing = deps[p.data.name];
  if (existing !== undefined && existing !== p.data.version)
    throw new IntentRejectedError(p.data.name + ' is already at ' + existing + '; a version change needs a person');
  deps[p.data.name] = p.data.version;
  const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const next = { ...pkg, [field]: sorted };
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(next, null, indentOf(current)).replace(/\n/g, eol) + eol;
}

export function applyExportSymbol(current: string, payload: unknown): string {
  const p = exportSymbolPayloadSchema.safeParse(payload);
  if (!p.success) throw new IntentRejectedError('export_symbol payload: ' + p.error.issues[0]?.message);
  const line = p.data.symbols
    ? 'export { ' + p.data.symbols.join(', ') + " } from '" + p.data.from + "';"
    : "export * from '" + p.data.from + "';";
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return current;
  const body = current === '' || current.endsWith('\n') ? current : current + eol;
  return body + line + eol;
}

/** Kinds with an automatic applier. Others are rejected with a reason for a person. */
export const APPLIERS: Partial<Record<HotFileIntent['kind'], (current: string, payload: unknown) => string>> = {
  add_dependency: applyAddDependency,
  export_symbol: applyExportSymbol,
};

export function applyIntent(current: string | null, intent: HotFileIntent): string {
  const applier = APPLIERS[intent.kind];
  if (!applier) throw new IntentRejectedError('no automatic applier for ' + intent.kind + '; needs a person');
  if (current === null && intent.kind === 'add_dependency')
    throw new IntentRejectedError(intent.path + ' does not exist');
  return applier(current ?? '', intent.payload);
}
