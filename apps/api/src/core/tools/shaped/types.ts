/**
 * Shared shapes for the shaped tools (step 5, lever L1).
 *
 * A shaped tool runs a test/build/lint command itself and hands the model a
 * digest instead of the raw log: counts, every failing id, a short assertion and
 * trace per failure, and a handle that `zephyr_test_output` expands on demand.
 */

/** Rough token count: ~4 characters per token. Good enough for budgets and traces. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One failure as parsed, untrimmed. `trace` may be long; the digest shortens it. */
export interface ParsedFailure {
  id: string;
  assertion: string;
  trace: string;
  /** Everything the report said about this failure; served by `zephyr_test_output`. */
  detail?: string;
}

export interface ParsedTests {
  format: 'junit' | 'tap' | 'raw';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: ParsedFailure[];
}

/** The contract from docs/cacp-05-token-levers.md. */
export interface Digest {
  total: number;
  passed: number;
  failed: number;
  failures: { id: string; assertion: string; trace: string }[];
  handle: string;
  rawTokens: number;
  digestTokens: number;
}

export interface Diagnostic {
  id: string;
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  code?: string;
  message: string;
}

/** Build and lint digests: diagnostics instead of test cases. */
export interface DiagnosticsDigest {
  ok: boolean;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
  /** Diagnostics left out of `diagnostics` to stay under the token cap. */
  omitted: number;
  handle: string;
  rawTokens: number;
  digestTokens: number;
}

/** How the command itself ended, independent of what the parser made of its output. */
export interface RunFacts {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}
