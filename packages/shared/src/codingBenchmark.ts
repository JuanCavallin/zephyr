/**
 * Coding benchmark (docs/cacp-09-benchmark-cli-demo.md): arm definitions, per-run
 * results and the report rule. Pure, so the API, the CLI script and the Compare page
 * all apply the same math.
 *
 * The report rule is enforced here, not in the UI: a saving is shown only for an arm
 * whose hidden-test pass rate is within noise of the vanilla arm or better. Otherwise
 * the arm is labelled "not comparable" and no saving is computed at all.
 */

import { z } from 'zod';
import { quantile } from './benchmark.js';
import { DEFAULT_LEVERS, type Levers } from './coding.js';

/* -------------------------------------------------------------------------- */
/* Arms                                                                       */
/* -------------------------------------------------------------------------- */

export const CODING_ARM_IDS = ['vanilla', 'supervised', 'loo-L1', 'loo-L2', 'loo-L3', 'skills-off'] as const;
export type CodingArmId = (typeof CODING_ARM_IDS)[number];

/**
 * One arm of the experiment. Arms differ ONLY by these policy flags: same model, same
 * prompt, same task, same harness binary.
 *
 * - `zephyr`: the harness runs under Zephyr (permission bridge, gateway, leases).
 *   Off means the harness alone, with its own permissions.
 * - `levers`: step 5 token levers (L1 shaped tools, L2 context pack, L3 schema min).
 * - `skills`: step 8 learned knowledge (playbooks, preferences) in the context pack.
 */
export interface CodingArm {
  id: CodingArmId;
  label: string;
  /** One line: what this arm isolates. */
  purpose: string;
  zephyr: boolean;
  levers: Levers;
  skills: boolean;
}

const ALL_OFF: Levers = { shapedTools: false, contextPack: false, schemaMin: false };

export const CODING_ARMS: Record<CodingArmId, CodingArm> = {
  vanilla: {
    id: 'vanilla',
    label: 'Harness alone',
    purpose: 'Arm (a): the same model and prompt with no Zephyr at all.',
    zephyr: false,
    levers: ALL_OFF,
    skills: false,
  },
  supervised: {
    id: 'supervised',
    label: 'Harness under Zephyr',
    purpose: 'Arm (b): supervised, every lever and learned skills on.',
    zephyr: true,
    levers: { ...DEFAULT_LEVERS },
    skills: true,
  },
  'loo-L1': {
    id: 'loo-L1',
    label: 'Zephyr without L1',
    purpose: 'Leave-one-out: shaped test/build/lint tools off.',
    zephyr: true,
    levers: { ...DEFAULT_LEVERS, shapedTools: false },
    skills: true,
  },
  'loo-L2': {
    id: 'loo-L2',
    label: 'Zephyr without L2',
    purpose: 'Leave-one-out: context pack off.',
    zephyr: true,
    levers: { ...DEFAULT_LEVERS, contextPack: false },
    skills: true,
  },
  'loo-L3': {
    id: 'loo-L3',
    label: 'Zephyr without L3',
    purpose: 'Leave-one-out: tool-schema minimisation off.',
    zephyr: true,
    levers: { ...DEFAULT_LEVERS, schemaMin: false },
    skills: true,
  },
  'skills-off': {
    id: 'skills-off',
    label: 'Zephyr without learned skills',
    purpose: 'Arm (d): every lever on, step 8 knowledge left out of the context.',
    zephyr: true,
    levers: { ...DEFAULT_LEVERS },
    skills: false,
  },
};

/** The lever each leave-one-out arm removes, so a harmful lever can be named. */
export const LEAVE_ONE_OUT: Partial<Record<CodingArmId, keyof Levers | 'skills'>> = {
  'loo-L1': 'shapedTools',
  'loo-L2': 'contextPack',
  'loo-L3': 'schemaMin',
  'skills-off': 'skills',
};

export function isCodingArmId(value: string): value is CodingArmId {
  return (CODING_ARM_IDS as readonly string[]).includes(value);
}

