import { createHash } from 'node:crypto';
import type {
  ActionEvidence,
  ActionEvidenceKind,
  ActionPreview,
  Json,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';
import { newId } from '../lib/ids.js';

const MAX_BYTES = 64_000;
const MAX_ACTIONS = 500;
const SECRET_KEY = /(^|_)(api_?key|password|secret|token|authorization|cookie|credential)(_|$)/i;
function secretKey(key: string): boolean {
  return (
    SECRET_KEY.test(key) ||
    /^(apikey|accesstoken|refreshtoken|clientsecret|authtoken|sessioncookie)$/i.test(
      key.replace(/[-_]/g, ''),
    )
  );
}

export function redactPreview(value: Json, depth = 0): Json {
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactPreview(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([key, child]) => [
          key,
          secretKey(key) ? '[redacted]' : redactPreview(child, depth + 1),
        ]),
    );
  return typeof value === 'string' ? value.slice(0, 24_000) : value;
}

export function actionFingerprint(action: ToolAction): string {
  return createHash('sha256')
    .update(
      stableJson({
        runId: action.runId,
        stepId: action.stepId,
        toolId: action.toolId,
        descriptorVersion: action.descriptorVersion,
        destination: action.destination ?? null,
        accountRef: action.accountRef ?? null,
        review: action.review ?? null,
        arguments: action.arguments,
        dataLabels: action.dataLabels,
      }),
    )
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

function object(value: Json): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function omittedContent(value: Json, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') return value.length > 24000;
  if (Array.isArray(value))
    return value.length > 200 || value.some((child) => omittedContent(child, depth + 1));
  if (value && typeof value === 'object')
    return (
      Object.keys(value).length > 200 ||
      Object.entries(value).some(
        ([key, child]) => !secretKey(key) && omittedContent(child, depth + 1),
      )
    );
  return false;
}

/** Pure argument preview: no network, provider inference, or invented before-state. */
export function buildActionPreview(action: ToolAction, descriptor: ToolDescriptor): ActionPreview {
  const args = object(redactPreview(action.arguments));
  const family = descriptor.family.toLowerCase();
  const kind: ActionEvidenceKind = /mail|message|outlook/.test(family)
    ? 'message'
    : /excel|spreadsheet|sheets/.test(family)
      ? 'spreadsheet'
      : /word|document|docs/.test(family)
        ? 'document'
        : /powerpoint|presentation|slides/.test(family)
          ? 'presentation'
          : 'generic';
  const preview: ActionPreview = {
    kind,
    title: descriptor.id,
    arguments: args,
    truncated:
      omittedContent(action.arguments) || Buffer.byteLength(JSON.stringify(args)) > MAX_BYTES,
    baseVersion: text(args.expectedVersion ?? args.baseVersion ?? args.etag ?? args.version),
  };
  if (kind === 'message')
    preview.message = {
      to: text(args.to ?? args.recipient_email),
      subject: text(args.subject),
      body: text(args.body ?? args.content),
    };
  if (kind === 'spreadsheet' && Array.isArray(args.values)) {
    preview.changes = args.values.slice(0, 100).flatMap((row, i) =>
      (Array.isArray(row) ? row : [row]).slice(0, 50).map((after, j) => ({
        location:
          String(args.range ?? args.sheet ?? 'Cells') + ' · row ' + (i + 1) + ', column ' + (j + 1),
        after,
      })),
    );
  } else if (kind === 'document' && typeof (args.content ?? args.text) === 'string') {
    preview.changes = [
      {
        location: String(args.document_id ?? args.file_id ?? 'Document'),
        after: args.content ?? args.text,
      },
    ];
  }
  // Approved raw arguments may be much larger than a view. Never persist or stream them.
  if (JSON.stringify(preview).length > MAX_BYTES) {
    preview.arguments = { preview: 'Payload exceeds preview limit; bounded changes shown.' };
    preview.changes = preview.changes?.slice(0, 50);
    preview.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(preview)) > MAX_BYTES && preview.changes?.length)
    preview.changes.pop();
  if (Buffer.byteLength(JSON.stringify(preview)) > MAX_BYTES) {
    preview.message = undefined;
    preview.arguments = { preview: 'Payload exceeds the bounded preview budget.' };
    preview.truncated = true;
  }
  return preview;
}

export class ActionEvidenceStore {
  private readonly records = new Map<string, ActionEvidence[]>();
  private readonly previews = new Map<string, { runId: string; value: ActionPreview }>();
  private readonly exactActions = new Map<string, ToolAction>();

