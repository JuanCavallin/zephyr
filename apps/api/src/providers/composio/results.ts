import type { DataLabel, Json, ToolboxToolDefinition } from '@htn/shared';

/** Leave headroom for the MCP envelope; this is bytes, not UTF-16 characters. */
export const COMPOSIO_MODEL_RESULT_BYTES = 4_800;
const FIELD_LIMIT = 24;
const ARRAY_LIMIT = 10;
const TEXT_LIMIT = 1_600;
const SECRET_FIELD =
  /(?:api.?key|password|secret|token|authorization|cookie|credential|contentbytes|attachmentdata)/i;
const FIELDS = new Set(
  (
    'id message_id messageId thread_id threadId document_id documentId spreadsheet_id spreadsheetId file_id fileId ' +
    'name title subject description summary snippet body text content plain_text plainText bodyContent ' +
    'status type version etag eTag cTag modifiedTime lastModifiedDateTime createdTime ' +
    'webUrl url htmlLink sender from to email emailAddress displayName address ' +
    'messagesTotal threadsTotal historyId resultSizeEstimate count total totalCount total_count nextPageToken next_page_token nextLink next_cursor has_more ' +
    'range values cells rows columns formulas results items data labels messages threads files documents events contacts records sheets worksheets tables document file message thread profile ' +
    'mimeType mime_type contentType content_type start end dateTime timeZone location attendees organizer responseStatus '
  )
    .split(/\s+/)
    .filter(Boolean),
);
const COLLECTIONS = new Set([
  'results',
  'items',
  'labels',
  'messages',
  'threads',
  'files',
  'documents',
  'events',
  'contacts',
  'records',
  'sheets',
  'worksheets',
  'rows',
  'values',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ComposioResult {
  receipt: Json;
  modelOutput: Json;
  dataLabels: DataLabel[];
}

/**
 * Explicit result boundary, not provider-output passthrough. Source text is
 * untrusted data for the local harness and never a permission or instruction.
 * The broker stores the metadata receipt/summary, not this ephemeral modelOutput.
 */
export function normalizeComposioResult(
  tool: ToolboxToolDefinition,
  raw: unknown,
  labels: DataLabel[],
  mode: 'live' | 'mock',
  secrets: string[] = [],
): ComposioResult {
  const state = { truncated: false, visited: 0 };
  const scrub = (value: string) =>
    secrets
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, '[credential redacted]'), value);
  function bounded(value: unknown, depth: number, key = ''): Json | undefined {
    if (++state.visited > 240 || depth > 5) {
      state.truncated = true;
      return undefined;
    }
    if (SECRET_FIELD.test(key) && !['nextPageToken', 'next_page_token'].includes(key))
      return '[credential redacted]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      const text = scrub(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
      if (text.length > TEXT_LIMIT) state.truncated = true;
      return text.slice(0, TEXT_LIMIT);
    }
    if (Array.isArray(value)) {
      if (value.length > ARRAY_LIMIT) state.truncated = true;
      return value.slice(0, ARRAY_LIMIT).map((child) => bounded(child, depth + 1) ?? null);
    }
    if (!record(value)) return undefined;
    const result: Record<string, Json> = {};
    let count = 0;
    for (const name of Object.keys(value).slice(0, 64)) {
      if (SECRET_FIELD.test(name) && !['nextPageToken', 'next_page_token'].includes(name)) {
        state.truncated = true;
        continue;
      }
      if (!FIELDS.has(name)) {
        state.truncated = true;
        continue;
      }
      if (++count > FIELD_LIMIT) {
        state.truncated = true;
        break;
      }
      const child = bounded(value[name], depth + 1, name);
      if (child !== undefined) result[name] = child;
    }
    return result;
  }
  const envelope = record(raw) ? raw : {};
  let source = envelope.data ?? raw;
  if (tool.toolkit === 'gmail' && record(source) && record(source.payload)) {
    const decoded = gmailText(source.payload);
    source = { ...source, ...(decoded ? { text: decoded } : {}) };
  }
  const data = bounded(source, 0) ?? null;
  let itemCount: number | undefined;
  if (Array.isArray(source)) itemCount = source.length;
  else if (record(source))
    for (const [key, value] of Object.entries(source)) {
      if (COLLECTIONS.has(key) && Array.isArray(value)) {
        itemCount = value.length;
        break;
      }
    }
  const receipt: Record<string, Json> = { tool: tool.name, providerReported: true };
  for (const key of ['log_id', 'execution_log_id']) {
    const value = envelope[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,299}$/.test(value))
      receipt[key] = scrub(value);
  }
  if (record(source))
    for (const key of [
      'id',
      'message_id',
      'document_id',
      'spreadsheet_id',
      'file_id',
      'version',
      'etag',
      'status',
    ]) {
      const value = source[key];
      if (typeof value === 'string' && /^[A-Za-z0-9_.:@/"+~-]{1,299}$/.test(value))
        receipt[key] = scrub(value);
    }
  if (itemCount !== undefined) receipt.itemCount = itemCount;
  const model: Record<string, Json> = {
    provenance: {
      provider: 'composio',
      tool: tool.name,
      version: tool.version ?? '',
      mode,
      trust: 'untrusted-provider-data',
      evidenceLevel: 'provider_reported',
    },
    data,
    ...(itemCount === undefined ? {} : { itemCount }),
    truncated: state.truncated,
    ...(isOfficeToolkit(tool)
      ? {
          capabilities: {
            conditionalWriteField: conditionalWriteField(tool),
            independentReadback: false,
            evidence: 'provider_reported; separately authorized readback required',
          },
        }
      : {}),
  };
  // Preserve whole JSON values while shrinking. Never truncate serialized JSON.
  while (Buffer.byteLength(JSON.stringify(model)) > COMPOSIO_MODEL_RESULT_BYTES) {
    model.truncated = true;
    if (!shrink(model.data)) {
      model.data = { omitted: 'Result exceeds the bounded model budget.' };
      break;
    }
  }
  return {
    receipt,
    modelOutput: model,
    // App results can reveal account contents/IDs even when the proposed
    // arguments were public. This label must be canonical before MCP responds.
    dataLabels: [...new Set<DataLabel>([...labels, 'private'])],
  };
}

function shrink(value: Json): boolean {
  if (Array.isArray(value)) {
    if (value.length > 1) {
      value.pop();
      return true;
    }
    return value.some(shrink);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).reverse()) {
      const child = value[key]!;
      if (typeof child === 'string' && child.length > 160) {
        value[key] = child.slice(0, Math.max(160, Math.floor(child.length / 2)));
        return true;
      }
      if (typeof child === 'object' && child !== null && shrink(child)) return true;
    }
    const keys = Object.keys(value);
    if (keys.length > 1) {
      delete value[keys.at(-1)!];
      return true;
    }
  }
  return false;
}

