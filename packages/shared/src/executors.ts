/**
 * WHO runs a node, as opposed to WHAT KIND of work it is.
 *
 * `GraphNodeType` answers "what kind of work" — fetch, judge, redact. That is
 * the right axis for the interpreter and the wrong one for the canvas. To make
 * an agentic process legible you have to show, at a glance, which box is our
 * own deterministic code, which is a real external tool, which is a cheap
 * model call, and which is an opaque agent loop we cannot see inside.
 *
 * That is this file. The executor is DERIVED from the node type, never stored,
 * so it cannot drift from the schema. It lives in @htn/shared because the API
 * (step labelling, telemetry grouping) and the web app (colour, icon, border)
 * must agree on exactly one mapping.
 *
 * The palette is not invented here — it matches the classDefs already used in
 * docs/archive/example_flow.md, which the team agreed on before any of this existed.
 */

import type { GraphNodeType } from './schemas/graph.js';

export type NodeExecutor =
  /** Our own deterministic code. No model, no network. */
  | 'program'
  /** A real external system with real side effects. No model in the loop. */
  | 'tool'
  /** One cheap classify/route call. */
  | 'decision'
  /** One frontier-ish text completion. */
  | 'model'
  /** An agent harness running its own hidden multi-turn loop. */
  | 'agent'
  /** Blocks for a person. */
  | 'human'
  /** A container for other work (fan-out). */
  | 'group';

export const NODE_EXECUTORS = [
  'program',
  'tool',
  'decision',
  'model',
  'agent',
  'human',
  'group',
] as const satisfies readonly NodeExecutor[];

/**
 * The single mapping. `dispatch` is deliberately classed as `decision` and not
 * as `tool`: its COST is one cheap model call, and cost is what the canvas is
 * trying to communicate. That it ends in a tool call is shown by the tool name
 * on the node badge, and (in the web app) by a two-tone body.
 */
export const EXECUTOR_BY_NODE_TYPE: Record<GraphNodeType, NodeExecutor> = {
  fetch: 'program',
  redact: 'program',
  tool: 'tool',
  submit: 'tool',
  dispatch: 'decision',
  judge: 'decision',
  decide: 'model',
  agent_task: 'agent',
  // Sandboxed script. Classed `program` because the RUN is deterministic code; when the
  // source is generated that costs one `model` call first (TODO(code-node): surface it).
  code: 'program',
  approval: 'human',
  handoff: 'human',
  swarm: 'group',
};

export function executorOf(type: GraphNodeType): NodeExecutor {
  return EXECUTOR_BY_NODE_TYPE[type];
}

/** Rough model spend, for the legend and for sorting a cost view. */
export type ExecutorCost = 'none' | 'cheap' | 'moderate' | 'high';

export interface ExecutorStyle {
  /** Short noun for the node badge and the canvas legend. */
  label: string;
  icon: string;
  /** Tailwind colour family; the web app builds class names from it. */
  color: 'slate' | 'emerald' | 'amber' | 'violet' | 'zinc' | 'rose' | 'sky';
  /**
   * True when we cannot see inside the work. RENDER THIS AS A DASHED BORDER —
   * it is the most honest single mark on the canvas, and docs/archive/example_flow.md
   * already uses stroke-dasharray for exactly these boxes.
   */
  opaque: boolean;
  cost: ExecutorCost;
  /** One line for the legend and the node tooltip. */
  description: string;
}

export const EXECUTOR_STYLE: Record<NodeExecutor, ExecutorStyle> = {
  program: {
    label: 'Program',
    icon: '▤',
    color: 'slate',
    opaque: false,
    cost: 'none',
    description: 'Our own deterministic code. No model, no tokens.',
  },
  tool: {
    label: 'Tool',
    icon: '🔧',
    color: 'emerald',
    opaque: false,
    cost: 'none',
    description: 'A real external system. Costs no model tokens.',
  },
  decision: {
    label: 'Decision',
    icon: '⚙️',
    color: 'amber',
    opaque: false,
    cost: 'cheap',
    description: 'One cheap routing or classification call.',
  },
  model: {
    label: 'Model',
    icon: '◆',
    color: 'violet',
    opaque: false,
    cost: 'moderate',
    description: 'One text completion.',
  },
  agent: {
    label: 'Agent',
    icon: '🕶️',
    color: 'zinc',
    opaque: true,
    cost: 'high',
    description:
      'An agent harness running its own loop. We see the tool calls it reports, not the loop.',
  },
  human: {
    label: 'Human',
    icon: '🛑',
    color: 'rose',
    opaque: false,
    cost: 'none',
    description: 'Blocks until a person decides — or, for a handoff, until they act.',
  },
  group: {
    label: 'Swarm',
    icon: '⋯',
    color: 'sky',
    opaque: false,
    cost: 'moderate',
    description: 'Fans out into parallel workers.',
  },
};

export function styleOf(type: GraphNodeType): ExecutorStyle {
  return EXECUTOR_STYLE[executorOf(type)];
}

/**
 * Icon per NODE TYPE, for timelines that key off `Step.kind` rather than the
 * graph. Falls back to the executor icon, so adding a node type cannot leave a
 * blank square — the worst case is that it shares its family's mark.
 *
 * `worker` and `task` are step kinds with no node type: a swarm's children and
 * a bare ctx.step().
 */
export const NODE_TYPE_ICON: Record<GraphNodeType | 'worker' | 'task', string> = {
  fetch: '▤',
  redact: '◐',
  tool: '🔧',
  dispatch: '⚙️',
  decide: '◆',
  agent_task: '🕶️',
  code: '⌘',
  swarm: '⋯',
  judge: '⚖',
  submit: '↥',
  approval: '🛑',
  handoff: '⌨',
  worker: '•',
  task: '▸',
};
