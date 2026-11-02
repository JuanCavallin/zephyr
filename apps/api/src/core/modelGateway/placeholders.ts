/**
 * Deterministic, session-stable PII placeholders for gateway traffic.
 *
 * `detectPii` numbers placeholders by position in ONE string. A harness resends
 * the whole conversation every turn, so positional numbering would hand the same
 * secret a different placeholder whenever earlier text changed -- a different
 * prefix every turn, and the prompt cache never hits. Here a value gets its
 * placeholder the first time it is seen in a scope and keeps it for the life of
 * the scope; a new scope (a different run) numbers from 1 again.
 *
 * Detection is still `detectPii` (core/redaction.ts); only the numbering is new.
 */

import { detectPii } from '../redaction.js';
import { applySplices, scanJson, stringValues, type Splice } from './rawJson.js';

interface Scope {
  byValue: Map<string, string>;
  next: number;
}

export class PlaceholderSessions {
  private readonly scopes = new Map<string, Scope>();

  placeholderFor(scopeId: string, value: string): string {
    const scope = this.scopes.get(scopeId) ?? { byValue: new Map(), next: 1 };
    this.scopes.set(scopeId, scope);
    let placeholder = scope.byValue.get(value);
    if (!placeholder) {
      placeholder = '[[PII_' + scope.next.toString() + ']]';
      scope.next += 1;
      scope.byValue.set(value, placeholder);
    }
    return placeholder;
  }

  /** Redact one plain string. */
  redactText(scopeId: string, text: string): { text: string; count: number } {
    const { spans } = detectPii(text);
    if (spans.length === 0) return { text, count: 0 };
    // Number in reading order, then splice from the end so offsets stay valid.
    const placeholders = spans.map((span) => this.placeholderFor(scopeId, span.value));
    let out = text;
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const span = spans[i]!;
      out = out.slice(0, span.start) + placeholders[i]! + out.slice(span.end);
    }
    return { text: out, count: spans.length };
  }

  /**
   * Redact every string value of a JSON document, splicing only the strings that
   * changed. Keys and every other byte are left as the client sent them.
   */
  redactJson(scopeId: string, json: string): { json: string; count: number } {
    const splices: Splice[] = [];
    let count = 0;
    for (const node of stringValues(scanJson(json))) {
      const literal = json.slice(node.start, node.end);
      const value = JSON.parse(literal) as string;
      const redacted = this.redactText(scopeId, value);
      if (redacted.count === 0) continue;
      count += redacted.count;
      splices.push({ start: node.start, end: node.end, text: JSON.stringify(redacted.text) });
    }
    return { json: count === 0 ? json : applySplices(json, splices), count };
  }

  forget(scopeId: string): void {
    this.scopes.delete(scopeId);
  }
}
