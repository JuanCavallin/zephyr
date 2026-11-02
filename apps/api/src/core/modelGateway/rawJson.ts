/**
 * Offsets into a JSON document, so the gateway can change one value without
 * re-serializing the rest.
 *
 * Prompt caching keys on the exact prefix of the request. `JSON.stringify(JSON.parse(body))`
 * is "the same JSON" but not the same bytes (escapes, number formatting, whitespace),
 * so any edit the gateway makes is a splice at known offsets and every byte outside
 * the spliced range is the client's own.
 *
 * The scanner trusts `JSON.parse` for validity: call `scanJson` only on text that
 * `JSON.parse` accepted. Offsets are UTF-16 indices into the decoded string.
 */

export type JsonNode =
  | { kind: 'object'; start: number; end: number; entries: JsonEntry[] }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'string'; start: number; end: number }
  | { kind: 'scalar'; start: number; end: number };

export interface JsonEntry {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
}

export interface Splice {
  start: number;
  end: number;
  text: string;
}

const WS = new Set([' ', '\t', '\n', '\r']);

export function scanJson(text: string): JsonNode {
  let i = 0;
  const skip = () => {
    while (i < text.length && WS.has(text[i]!)) i += 1;
  };
  const string = (): { start: number; end: number } => {
    const start = i;
    i += 1; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === '\\') i += 2;
      else if (c === '"') {
        i += 1;
        return { start, end: i };
      } else i += 1;
    }
    throw new Error('unterminated string');
  };
  const value = (): JsonNode => {
    skip();
    const c = text[i];
    if (c === '{') {
      const start = i;
      i += 1;
      const entries: JsonEntry[] = [];
      skip();
      if (text[i] === '}') {
        i += 1;
        return { kind: 'object', start, end: i, entries };
      }
      for (;;) {
        skip();
        const k = string();
        skip();
        i += 1; // colon
        const v = value();
        entries.push({
          key: JSON.parse(text.slice(k.start, k.end)) as string,
          keyStart: k.start,
          keyEnd: k.end,
          value: v,
        });
        skip();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        i += 1; // closing brace
        return { kind: 'object', start, end: i, entries };
      }
    }
    if (c === '[') {
      const start = i;
      i += 1;
      const items: JsonNode[] = [];
      skip();
      if (text[i] === ']') {
        i += 1;
        return { kind: 'array', start, end: i, items };
      }
      for (;;) {
        items.push(value());
        skip();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        i += 1;
        return { kind: 'array', start, end: i, items };
      }
    }
    if (c === '"') return { kind: 'string', ...string() };
    const start = i;
    while (i < text.length && !WS.has(text[i]!) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']')
      i += 1;
    return { kind: 'scalar', start, end: i };
  };
  return value();
}

export function entry(node: JsonNode | undefined, key: string): JsonEntry | undefined {
  return node?.kind === 'object' ? node.entries.find((e) => e.key === key) : undefined;
}

/** Every string VALUE (not object keys), depth-first in document order. */
export function stringValues(node: JsonNode, out: JsonNode[] = []): JsonNode[] {
  if (node.kind === 'string') out.push(node);
  else if (node.kind === 'array') for (const item of node.items) stringValues(item, out);
  else if (node.kind === 'object') for (const e of node.entries) stringValues(e.value, out);
  return out;
}

/** Apply non-overlapping splices. Order of the input does not matter. */
export function applySplices(text: string, splices: Splice[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

/** Insert `member` (already-serialized `"key":value`) as the last member of an object. */
export function appendMember(obj: Extract<JsonNode, { kind: 'object' }>, member: string): Splice {
  const at = obj.end - 1;
  return { start: at, end: at, text: (obj.entries.length > 0 ? ',' : '') + member };
}

/** Insert an already-serialized value as the last item of an array. */
export function appendItem(arr: Extract<JsonNode, { kind: 'array' }>, item: string): Splice {
  const at = arr.end - 1;
  return { start: at, end: at, text: (arr.items.length > 0 ? ',' : '') + item };
}