/** Only an explicit If-Match schema is a conditional write contract. */
export function conditionalWriteField(tool: ToolboxToolDefinition): string | null {
  const schema = tool.inputSchema;
  if (!record(schema) || !record(schema.properties)) return null;
  for (const key of ['if_match', 'ifMatch']) {
    const property = schema.properties[key];
    if (record(property) && property.type === 'string') return key;
  }
  return null;
}

export function isOfficeToolkit(tool: ToolboxToolDefinition): boolean {
  return /^(?:microsoft|onedrive|sharepoint|excel(?:$|_)|word(?:$|_)|office(?:$|_))/i.test(
    tool.toolkit ?? '',
  );
}

/** Decode text MIME parts only. Attachments and provider-supplied HTML never execute. */
function gmailText(payload: Record<string, unknown>, depth = 0): string {
  if (depth > 4) return '';
  const mime = typeof payload.mimeType === 'string' ? payload.mimeType : '';
  if (mime === 'text/plain' && record(payload.body) && typeof payload.body.data === 'string') {
    const encoded = payload.body.data.slice(0, 12_000);
    if (!/^[A-Za-z0-9_=-]*$/.test(encoded)) return '';
    return Buffer.from(encoded, 'base64url').toString('utf8').slice(0, TEXT_LIMIT);
  }
  return Array.isArray(payload.parts)
    ? payload.parts
        .slice(0, 6)
        .filter(record)
        .map((part) => gmailText(part, depth + 1))
        .filter(Boolean)
        .join('\n')
        .slice(0, TEXT_LIMIT)
    : '';
}