/** The policy flags of an arm, flattened (`levers.shapedTools` etc.). */
export function armFlags(arm: CodingArm): Record<string, boolean> {
  return {
    zephyr: arm.zephyr,
    ...Object.fromEntries(Object.entries(arm.levers).map(([k, v]) => ['levers.' + k, v])),
    skills: arm.skills,
  };
}

/** Flags that differ between two arms, sorted. */
export function armDiff(a: CodingArm, b: CodingArm): string[] {
  const fa = armFlags(a);
  const fb = armFlags(b);
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k]).sort();
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export const codingTokensSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});
export type CodingTokens = z.infer<typeof codingTokensSchema>;

/**
 * One (task, arm, repetition) run. `status: 'network'` means the agent never got to
 * work (transport failure after the allowed retries): such rows are excluded from the
 * report and re-attempted on resume. `error` is any other failure, which counts as a
 * failed run.
 */
export const codingRunResultSchema = z.object({
  taskId: z.string().min(1),
  arm: z.enum(CODING_ARM_IDS),
  rep: z.number().int().nonnegative(),
  mode: z.enum(['mock', 'live']),
  status: z.enum(['ok', 'error', 'network']),
  passed: z.boolean(),
  hidden: z.object({ pass: z.number(), fail: z.number(), timedOut: z.boolean() }),
  tokens: codingTokensSchema,
  costUsd: z.number().nonnegative(),
  wallMs: z.number().nonnegative(),
  approvals: z.number().int().nonnegative(),
  stuckBlocks: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  error: z.string().optional(),
  detail: z.string().optional(),
  at: z.string(),
});
export type CodingRunResult = z.infer<typeof codingRunResultSchema>;

export const codingRunKey = (r: Pick<CodingRunResult, 'taskId' | 'arm' | 'rep'>): string =>
  r.taskId + '|' + r.arm + '|' + r.rep;

export const totalTokens = (t: CodingTokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

/** Median with the interquartile range as spread. */
export interface Spread {
  median: number;
  p25: number;
  p75: number;
}

export const CODING_METRICS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'costUsd',
  'wallMs',
  'approvals',
  'stuckBlocks',
] as const;
export type CodingMetric = (typeof CODING_METRICS)[number];

export function metricOf(r: CodingRunResult, m: CodingMetric): number {
  switch (m) {
    case 'inputTokens':
      return r.tokens.input;
    case 'outputTokens':
      return r.tokens.output;
    case 'cacheReadTokens':
      return r.tokens.cacheRead;
    case 'cacheWriteTokens':
      return r.tokens.cacheWrite;
    case 'totalTokens':
      return totalTokens(r.tokens);
    default:
      return r[m];
  }
}

export function spreadOf(values: number[]): Spread {
  return { median: quantile(values, 0.5), p25: quantile(values, 0.25), p75: quantile(values, 0.75) };
}

export interface CodingCell {
  taskId: string;
  arm: CodingArmId;
  runs: number;
  passed: number;
  passRate: number;
  metrics: Record<CodingMetric, Spread>;
}

export type Comparability = 'baseline' | 'comparable' | 'not_comparable' | 'insufficient';

export interface CodingArmReport {
  arm: CodingArmId;
  label: string;
  purpose: string;
  /** Flags that differ from the vanilla arm. */
  diffFromVanilla: string[];
  runs: number;
  passed: number;
  passRate: number;
  /** Runs excluded because of network failures (not counted anywhere else). */
  networkExcluded: number;
  metrics: Record<CodingMetric, Spread>;
  /**
   * `baseline`: this is arm (a). `insufficient`: some task has fewer than
   * MIN_RUNS_PER_CELL runs in this arm or in vanilla. `not_comparable`: pass rate is
   * below vanilla's by more than the noise bar. `comparable`: savings are shown.
   */
  comparability: Comparability;
  /** Pass-rate noise bar against vanilla (95%, pooled two-proportion). */
  noise: number;
  /**
   * Paired savings against vanilla: 1 − median over tasks of (this arm's per-task
   * median ÷ vanilla's per-task median). Present only when comparable.
   */
  savings?: { totalTokens: number; inputTokens: number; costUsd: number; wallMs: number; tasks: number };
}

