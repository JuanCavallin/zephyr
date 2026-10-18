/**
 * The all-tools baseline (B1): ONE agent, frontier model, every eligible tool,
 * no graph and no Jev routing.
 *
 * This is the comparison point the design spec's evaluation criterion names —
 * "the same task runs against a frontier-model/all-tools baseline; savings
 * count only when both succeed". It is the fair "no orchestration" control:
 * unlike B0 it CAN browse and call tools, so a task that needs tools does not
 * fail it trivially, and any saving the graph shows over it is the graph's.
 *
 * What it keeps from the platform, on purpose: redaction-driven data labels,
 * tool eligibility, and per-action approval. Those are safety floors, not
 * orchestration; dropping them would make the baseline faster by making it
 * unsafe. What it drops: the graph's decomposition, Jev's tool narrowing, and
 * Jev's per-turn model choice (pinned to a frontier route instead).
 */

import { baselineAgentInputSchema, type BaselineAgentInput, type Json } from '@htn/shared';
import { baselineTaskOf } from './baseline.playbook.js';
import { answerContract, parseBaselineReply } from './baselineTask.js';
import { definePlaybook } from './types.js';

/** Hermes reports its final turn as `{ text }`; other runtimes may not. */
function replyText(result: unknown): unknown {
  if (result && typeof result === 'object' && 'text' in result) {
    return (result as { text: unknown }).text;
  }
  return result;
}

export const baselineAgentPlaybook = definePlaybook<BaselineAgentInput>({
  kind: 'baseline_agent',
  title: 'Baseline (one agent, all tools, frontier model)',
  inputSchema: baselineAgentInputSchema,
  directLaunch: false,

  async execute(ctx, input) {
    const { prompt, answerFields } = baselineTaskOf(input);
    const goal =
      prompt +
      '\n\nWork the whole task yourself, using any tools you need. When you are done, ' +
      answerContract(answerFields).replace(/^Reply/, 'reply');

    // Same labelling as the `agent` playbook: anything sensitive in the task
    // keeps it off public-only cloud routes, exactly as it would for a graph.
    const redaction = await ctx.redact(goal, 'baseline_goal');
    const dataLabels = redaction.hadSensitive ? (['private'] as const) : (['public'] as const);

    const agentTask = await ctx.runAgentTask({
      label: 'One agent, all tools, frontier model (no graph, no Jev routing)',
      goal,
      sanitizedGoal: redaction.redacted,
      dataLabels: [...dataLabels],
      availableTools: [],
      routing: 'all_tools_frontier',
      // Generous on purpose; the run-wide agent ceiling clamps both, the same
      // ceiling every graph agent node is held to.
      maxTurns: 12,
      maxDurationMs: 600_000,
    });

    const reply = parseBaselineReply(replyText(agentTask.result)) ?? {
      answer: typeof replyText(agentTask.result) === 'string' ? replyText(agentTask.result) : '',
      rationale: 'The agent did not finish with a JSON object.',
    };
    return {
      summary:
        'Baseline (one agent, all tools) for ' +
        (input.graphId ?? input.target) +
        ': ' +
        agentTask.scheduleDecision.exposedTools.length +
        ' tool(s) exposed, ' +
        agentTask.toolCalls.length +
        ' call(s).',
      result: JSON.parse(
        JSON.stringify({
          target: input.target,
          graphId: input.graphId ?? null,
          ...reply,
          exposedTools: agentTask.scheduleDecision.exposedTools.length,
          toolCalls: agentTask.toolCalls.length,
          // Benchmark success requires a verified `done`, the same bar a graph
          // agent node is held to, so record both halves of the verdict.
          completion: {
            status: agentTask.completionDecision.status,
            verified: agentTask.completionDecision.verified,
          },
        }),
      ) as Json,
    };
  },
});
