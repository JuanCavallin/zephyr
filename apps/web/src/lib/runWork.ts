/**
 * What a coding run did, per turn, for the run page's token and Workspace panels
 * (docs/cacp-09-benchmark-cli-demo.md, "UI and demo"). Pure: it reads the RunView the
 * stream reducer builds and nothing else, so a reload rebuilds the same rows.
 *
 *   turns        model calls through the gateway grouped by harness turn, with usage
 *   levers       shaped results ("test output digested: 14211 → 602 tokens") as the
 *                lever's before → after, attached to the turn they happened in
 *   shell        every shell, commit and publish the harness proposed, with Zephyr's
 *                class for it and what authorization decided
 *   checkpoints  the per-turn worktree snapshots, in order
 */

import type { RunView, ToolLifecycleEvent, ToolLifecyclePhase } from '@htn/shared';

type Work = RunView['codingWork'][number];
type GatewayCall = Extract<Work, { type: 'gateway.call' }>;

export interface TurnUsage {
  turn: number;
  /** Set once the turn's end (or checkpoint) arrived; the last turn may still be open. */
  ended: boolean;
  calls: number;
  /** Input the model read fresh: uncached input plus cache writes. */
  freshInput: number;
  cachedInput: number;
  output: number;
  /** Absent when any call in the turn had no known price. */
  costCents?: number;
  toolUses: number;
  toolSetChanged: boolean;
  levers: LeverResult[];
  blocked: string[];
}

export interface LeverResult {
  /** "test output", "build output", "lint output". */
  what: string;
  rawTokens: number;
  shapedTokens: number;
  at: string;
}

export interface ShellRow {
  actionId: string;
  toolId: string;
  command: string;
  /** inspect | verify | mutate_env | network | unknown; absent when not classified. */
  shellClass?: string;
  phase: ToolLifecyclePhase;
  policy?: string;
  allowed?: boolean;
  reasons: string[];
  at: string;
}

export interface CheckpointRow {
  turn: number;
  turnId: string;
  ref: string;
  at: string;
}

export interface RunWork {
  turns: TurnUsage[];
  totals: { calls: number; freshInput: number; cachedInput: number; output: number; costCents?: number };
  levers: LeverResult[];
  shell: ShellRow[];
  checkpoints: CheckpointRow[];
  /** The run's cache hit rate after its latest call, 0..1. */
  cacheHitRate?: number;
}

const DIGEST = /([A-Za-z ]+?) digested: (\d+) → (\d+) tokens/;

export function parseLever(summary: string | undefined, at: string): LeverResult | null {
  if (!summary) return null;
  const m = DIGEST.exec(summary);
  if (!m) return null;
  return { what: m[1]!.trim(), rawTokens: Number(m[2]), shapedTokens: Number(m[3]), at };
}

