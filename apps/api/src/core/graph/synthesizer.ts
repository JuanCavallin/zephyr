/**
 * Turn a request into a graph.
 *
 * Three things about this file are deliberate:
 *
 * 1. It goes through the `text.model` CAPABILITY, never an SDK. Synthesis works
 *    in mock mode with no keys, and the same code path serves live.
 *
 * 2. It runs OUTSIDE a run, but every outbound call is still logged. The
 *    conversation id is the ledger key (conv_...), so a synthesis call appears
 *    in the egress ledger like any other -- which matters, because a graph's
 *    true cost includes the call that produced it.
 *
 * 3. Schema/structure validation is independent of delegation. A straightforward
 *    graph needs no dispatch or agent_task. Delegation counts describe the plan;
 *    they do not force an extra model call or a harness loop.
 *
 * Dependencies are injected so regressions exercise the real repair/admission
 * loop offline, without initializing a runtime, store, or live provider.
 */

import {
  agentGraphSchema,
  delegationOf,
  type AgentGraph,
  type DecisionAdapter,
  type GraphDelegation,
  type TextModelAdapter,
} from '@htn/shared';
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  type ToolCatalogEntry,
} from './synthesisPrompt.js';
import { newId, nowIso } from '../../lib/ids.js';
import { unknownGraphTools } from './preflight.js';

export interface SynthesisDependencies {
  listTools(conversationId: string): Promise<ToolCatalogEntry[]>;
  complete: TextModelAdapter['complete'];
  /** Optional Jev preflight; Jev selects a mode but never writes graph content. */
  decide?: DecisionAdapter['decide'];
}

export interface SynthesisRequest {
  conversationId: string;
  request: string;
  currentGraph: AgentGraph | null;
  /** Set by the cheap Jev preflight; callers may provide a deterministic hint in tests. */
  modeHint?: 'direct' | 'dispatch' | 'adaptive';
}

export class SynthesisError extends Error {
  readonly code = 'SYNTHESIS_FAILED';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SynthesisError';
  }
}

function debug(...args: unknown[]): void {
  console.log('[synthesis]', ...args);
}

