import type { DataLabel } from './control.js';
import type { Json } from './domain.js';

export type ActionEvidenceKind =
  'document' | 'spreadsheet' | 'presentation' | 'message' | 'generic';
/** Metadata only. Preview contents are authenticated, transient human-view data. */
export interface ActionEvidence {
  actionId: string;
  runId: string;
  resourceRef: string;
  kind: ActionEvidenceKind;
  phase: 'proposed' | 'executed';
  evidenceLevel: 'arguments_only' | 'provider_reported' | 'readback_verified';
  previewRef?: string;
  baseVersion?: string;
  resultingVersion?: string;
  fingerprint: string;
  summary: string;
  dataLabels: DataLabel[];
  executionMode?: 'live' | 'mock';
}

export interface ActionPreview {
  kind: ActionEvidenceKind;
  title: string;
  arguments: Json;
  changes?: { location: string; before?: Json; after: Json }[];
  message?: { to?: string; subject?: string; body?: string };
  truncated: boolean;
  baseVersion?: string;
}
