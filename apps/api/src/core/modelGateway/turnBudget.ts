/**
 * The per-turn tool budget, shared by both gateway surfaces: the OpenAI-compatible
 * route Hermes uses (service.ts) and the Anthropic Messages passthrough Claude Code
 * uses (messages.ts). Same number, same instruction, so a harness switch does not
 * change how long a turn may run.
 */

export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * Hermes's ACP adapter builds every agent with an unlimited per-prompt
 * iteration budget and ignores `agent.max_turns`, so one turn could chain
 * tool calls until the wall-clock budget ran out (35 calls in a single
 * 7-minute turn, observed live). The orchestrator's completion judge only runs
 * BETWEEN turns, so it never got a say. Once a turn spends its budget, the
 * next model call gets no tools and this instruction, the model answers in
 * text, the harness ends the turn, and the judge decides whether to continue.
 *
 * It asks for a final answer, not a progress report: "list what is still
 * missing" turned every capped turn into a to-do list the judge then
 * (reasonably) sent back for another full turn.
 */
export const TOOL_BUDGET_EXHAUSTED_INSTRUCTION =
  'Tool budget for this turn is used up; tools are unavailable. Do not call tools. ' +
  'Give your final answer now from what you have found: the concrete results and their ' +
  'sources. If a requested item could not be found, say so in one sentence.';
