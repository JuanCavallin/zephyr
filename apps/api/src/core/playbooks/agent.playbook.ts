import { agentInputSchema, type AgentInput, type CompletionDecision, type Json } from '@htn/shared';
import { definePlaybook } from './types.js';

/** Generic UI entry point: one user objective becomes one supervised Hermes run. */
export const agentPlaybook = definePlaybook<AgentInput>({
  kind: 'agent',
  title: 'Run a supervised agent task',
  directLaunch: false,
  inputSchema: agentInputSchema,

  async execute(ctx, input) {
    const redaction = await ctx.redact(input.goal, 'agent_goal');
    const dataLabels =
      input.dataLabels ?? (redaction.hadSensitive ? (['private'] as const) : (['public'] as const));
    const sanitizedGoal =
      input.sanitizedGoal ??
      (input.dataLabels && input.dataLabels.some((label) => label !== 'public')
        ? undefined
        : redaction.redacted);
    const agentTask = await ctx.runAgentTask({
      label: 'Run supervised agent task',
      goal: input.goal,
      context: input.context,
      sanitizedGoal,
      dataLabels: [...dataLabels],
      availableTools: [],
      maxTurns: input.maxTurns,
    });
    return {
      summary: verdictSummary(agentTask.completionDecision),
      result: toJson({
        output: agentTask.result,
        exposedTools: agentTask.scheduleDecision.exposedTools,
        modelTier: agentTask.scheduleDecision.modelTier,
        completion: agentTask.completionDecision,
      }),
    };
  },
});

/** The run summary says what Jev decided; the agent itself always ran exactly once. */
function verdictSummary(decision: CompletionDecision): string {
  const confidence = ' (confidence ' + decision.confidence.toFixed(2) + ')';
  if (decision.status === 'done' && decision.verified)
    return 'Agent task finished; Jev judged it done' + confidence + '.';
  if (decision.status === 'done')
    return (
      'Agent task finished; Jev judged it done' +
      confidence +
      ', but AgentOS could not verify: ' +
      decision.verificationFailures.join(', ') +
      '.'
    );
  return (
    'Agent task finished; Jev judged it ' +
    decision.status +
    confidence +
    '. The agent was not run again.'
  );
}

function toJson(value: unknown): Json {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}
