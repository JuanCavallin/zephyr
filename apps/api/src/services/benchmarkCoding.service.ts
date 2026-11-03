/**
 * Coding benchmark agents and report (docs/cacp-09-benchmark-cli-demo.md).
 *
 * The mock agent replays each task's reference fix with the scripted mockharness. It
 * exists so the whole pipeline (fresh repo → agent → hidden test → journal → report)
 * runs offline and in CI. Every Zephyr arm sends each step through the real
 * permission bridge, so what it counts (approvals, blocks, shaped-tool redirects) is
 * what the bridge actually decided. Its token figures are synthetic, derived from the
 * bytes the script moves, and every row is journalled with `mode: 'mock'`: they show
 * that the arithmetic works, not what Zephyr saves.
 *
 * Live agents live in benchmarkCoding.live.ts and spend money; they only run when
 * the CLI is given `--mode live` explicitly.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodingReport,
  type CodingBenchmarkReport,
  type CodingTokens,
  type NativeToolRequest,
  type ProviderCallContext,
} from '@htn/shared';
import { createPermissionBridge } from '../core/tools/permissionBridge.js';
import type { ToolApprovalGate } from '../core/tools/approval.js';
import { SHAPED_HARNESS_NAMES } from '../core/tools/shaped/index.js';
import type { ShapedCommandKind } from '../core/tools/shellClassifier.js';
import { createMockHarness, type MockHarnessStep } from '../providers/mockharness/index.js';
import { readJournal, type AgentOutcome, type CodingAgent } from '../core/benchmark/coding/index.js';

/** Repo-root `.data/bench/coding.jsonl` unless CODING_BENCH_JOURNAL says otherwise. */
export const DEFAULT_CODING_JOURNAL =
  process.env.CODING_BENCH_JOURNAL ?? fileURLToPath(new URL('../../../../.data/bench/coding.jsonl', import.meta.url));

/** Nominal per-token prices for the mock's synthetic cost column (USD per million). */
const MOCK_PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as const;
/** Fixed per-turn context the mock charges (system prompt + tool schemas). */
const MOCK_TURN_INPUT = 1_200;
const MOCK_TURN_OUTPUT = 60;

export function mockCost(t: CodingTokens): number {
  return (
    (t.input * MOCK_PRICE.input +
      t.output * MOCK_PRICE.output +
      t.cacheRead * MOCK_PRICE.cacheRead +
      t.cacheWrite * MOCK_PRICE.cacheWrite) /
    1_000_000
  );
}

const SHAPED_KINDS: readonly ShapedCommandKind[] = ['test', 'build', 'lint'];

/** Bytes a step moves through the context window, for the synthetic token count. */
async function stepBytes(repoDir: string, step: MockHarnessStep): Promise<{ in: number; out: number }> {
  if (step.tool === 'Read') {
    const text = await readFile(join(repoDir, ...step.path.split('/')), 'utf8').catch(() => '');
    return { in: text.length, out: step.path.length };
  }
  if (step.tool === 'Write') return { in: 0, out: step.content.length };
  if (step.tool === 'Edit') return { in: 0, out: step.find.length + step.replace.length };
  return { in: 400, out: step.command.length };
}

/**
 * The offline agent. Vanilla applies every step; a Zephyr arm asks the permission
 * bridge first, with the arm's levers deciding which shaped tools are on offer. A raw
 * test run denied in favour of a shaped tool is re-issued as that tool, through the
 * bridge again. Any other denial is a stuck block; the step is skipped.
 */
export function mockCodingAgent(): CodingAgent {
  return async ({ task, arm, repoDir, signal }): Promise<AgentOutcome> => {
    let approvals = 0;
    let stuckBlocks = 0;
    let redirects = 0;
    const gate: ToolApprovalGate = {
      async request() {
        approvals++;
        return { approvalId: 'apr_bench_' + approvals };
      },
    };
    const bridge = arm.zephyr
      ? createPermissionBridge({
          harness: 'mockharness',
          worktree: repoDir,
          run: { runId: 'run_bench_' + task.id, stepId: 'stp_bench_' + task.id },
          approvals: gate,
          ...(arm.levers.shapedTools ? { shapedTools: SHAPED_KINDS } : {}),
        })
      : null;

    const decide = async (req: NativeToolRequest) => {
      if (!bridge) return 'allow' as const;
      const d = await bridge.decide(req, signal);
      if (d.verdict !== 'deny') return d.verdict;
      if (d.exact?.reasonCodes.includes('use-shaped-tool')) {
        redirects++;
        const shaped = await bridge.decide(
          { ...req, toolName: SHAPED_HARNESS_NAMES.test, rawInput: {}, toolCallId: req.toolCallId + ':shaped' },
          signal,
        );
        if (shaped.verdict !== 'deny') return 'allow' as const;
      }
      stuckBlocks++;
      return 'deny' as const;
    };

    const harness = createMockHarness({ decide: (req) => decide(req) });
    const pctx: ProviderCallContext = { runId: 'run_bench_' + task.id, policyRule: 'benchmark:coding:mock' };
    const tokens: CodingTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const script = task.solution as MockHarnessStep[];
      const started = await harness.startTask(
        { goal: task.prompt, context: { workspaceDir: repoDir, script, taskId: task.id } },
        pctx,
      );
      if (!started.ok) throw new Error(started.error.message);
      let turn = 0;
      for (;;) {
        if (signal.aborted) throw new Error('cancelled');
        const step = script[turn];
        if (step) {
          const bytes = await stepBytes(repoDir, step);
          // The prefix is cached after the first turn; everything new is fresh input.
          tokens.cacheRead += turn === 0 ? 0 : MOCK_TURN_INPUT;
          tokens.cacheWrite += turn === 0 ? MOCK_TURN_INPUT : 0;
          tokens.input += Math.ceil(bytes.in / 4);
          tokens.output += MOCK_TURN_OUTPUT + Math.ceil(bytes.out / 4);
        }
        const polled = await harness.pollTask(started.data.taskId, pctx);
        if (!polled.ok) throw new Error(polled.error.message);
        turn++;
        if (polled.data.status === 'done') break;
        if (polled.data.status === 'failed') {
          // A failed edit is a failed run, not an error: the hidden test will say so.
          break;
        }
      }
      // Each denial costs the agent one more round trip.
      tokens.cacheRead += (stuckBlocks + redirects) * MOCK_TURN_INPUT;
      tokens.output += (stuckBlocks + redirects) * MOCK_TURN_OUTPUT;
      return {
        tokens,
        costUsd: mockCost(tokens),
        approvals,
        stuckBlocks,
        detail: 'mock: synthetic tokens; ' + redirects + ' shaped-tool redirect(s)',
      };
    } finally {
      await harness.dispose();
    }
  };
}

/** The Compare page's coding report, from the journal. */
export async function codingBenchmarkReport(journal: string = DEFAULT_CODING_JOURNAL): Promise<CodingBenchmarkReport> {
  const { results } = await readJournal(journal);
  return buildCodingReport(results);
}