export interface LeverVerdict {
  arm: CodingArmId;
  lever: string;
  /** `harmful`: removing it raised the pass rate beyond noise. */
  verdict: 'harmful' | 'neutral_or_helpful' | 'insufficient';
  passWith: number;
  passWithout: number;
  noise: number;
}

export interface CodingBenchmarkReport {
  protocol: typeof CODING_BENCHMARK_PROTOCOL;
  /** `mock` numbers come from the scripted harness and say nothing about real cost. */
  mode: 'mock' | 'live' | 'mixed' | 'empty';
  generatedAt: string;
  minRunsPerCell: number;
  tasks: string[];
  arms: CodingArmReport[];
  cells: CodingCell[];
  levers: LeverVerdict[];
}

export const CODING_BENCHMARK_PROTOCOL = 'zephyr-coding-benchmark-v1' as const;
export const MIN_RUNS_PER_CELL = 3;

/** 95% noise bar for a difference of two pass rates (pooled two-proportion z). */
export function passRateNoise(passA: number, nA: number, passB: number, nB: number): number {
  if (nA === 0 || nB === 0) return 1;
  const p = (passA + passB) / (nA + nB);
  return 1.96 * Math.sqrt(p * (1 - p) * (1 / nA + 1 / nB));
}

function metricSpreads(runs: CodingRunResult[]): Record<CodingMetric, Spread> {
  return Object.fromEntries(CODING_METRICS.map((m) => [m, spreadOf(runs.map((r) => metricOf(r, m)))])) as Record<
    CodingMetric,
    Spread
  >;
}

function pairedSaving(
  cellsA: Map<string, CodingRunResult[]>,
  cellsBase: Map<string, CodingRunResult[]>,
  metric: CodingMetric,
): { saving: number; tasks: number } | null {
  const ratios: number[] = [];
  for (const [taskId, runs] of cellsA) {
    const base = cellsBase.get(taskId);
    if (!base?.length || !runs.length) continue;
    const b = quantile(base.map((r) => metricOf(r, metric)), 0.5);
    if (b <= 0) continue;
    ratios.push(quantile(runs.map((r) => metricOf(r, metric)), 0.5) / b);
  }
  if (ratios.length === 0) return null;
  return { saving: 1 - quantile(ratios, 0.5), tasks: ratios.length };
}

function byTask(runs: CodingRunResult[]): Map<string, CodingRunResult[]> {
  const m = new Map<string, CodingRunResult[]>();
  for (const r of runs) m.set(r.taskId, [...(m.get(r.taskId) ?? []), r]);
  return m;
}

/**
 * Reduce run results to the report. Rows with `status: 'network'` are excluded; for a
 * repeated key only the last row counts (a resumed run supersedes the old one).
 */