function preview(text: string, n = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

export interface SynthesisResult {
  graph: AgentGraph;
  delegation: GraphDelegation;
  /** One line for the chat transcript. */
  message: string;
  attempts: number;
}

/** Models like to wrap JSON in a fence even when told not to. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return body.trim();
  return body.slice(start, end + 1);
}

export async function synthesiseGraph(
  args: SynthesisRequest,
  deps: SynthesisDependencies,
): Promise<SynthesisResult> {
  const startedAt = Date.now();
  debug(
    args.conversationId,
    args.currentGraph
      ? 'EDIT of ' + args.currentGraph.id + ' v' + args.currentGraph.version
      : 'BUILD new',
    '| request:',
    preview(args.request, 150),
  );

  // A synthesiser with no catalog would invent tool names, and every one of
  // them would fail classification at run time. listToolCatalog degrades to
  // the registry half rather than throwing, so an empty list here means the
  // registry itself is empty -- worth seeing in the log.
  const tools = await deps.listTools(args.conversationId);
  debug(
    args.conversationId,
    'tool catalog:',
    tools.length,
    'tool(s)',
    tools.length === 0 ? '(empty -- synthesis will avoid naming tools)' : '',
  );

  const modeHint = args.modeHint ?? (await chooseSynthesisMode(args, tools, deps));
  debug(args.conversationId, 'preflight mode:', modeHint);

  const system = buildSynthesisSystemPrompt(tools, modeHint);

  let repairHint: string | undefined;

  // Two attempts: one to write it, one to repair it against the real error.
  // More than that and the model is usually failing at the task, not the format.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const callStarted = Date.now();
    const completion = await deps.complete(
      {
        system,
        prompt: buildSynthesisUserPrompt({
          request: args.request,
          currentGraph: args.currentGraph,
          modeHint,
          repairHint,
        }),
        // Simple direct plans do not need the frontier route. Adaptive plans
        // retain the larger budget because subagent goals and bounds need detail.
        tier: modeHint === 'direct' ? 'standard' : 'frontier',
        // Thinking-capable models spend part of this budget before emitting any
        // JSON: a 3072 cap produced ~1.5-3k chars cut off mid-document.
        maxTokens: modeHint === 'direct' ? 8192 : 12288,
        json: true,
      },
      {
        runId: args.conversationId,
        policyRule: 'graph-synthesis',
      },
    );

    if (!completion.ok) {
      debug(
        args.conversationId,
        'attempt',
        attempt,
        'FAILED: model call error',
        completion.error.code + ':',
        completion.error.message,
        '(' + (Date.now() - callStarted) + 'ms)',
      );
      throw new SynthesisError('Model call failed: ' + completion.error.message);
    }

    debug(
      args.conversationId,
      'attempt',
      attempt,
      'model replied in',
      Date.now() - callStarted,
      'ms |',
      completion.data.tokensIn,
      'in /',
      completion.data.tokensOut,
      'out |',
      completion.data.text.length,
      'chars',
    );

    const at = nowIso();
    let candidate: unknown;
    try {
      candidate = JSON.parse(extractJson(completion.data.text));
    } catch (err) {
      debug(
        args.conversationId,
        'attempt',
        attempt,
        'REJECTED: not valid JSON:',
        (err as Error).message,
        '\n  raw reply:',
        preview(completion.data.text),
      );
      // tokensOut at the cap means the reply was cut off, not malformed.
      const cap = modeHint === 'direct' ? 8192 : 12288;
      repairHint =
        completion.data.tokensOut >= cap
          ? 'Your reply was cut off before the JSON ended. Return a shorter document: fewer nodes, terse labels, no prose.'
          : 'Your reply was not valid JSON. Return ONLY the JSON object.';
      continue;
    }

    const draft = {
      ...(candidate as Record<string, unknown>),
      // Identity and versioning belong to us, not to the model. Reusing the
      // current id keeps an edit an edit rather than a fork.
      id: args.currentGraph?.id ?? newId('graph'),
      version: 1,
      createdAt: args.currentGraph?.createdAt ?? at,
      updatedAt: at,
    };

    const parsed = agentGraphSchema.safeParse(draft);
    if (!parsed.success) {
      const draftNodes = (draft as { nodes?: unknown }).nodes;
      const nodes = Array.isArray(draftNodes) ? (draftNodes as { type?: string }[]) : [];
      const lines = parsed.error.issues.slice(0, 8).map((issue) => {
        // Cross-reference back to the offending node's TYPE, not just its
        // index -- "nodes.3.config.question" tells you a path; "node[3]
        // (type=judge)" tells you what actually needs fixing.
        const nodeIndex =
          issue.path[0] === 'nodes' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
        const nodeType = nodeIndex !== null ? nodes[nodeIndex]?.type : undefined;
        const where = nodeType
          ? issue.path.join('.') + ' (node type=' + nodeType + ')'
          : issue.path.join('.');
        return '- ' + where + ': ' + issue.message;
      });
      debug(
        args.conversationId,
        'attempt',
        attempt,
        'REJECTED: failed schema validation (' + parsed.error.issues.length + ' issue(s)):\n ',
        lines.join('\n  '),
      );
      repairHint = 'The document failed validation:\n' + lines.join('\n');
      continue;
    }

    // Empty canvases are valid editor documents, but not completed synthesis.
    // The former delegation quota rejected these incidentally; retain the useful
    // check without demanding an unnecessary dispatch or harness task.
    if (parsed.data.nodes.length === 0) {
      repairHint =
        'The workflow has no nodes. Include at least one step that performs the requested work; dispatch and agent_task are not required.';
      debug(args.conversationId, 'attempt', attempt, 'REJECTED: empty workflow');
      continue;
    }

    const unknownTools = unknownGraphTools(parsed.data, new Set(tools.map((tool) => tool.name)));
    if (unknownTools.length > 0) {
      repairHint =
        'The graph named tool ids that are not in the current trusted catalog: ' +
        unknownTools.join(', ') +
        '. Use only the exact catalog ids shown in the system prompt, or remove the tool node.';
      debug(args.conversationId, 'attempt', attempt, 'REJECTED: unknown tool ids', unknownTools);
      continue;
    }

    const graph = withPreservedPositions(parsed.data, args.currentGraph);

    // Delegation is descriptive telemetry, never a minimum quota for admission.
    const delegation = delegationOf(graph);
    debug(
      args.conversationId,
      'attempt',
      attempt,
      'ACCEPTED |',
      graph.nodes.length,
      'nodes |',
      delegation.pinnedCalls,
      'pinned,',
      delegation.deferredToolChoices,
      'dispatch,',
      delegation.agentSubtasks,
      'agent |',
      'total',
      Date.now() - startedAt,
      'ms',
    );

    return {
      graph,
      delegation,
      message: describe(graph, delegation, args.currentGraph !== null),
      attempts: attempt,
    };
  }

  debug(
    args.conversationId,
    'FAILED after 2 attempts (' + (Date.now() - startedAt) + 'ms). Last repair hint:\n ',
    repairHint,
  );
  throw new SynthesisError('Could not produce a valid graph in two attempts', { repairHint });
}

async function chooseSynthesisMode(
  args: SynthesisRequest,
  tools: ToolCatalogEntry[],
  deps: SynthesisDependencies,
): Promise<'direct' | 'dispatch' | 'adaptive'> {
  const text = args.request.toLowerCase();
  const adaptiveSignal = /adapt|investigat|research|browse|sign[ -]?in|login|compare|follow|if .*then|until|figure out|agent|observe|iterate/.test(
    text,
  );
  const dispatchSignal = /choose|select|either|one of|route|best (?:tool|option)|depending/.test(text);
  const deterministic = adaptiveSignal ? 'adaptive' : dispatchSignal ? 'dispatch' : 'direct';
  if (!deps.decide || tools.length === 0) return deterministic;

  try {
    const result = await deps.decide(
      {
        question:
          'Which execution shape best fits this workflow request? Choose direct for known fixed steps, dispatch for a runtime choice among known tools, or adaptive for an observe-reason-act loop.',
        options: ['direct', 'dispatch', 'adaptive'],
        evidence:
          'Request: ' + args.request.slice(0, 1200) + '\nCatalog: ' + tools.map((tool) => tool.name).join(', '),
      },
      { runId: args.conversationId, policyRule: 'graph-synthesis-preflight' },
    );
    if (result.ok && ['direct', 'dispatch', 'adaptive'].includes(result.data.choice)) {
      return result.data.choice as 'direct' | 'dispatch' | 'adaptive';
    }
  } catch (error) {
    debug(args.conversationId, 'preflight unavailable; deterministic hint:', String(error));
  }
  return deterministic;
}

/**
 * A node that survived an edit keeps its position, so a conversational tweak
 * does not scatter the canvas. Only genuinely new nodes get the model's layout.
 */
function withPreservedPositions(graph: AgentGraph, previous: AgentGraph | null): AgentGraph {
  if (!previous) return graph;
  const before = new Map(previous.nodes.map((n) => [n.id, n.position]));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const kept = before.get(node.id);
      return kept ? { ...node, position: kept } : node;
    }),
  };
}

function describe(graph: AgentGraph, delegation: GraphDelegation, edited: boolean): string {
  const parts = [
    (edited ? 'Updated' : 'Built') + ' "' + graph.name + '": ' + graph.nodes.length + ' nodes.',
  ];

  if (delegation.deferredToolChoices > 0) {
    parts.push(
      delegation.deferredToolChoices +
        ' tool choice(s) left to the decision layer at runtime, from ' +
        delegation.candidateTools +
        ' candidates.',
    );
  }
  if (delegation.agentSubtasks > 0) {
    parts.push(delegation.agentSubtasks + ' subtask(s) delegated to the agent harness.');
  }
  if (delegation.pinnedCalls > 0) {
    parts.push(delegation.pinnedCalls + ' direct tool call(s).');
  }

  return parts.join(' ');
}