  proposed(action: ToolAction, descriptor: ToolDescriptor): ActionEvidence {
    const preview = buildActionPreview(action, descriptor);
    const previewRef = newId('preview');
    this.previews.set(previewRef, { runId: action.runId, value: preview });
    const key = action.runId + ':' + action.id;
    const prior = this.records.get(key);
    const evidence: ActionEvidence = {
      actionId: action.id,
      runId: action.runId,
      resourceRef: prior?.at(-1)?.resourceRef ?? newId('resource'),
      kind: preview.kind,
      phase: 'proposed',
      evidenceLevel: 'arguments_only',
      previewRef,
      fingerprint: actionFingerprint(action),
      summary: 'Proposed ' + descriptor.id + '; no changes executed.',
      dataLabels: [...action.dataLabels],
      executionMode: descriptor.executionMode,
      ...(preview.baseVersion ? { baseVersion: preview.baseVersion } : {}),
    };
    // Keep proposal history until eviction so replayed approval references remain valid.
    const history = [...(prior ?? []), evidence];
    while (history.length > 8) {
      const removed = history.shift();
      if (removed?.previewRef) this.previews.delete(removed.previewRef);
    }
    this.records.set(key, history);
    this.exactActions.set(key, structuredClone(action));
    this.trim();
    return structuredClone(evidence);
  }

  completed(
    action: ToolAction,
    result: {
      output?: Json;
      verified?: boolean;
      evidenceVerified?: boolean;
      executionMode?: 'live' | 'mock';
      summary: string;
      executedPreview?: ActionPreview;
    },
  ): ActionEvidence {
    const key = action.runId + ':' + action.id;
    const history = this.records.get(key) ?? [];
    const prior = history.findLast((e) => e.phase === 'proposed');
    const resultingVersion = text(
      object(result.output ?? null).version ?? object(result.output ?? null).etag,
    );
    const evidence: ActionEvidence = {
      actionId: action.id,
      runId: action.runId,
      resourceRef: prior?.resourceRef ?? newId('resource'),
      kind: prior?.kind ?? 'generic',
      phase: 'executed',
      evidenceLevel: result.evidenceVerified ? 'readback_verified' : 'provider_reported',
      fingerprint: prior?.fingerprint ?? actionFingerprint(action),
      summary: result.summary.slice(0, 800),
      dataLabels: [...action.dataLabels],
      executionMode: result.executionMode,
      ...(prior?.baseVersion ? { baseVersion: prior.baseVersion } : {}),
      ...(resultingVersion ? { resultingVersion } : {}),
    };
    if (
      result.executedPreview &&
      Buffer.byteLength(JSON.stringify(result.executedPreview)) <= MAX_BYTES
    ) {
      const ref = newId('preview');
      this.previews.set(ref, {
        runId: action.runId,
        value: structuredClone(result.executedPreview),
      });
      evidence.previewRef = ref;
    }
    this.records.set(key, [...history, evidence]);
    this.exactActions.delete(key);
    this.trim();
    return structuredClone(evidence);
  }

  list(runId: string, actionId: string): ActionEvidence[] {
    return structuredClone(this.records.get(runId + ':' + actionId) ?? []);
  }
  preview(runId: string, ref: string): ActionPreview | null {
    const p = this.previews.get(ref);
    return p?.runId === runId ? structuredClone(p.value) : null;
  }
  /** Internal validation only: never returned by a route or streamed to a model. */
  exactAction(runId: string, actionId: string): ToolAction | null {
    return structuredClone(this.exactActions.get(runId + ':' + actionId) ?? null);
  }
  retireExactAction(runId: string, actionId: string): void {
    this.exactActions.delete(runId + ':' + actionId);
  }
  clearRun(runId: string): void {
    for (const [key, records] of this.records)
      if (records[0]?.runId === runId) {
        for (const e of records) if (e.previewRef) this.previews.delete(e.previewRef);
        this.records.delete(key);
        this.exactActions.delete(key);
      }
  }
  private trim(): void {
    while (this.records.size > MAX_ACTIONS) {
      const key = this.records.keys().next().value as string;
      for (const e of this.records.get(key) ?? [])
        if (e.previewRef) this.previews.delete(e.previewRef);
      this.records.delete(key);
      this.exactActions.delete(key);
    }
  }
}

export const actionEvidenceStore = new ActionEvidenceStore();

/** Document bodies stay in the transient preview store, never lifecycle/approval persistence. */
export function actionForTrace(action: ToolAction): ToolAction {
  const evidence = actionEvidenceStore
    .list(action.runId, action.id)
    .findLast((e) => e.phase === 'proposed');
  if (!evidence || !['document', 'spreadsheet', 'presentation'].includes(evidence.kind))
    return { ...action, arguments: redactPreview(action.arguments) };
  const args = object(action.arguments);
  const metadata: Record<string, Json> = {
    previewRef: evidence.previewRef ?? null,
    fingerprint: evidence.fingerprint,
  };
  for (const key of [
    'artifactId',
    'document_id',
    'spreadsheet_id',
    'file_id',
    'range',
    'sheet',
    'expectedVersion',
    'baseVersion',
    'etag',
  ])
    if (typeof args[key] === 'string') metadata[key] = args[key];
  return { ...action, arguments: metadata };
}
