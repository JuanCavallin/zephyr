/**
 * The baseline playbook (B0) — the naive comparison point for the Compare view.
 *
 * ONE frontier-tier LLM call. No tools, no decomposition, no redaction gate.
 * That last part is deliberate, not an oversight: the task goes to the model
 * as-is, PII and all. This is what "just ask the model to do it" actually
 * looks like — the exact risk `redact` nodes exist to prevent. The comparison
 * view reads that gap straight from the egress ledger and PII spans (0 for
 * the baseline, several for the graph), no special-casing needed.
 *
 * THE TASK IS THE GRAPH'S TASK. runs.service resolves the graph's prompt (the
 * chat request that built it, the run's variables, and any source text the
 * graph carries) and snapshots it into `input.prompt` before this runs; see
 * baselineTask.ts. Only a baseline launched with no graph falls back to the
 * original fixed demo case file.
 *
 * The reply is asked for as JSON carrying the same field names the graph's
 * assertions read (e.g. graph_demo's `a_verdict` reads `choice`), so the SAME
 * expectations can be checked against it — see evaluateAssertionsAgainstResult
 * in @htn/shared.
 */

import { baselineInputSchema, type BaselineAnswerField, type BaselineInput } from '@htn/shared';
import { caseFile } from './demo.playbook.js';
import { answerContract, parseBaselineReply } from './baselineTask.js';
import { definePlaybook } from './types.js';

/** The legacy, graph-less demo: the fixed case file and its two-way verdict. */
const LEGACY_FIELDS: BaselineAnswerField[] = [
  { name: 'choice', options: ['file_correction', 'no_action'] },
];

/** The task and reply fields a baseline run works from, graph-derived or legacy. */
export function baselineTaskOf(input: BaselineInput): {
  prompt: string;
  answerFields: BaselineAnswerField[];
} {
  if (input.prompt) return { prompt: input.prompt, answerFields: input.answerFields ?? [] };
  return { prompt: caseFile(input.target, true), answerFields: LEGACY_FIELDS };
}

export const baselinePlaybook = definePlaybook<BaselineInput>({
  kind: 'baseline',
  title: 'Baseline (single LLM call, no graph)',
  inputSchema: baselineInputSchema,
  async execute(ctx, input) {
    const { prompt, answerFields } = baselineTaskOf(input);
    await ctx.log(
      'info',
      'Running single-shot baseline' +
        (input.graphId ? ' for graph ' + input.graphId : ' for ' + input.target) +
        ' (' +
        (input.promptSource ?? 'legacy_case_file') +
        ' prompt, ' +
        prompt.length +
        ' chars).',
    );

    const reply = await ctx.step(
      { label: 'Single LLM call (no tools, no graph, unredacted)', kind: 'decide' },
      async (step) => {
        const model = ctx.provider('text.model');
        const res = await model.complete(
          {
            system:
              'You handle the whole task yourself, end to end, in one reply. You have no ' +
              'tools and cannot browse or take actions. ' +
              answerContract(answerFields),
            prompt,
            tier: 'frontier',
            // A graph task asks for a complete result, not a one-word verdict.
            maxTokens: input.prompt ? 4096 : 512,
            json: true,
          },
          // Intentionally NO `redactions` here -- nothing was redacted. The
          // policy rule names that plainly rather than dressing it up.
          ctx.callContext({ stepId: step.id, policyRule: 'baseline-single-call-unredacted' }),
        );
        if (!res.ok) throw new Error('Baseline model call failed: ' + res.error.message);
        return (
          parseBaselineReply(res.data.text) ?? {
            answer: '',
            confidence: 0,
            rationale:
              'Could not parse a JSON reply from the model: ' + res.data.text.slice(0, 200),
          }
        );
      },
    );

    // Self-reported confidence, NOT calibrated like Jev's probabilities —
    // label it as such anywhere it's shown next to a real confidence number.
    // Graph-derived fields arrive under `outcomes`, keyed by assertion id; the
    // legacy case-file reply puts its one field at the top level.
    const summaryField = answerFields[0]?.name;
    const outcomes =
      reply.outcomes && typeof reply.outcomes === 'object' && !Array.isArray(reply.outcomes)
        ? (reply.outcomes as Record<string, unknown>)
        : reply;
    const headline =
      summaryField && typeof outcomes[summaryField] === 'string'
        ? String(outcomes[summaryField])
        : 'answer returned';
    return {
      summary:
        'Baseline (single call) for ' + (input.graphId ?? input.target) + ': ' + headline + '.',
      result: JSON.parse(
        JSON.stringify({ target: input.target, graphId: input.graphId ?? null, ...reply }),
      ),
    };
  },
});