/** 14211 -> "14k", 602 -> "602", 1_250_000 -> "1.3M". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function leverLabel(l: LeverResult): string {
  return `${compactTokens(l.rawTokens)} → ${compactTokens(l.shapedTokens)}`;
}

const SHELL_TOOLS = new Set(['shell.exec', 'git.commit', 'git.publish']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function shellRows(lifecycle: ToolLifecycleEvent[]): ShellRow[] {
  const byAction = new Map<string, ShellRow>();
  for (const e of lifecycle) {
    const a = e.action;
    if (!SHELL_TOOLS.has(a.toolId)) continue;
    const args = (a.arguments ?? {}) as Record<string, unknown>;
    const prev = byAction.get(a.id);
    const codes = e.authorization?.reasonCodes ?? prev?.reasons ?? [];
    const fromCode = codes.find((c) => c.startsWith('shell-'))?.slice('shell-'.length);
    const row: ShellRow = {
      actionId: a.id,
      toolId: a.toolId,
      command: str(args.command) ?? a.operation,
      phase: e.phase,
      reasons: codes,
      at: prev?.at ?? e.at,
    };
    const shellClass = str(args.class) ?? fromCode ?? prev?.shellClass;
    if (shellClass) row.shellClass = shellClass;
    const policy = e.authorization?.finalPolicy ?? prev?.policy;
    if (policy) row.policy = policy;
    const allowed = e.authorization?.allowed ?? prev?.allowed;
    if (allowed !== undefined) row.allowed = allowed;
    byAction.set(a.id, row);
  }
  return [...byAction.values()];
}

function newTurn(turn: number): TurnUsage {
  return {
    turn,
    ended: false,
    calls: 0,
    freshInput: 0,
    cachedInput: 0,
    output: 0,
    costCents: 0,
    toolUses: 0,
    toolSetChanged: false,
    levers: [],
    blocked: [],
  };
}

function addCall(t: TurnUsage, c: GatewayCall): void {
  t.calls++;
  t.freshInput += c.usage.inputTokens + c.usage.cacheCreationInputTokens;
  t.cachedInput += c.usage.cacheReadInputTokens;
  t.output += c.usage.outputTokens;
  t.toolUses += c.toolUses;
  if (c.toolSetChanged) t.toolSetChanged = true;
  if (c.costCents === undefined) delete t.costCents;
  else if (t.costCents !== undefined) t.costCents += c.costCents;
}

export function runWork(view: Pick<RunView, 'codingWork' | 'toolLifecycle'>): RunWork {
  const work = view.codingWork ?? [];
  const lifecycle = view.toolLifecycle ?? [];

  // Turn boundaries: a turn closes on harness.turn.ended, or on a checkpoint when the
  // harness reports no turn ends (checkpoints are taken once per turn).
  const hasTurnEnds = work.some((w) => w.type === 'harness.turn.ended');
  const turns: TurnUsage[] = [];
  const boundaries: string[] = [];
  let open = newTurn(1);
  const close = (at: string) => {
    open.ended = true;
    turns.push(open);
    boundaries.push(at);
    open = newTurn(turns.length + 1);
  };
  const checkpoints: CheckpointRow[] = [];
  let cacheHitRate: number | undefined;

  for (const w of work) {
    switch (w.type) {
      case 'gateway.call':
        addCall(open, w);
        cacheHitRate = w.runCacheHitRate;
        break;
      case 'gateway.blocked':
        open.blocked.push(w.reason === 'token_budget' ? 'Token budget reached' : 'Cost budget reached');
        break;
      case 'harness.turn.ended':
        close(w.at);
        break;
      case 'workspace.checkpoint':
        checkpoints.push({ turn: checkpoints.length + 1, turnId: w.turnId, ref: w.ref, at: w.at });
        if (!hasTurnEnds) close(w.at);
        break;
      default:
        break;
    }
  }
  if (open.calls || open.blocked.length || turns.length === 0) turns.push(open);

  // A shaped result belongs to the first turn whose end is at or after it.
  const levers: LeverResult[] = [];
  const seen = new Set<string>();
  for (const e of lifecycle) {
    const lever = parseLever(e.outputSummary, e.at);
    if (!lever) continue;
    const key = e.action.id + '|' + e.phase;
    if (seen.has(key)) continue;
    seen.add(key);
    levers.push(lever);
    const index = boundaries.findIndex((b) => b >= e.at);
    const target = turns[index === -1 ? turns.length - 1 : index]!;
    target.levers.push(lever);
  }

  const totals = turns.reduce<RunWork['totals']>(
    (acc, t) => {
      acc.calls += t.calls;
      acc.freshInput += t.freshInput;
      acc.cachedInput += t.cachedInput;
      acc.output += t.output;
      if (t.costCents === undefined || acc.costCents === undefined) delete acc.costCents;
      else acc.costCents += t.costCents;
      return acc;
    },
    { calls: 0, freshInput: 0, cachedInput: 0, output: 0, costCents: 0 },
  );
  if (totals.calls === 0) delete totals.costCents;
  for (const t of turns) if (t.calls === 0) delete t.costCents;

  return {
    turns,
    totals,
    levers,
    shell: shellRows(lifecycle),
    checkpoints,
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
  };
}

/** True when the run produced anything the coding panels can show. */
export function hasRunWork(w: RunWork): boolean {
  return w.totals.calls > 0 || w.checkpoints.length > 0 || w.shell.length > 0 || w.levers.length > 0;
}

/** Whether the Workspace panel may offer rewind; mirrors the API's own refusals. */
export function rewindGate(
  status: string | undefined,
  live: boolean,
): { allowed: true } | { allowed: false; reason: string } {
  if (!status) return { allowed: false, reason: 'Waiting for the run to load.' };
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled')
    return { allowed: false, reason: 'The run has finished; its worktree is gone.' };
  if (!live) return { allowed: false, reason: 'The worktree is no longer on disk.' };
  if (status === 'running' || status === 'pending')
    return { allowed: false, reason: 'Pause the run to rewind: the agent is still editing.' };
  return { allowed: true };
}

/** Plain words for Zephyr's shell classes. */
export const SHELL_CLASS_LABEL: Record<string, string> = {
  inspect: 'Read-only',
  verify: 'Runs checks',
  mutate_env: 'Changes the environment',
  network: 'Network',
  unknown: 'Unclassified',
};

/** What the person sees for a shell row's outcome. */
export function shellOutcome(row: ShellRow): string {
  switch (row.phase) {
    case 'succeeded':
      return row.policy === 'auto' ? 'Ran automatically' : 'Ran after approval';
    case 'failed':
      return 'Ran, exited with an error';
    case 'blocked':
      return 'Blocked';
    case 'approved':
    case 'executing':
      return 'Running';
    case 'awaiting_approval':
      return 'Waiting for you';
    default:
      return row.allowed === false ? 'Not allowed' : 'Proposed';
  }
}