export function buildCodingReport(
  results: CodingRunResult[],
  opts: { now?: string; minRunsPerCell?: number; tasks?: string[] } = {},
): CodingBenchmarkReport {
  const minRuns = opts.minRunsPerCell ?? MIN_RUNS_PER_CELL;
  const latest = new Map<string, CodingRunResult>();
  for (const r of results) latest.set(codingRunKey(r), r);
  const all = [...latest.values()];
  const counted = all.filter((r) => r.status !== 'network');
  const tasks = opts.tasks ?? [...new Set(all.map((r) => r.taskId))].sort();
  const modes = new Set(counted.map((r) => r.mode));
  const mode = modes.size === 0 ? 'empty' : modes.size > 1 ? 'mixed' : [...modes][0]!;

  const armsPresent = CODING_ARM_IDS.filter((a) => all.some((r) => r.arm === a));
  const runsOf = (arm: CodingArmId) => counted.filter((r) => r.arm === arm);
  const vanillaRuns = runsOf('vanilla');
  const vanillaCells = byTask(vanillaRuns);
  const vanillaPassed = vanillaRuns.filter((r) => r.passed).length;
  const sufficient = (cells: Map<string, CodingRunResult[]>) =>
    tasks.length > 0 && tasks.every((t) => (cells.get(t)?.length ?? 0) >= minRuns);

  const cells: CodingCell[] = [];
  for (const arm of armsPresent) {
    const cellMap = byTask(runsOf(arm));
    for (const taskId of tasks) {
      const runs = cellMap.get(taskId) ?? [];
      const passed = runs.filter((r) => r.passed).length;
      cells.push({ taskId, arm, runs: runs.length, passed, passRate: runs.length ? passed / runs.length : 0, metrics: metricSpreads(runs) });
    }
  }

  const arms: CodingArmReport[] = armsPresent.map((armId) => {
    const def = CODING_ARMS[armId];
    const runs = runsOf(armId);
    const passed = runs.filter((r) => r.passed).length;
    const passRate = runs.length ? passed / runs.length : 0;
    const cellMap = byTask(runs);
    const base: CodingArmReport = {
      arm: armId,
      label: def.label,
      purpose: def.purpose,
      diffFromVanilla: armDiff(CODING_ARMS.vanilla, def),
      runs: runs.length,
      passed,
      passRate,
      networkExcluded: all.filter((r) => r.arm === armId && r.status === 'network').length,
      metrics: metricSpreads(runs),
      comparability: 'baseline',
      noise: 0,
    };
    if (armId === 'vanilla') return base;
    const noise = passRateNoise(passed, runs.length, vanillaPassed, vanillaRuns.length);
    base.noise = noise;
    if (!sufficient(cellMap) || !sufficient(vanillaCells)) return { ...base, comparability: 'insufficient' };
    const vanillaRate = vanillaPassed / vanillaRuns.length;
    if (passRate < vanillaRate - noise) return { ...base, comparability: 'not_comparable' };
    const tot = pairedSaving(cellMap, vanillaCells, 'totalTokens');
    const inp = pairedSaving(cellMap, vanillaCells, 'inputTokens');
    const cost = pairedSaving(cellMap, vanillaCells, 'costUsd');
    const wall = pairedSaving(cellMap, vanillaCells, 'wallMs');
    return {
      ...base,
      comparability: 'comparable',
      savings: {
        totalTokens: tot?.saving ?? 0,
        inputTokens: inp?.saving ?? 0,
        costUsd: cost?.saving ?? 0,
        wallMs: wall?.saving ?? 0,
        tasks: tot?.tasks ?? 0,
      },
    };
  });

  const supervised = runsOf('supervised');
  const supPassed = supervised.filter((r) => r.passed).length;
  const levers: LeverVerdict[] = [];
  for (const [armId, lever] of Object.entries(LEAVE_ONE_OUT) as [CodingArmId, string][]) {
    if (!armsPresent.includes(armId)) continue;
    const without = runsOf(armId);
    const wPassed = without.filter((r) => r.passed).length;
    const noise = passRateNoise(supPassed, supervised.length, wPassed, without.length);
    const passWith = supervised.length ? supPassed / supervised.length : 0;
    const passWithout = without.length ? wPassed / without.length : 0;
    const enough = sufficient(byTask(supervised)) && sufficient(byTask(without));
    levers.push({
      arm: armId,
      lever,
      verdict: !enough ? 'insufficient' : passWithout > passWith + noise ? 'harmful' : 'neutral_or_helpful',
      passWith,
      passWithout,
      noise,
    });
  }

  return {
    protocol: CODING_BENCHMARK_PROTOCOL,
    mode,
    generatedAt: opts.now ?? new Date().toISOString(),
    minRunsPerCell: minRuns,
    tasks,
    arms,
    cells,
    levers,
  };
}
