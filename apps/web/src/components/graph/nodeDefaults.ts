/**
 * Minimal valid config per node type, for the "add node" palette.
 *
 * Every variant here must satisfy graphNodeSchema's minimums (agentGraphSchema
 * re-validates the whole document on every add) or POST /graphs/:id/nodes 400s
 * the moment someone drops a node on the canvas. Real tool names from the
 * catalog are used when available so a freshly-added node is demo-able without
 * an edit first; falling back to a placeholder otherwise.
 */

import type { GraphNode, GraphNodeType } from '@htn/shared';
import { newClientId } from '../../lib/ids';

const TYPE_LABEL: Record<GraphNodeType, string> = {
  fetch: 'Fetch source',
  tool: 'Call tool',
  dispatch: 'Pick a tool',
  redact: 'Redact PII',
  decide: 'Decide',
  agent_task: 'Agent subtask',
  code: 'Run code (sandbox)',
  swarm: 'Fan out',
  judge: 'Judge',
  submit: 'Submit (approval)',
  approval: 'Approval gate',
  handoff: 'Human takes over',
};

export function defaultLabelFor(type: GraphNodeType): string {
  return TYPE_LABEL[type];
}

export function buildDefaultNode(
  type: GraphNodeType,
  position: { x: number; y: number },
  toolNames: string[],
): GraphNode {
  const id = newClientId(type);
  const label = TYPE_LABEL[type];
  const first = toolNames[0] ?? 'set_tool_name';
  const second = toolNames[1] ?? 'set_another_tool';

  const base = { id, label, position };

  switch (type) {
    case 'fetch':
      return { ...base, type, config: { source: 'https://example.com' } };
    case 'tool':
      return { ...base, type, config: { tool: first, args: {} } };
    case 'dispatch':
      return {
        ...base,
        type,
        config: {
          goal: 'Describe the goal',
          candidateTools: [first, second],
          args: {},
          argsFrom: 'static',
        },
      };
    case 'redact':
      return { ...base, type, config: { field: 'input' } };
    case 'decide':
      return { ...base, type, config: { prompt: 'Describe what to decide' } };
    case 'agent_task':
      return {
        ...base,
        type,
        config: { goal: 'Describe the subtask', availableTools: toolNames.slice(0, 4) },
      };
    case 'code':
      return {
        ...base,
        type,
        config: { goal: 'Describe what the script should compute', inputs: {}, language: 'javascript' },
      };
    case 'swarm':
      return { ...base, type, config: { items: ['item-1'] } };
    case 'judge':
      return {
        ...base,
        type,
        config: { question: 'Describe the decision', options: ['option_a', 'option_b'] },
      };
    case 'submit':
      return {
        ...base,
        type,
        config: { tool: first, args: {}, description: 'Describe what this submits' },
      };
    case 'approval':
      return { ...base, type, config: { description: 'Describe what requires approval' } };
    case 'handoff':
      return {
        ...base,
        type,
        config: {
          // Phrased as the reassurance it needs to be: the person is about to
          // type something we are promising never to see.
          instruction: 'Sign in with your own credentials. We never see them.',
          resumeWhen: 'human_confirms',
        },
      };
  }
}
