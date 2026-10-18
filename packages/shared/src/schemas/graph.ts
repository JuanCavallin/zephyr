/**
 * The agent graph document — the editable form of a pipeline.
 *
 * ZOD IS THE SOURCE OF TRUTH HERE; the TypeScript types are inferred. Same
 * pattern as schemas/playbooks/demo.ts, and it is deliberate: this document
 * crosses an API boundary and is edited by a model (chat synthesis), so a
 * hand-written interface that drifts from the validator would be a silent
 * source of runtime failures. There is no separate graph.ts.
 *
 * A graph is executed by the interpreter, which maps each node type onto one
 * PlaybookContext primitive — see docs/archive/graph-workflow-plan.md. Node `type`
 * reuses the existing StepSpec.kind vocabulary so the icon map in the web app's
 * StepRow works on graph nodes with no extra mapping.
 *
 * RULE FOR EDITS: additive only, and new config fields are optional. The
 * interpreter is written against this file; a required field added later
 * invalidates every graph already saved to disk.
 */

import { z } from 'zod';
import type { Json } from '../domain.js';
import { PROVIDER_IDS } from '../providers.js';

/** Recursive Json validator, matching the `Json` type in domain.ts. */
const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

const argsSchema = z.record(z.string(), jsonSchema);

const modelTierSchema = z.enum(['cheap', 'standard', 'frontier']);

/**
 * Every node type, and whether a model is in the loop. The `llmCalls` metric in
 * analytics.ts is derived from reported tokens rather than from this list, so a
 * no-LLM node contributes zero automatically.
 *
 *   fetch      no      load a source
 *   tool       NO      one deterministic tool call, no model at all
 *   dispatch   cheap   decision layer picks ONE tool, then we call it directly
 *   redact     no      local PII detection
 *   decide     yes     text.model completion
 *   agent_task opaque  delegate a subtask to the agent runtime (Hermes)
 *   swarm      both    fan out N workers
 *   judge      yes     decision provider adjudicates
 *   submit     no      tool call BEHIND an approval gate (irreversible)
 *   approval   no      standalone human gate
 *   handoff    NO      a human acts DIRECTLY in the browser; the agent waits
 *
 * There is a deliberate THREE-RUNG LADDER of delegation here, and the middle
 * rung is the point:
 *
 *   tool      0 model calls    you pick the tool, you pick the args
 *   dispatch  1 cheap call     the decision layer picks the tool; no harness
 *   agent_task  many, opaque   the harness picks and runs everything
 *
 * Pushing work down to the cheapest rung that can do it is the product
 * argument, and `executorOf()` in executors.ts renders that ladder visually.
 */
export const GRAPH_NODE_TYPES = [
  'fetch',
  'tool',
  'dispatch',
  'redact',
  'decide',
  'agent_task',
  'swarm',
  'judge',
  'submit',
  'approval',
  'handoff',
] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const graphNodeTypeSchema = z.enum(GRAPH_NODE_TYPES);

/* -------------------------------------------------------------------------- */
/* Node config — one variant per type                                         */
/* -------------------------------------------------------------------------- */

const baseNode = {
  dataLabels: z.array(z.enum(['public', 'private', 'secret', 'local_only'])).optional(),
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  /**
   * Start the node and do not await it. Anything downstream that references its
   * output still awaits the underlying promise; nothing downstream means it
   * runs to completion alongside the rest of the graph.
   */
  background: z.boolean().optional(),
};

function nodeVariant<T extends GraphNodeType, C extends z.ZodTypeAny>(type: T, config: C) {
  return z.object({ ...baseNode, type: z.literal(type), config });
}

export const fetchNodeSchema = nodeVariant(
  'fetch',
  z.object({
    /** Opaque to the runtime; the interpreter decides how to resolve it. */
    source: z.string().min(1),
    /**
     * Literal content, when the graph itself carries the document rather than
     * naming somewhere to go and get it. Resolved for {{refs}} like any other
     * string, so it can also pull from a run variable.
     */
    text: z.string().optional(),
  }),
);

/**
 * A deterministic tool call with NO model in the loop. Distinct from `submit`
 * (same call, approval-gated because it is irreversible) and from `agent_task`
 * (a model picks the tools). Costs zero tokens, which is precisely the argument
 * for a graph over one large prompt.
 */
export const toolNodeSchema = nodeVariant(
  'tool',
  z.object({
    tool: z.string().min(1),
    args: argsSchema.default({}),
    /**
     * What this call DOES, in core/risk.ts's vocabulary ('read_page',
     * 'send_email', 'submit_form', ...). The risk gate classifies on this, so
     * a write-shaped tool still reaches the approval gate from a plain `tool`
     * node.
     *
     * TODO(person-3): remove this once the tool registry reports reversibility
     * per tool — see docs/tool-registry-handoff.md. Until then the interpreter
     * falls back to a small lookup table and, failing that, asks a human.
     */
    actionKind: z.string().min(1).optional(),
  }),
);

/**
 * THE MIDDLE RUNG: the decision layer picks one tool from a candidate set and
 * the interpreter calls it directly. No agent harness in the middle, so no
 * multi-turn model loop — one cheap decide plus one tool call.
 *
 * This is the "Direct tool call (no agent loop needed)" branch that already
 * appears in docs/archive/example_flow.md, hanging straight off the Jev node.
 *
 * Needs NO new provider capability: DecisionAdapter.decide({question, options})
 * already has exactly this shape, with `options` as the candidate tool names.
 */
export const dispatchNodeSchema = nodeVariant(
  'dispatch',
  z.object({
    /** Handed to the decision layer as the question. */
    goal: z.string().min(1),
    /** The decision layer picks exactly one of these. */
    candidateTools: z.array(z.string().min(1)).min(2),
    /**
     * Static args per candidate tool, keyed by tool name. The default mode,
     * and it costs ZERO extra tokens - the model chooses which tool, the graph
     * author already said what to pass it.
     */
    args: z.record(z.string(), argsSchema).default({}),
    /**
     * 'static' uses `args` above. 'model' spends one additional completion to
     * infer arguments - far more than static, still far less than handing the
     * whole job to a harness.
     */
    argsFrom: z.enum(['static', 'model']).default('static'),
    /** Only used when argsFrom is 'model'. Defaults to 'cheap', same as before. */
    argsModelTier: modelTierSchema.optional(),
    /** Only used when argsFrom is 'model'; has no effect on tool selection. */
    argsTemperature: z.number().min(0).max(1).optional(),
    evidence: z.string().optional(),
    /** See toolNodeSchema.actionKind. Applies to whichever tool is chosen. */
    actionKind: z.string().min(1).optional(),
  }),
);

export const redactNodeSchema = nodeVariant(
  'redact',
  z.object({
    /** Provenance label recorded on every PiiSpan this node produces. */
    field: z.string().min(1).default('input'),
    text: z.string().optional(),
  }),
);

export const decideNodeSchema = nodeVariant(
  'decide',
  z.object({
    prompt: z.string().min(1),
    system: z.string().optional(),
    tier: modelTierSchema.optional(),
    maxTokens: z.number().int().min(1).max(8192).optional(),
    temperature: z.number().min(0).max(1).optional(),
  }),
);

export const agentTaskNodeSchema = nodeVariant(
  'agent_task',
  z.object({
    goal: z.string().min(1),
    /**
     * The CANDIDATE list. The decision provider filters this down before the
     * harness starts — availableTools vs exposedTools is the headline number.
     * Never put an irreversible tool in here.
     */
    availableTools: z.array(z.string()).default([]),
    /** Hard capability ceiling, unlike discovery candidates. [] means no tools. */
    toolCeiling: z.array(z.string().min(1)).optional(),
    /** Hard server-side resources for this task; values are whole graph references. */
    resourceBindings: z
      .object({
        browserSession: z
          .string()
          .regex(/^\{\{\s*[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*\s*\}\}$/, {
            message: 'Browser resource bindings must be whole {{node.path}} references',
          })
          .optional(),
      })
      .optional(),
    /** Run-local mutable transcript identity. Omission creates an isolated task. */
    contextScope: z
      .object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/),
        mode: z.enum(['fresh', 'continue']),
      })
      .optional(),
    /** Explicit sensitivity can only tighten inherited context labels. */
    dataLabels: z.array(z.enum(['public', 'private', 'secret', 'local_only'])).optional(),
    /**
     * Explicit named inputs for this task, each a whole {{node.path}} or
     * {{input.path}} reference. Omitted: direct predecessor outputs only.
     * Empty object: no implicit context. This selects data, not permissions,
     * privacy labels, a shared transcript, or a browser resource owner.
     */
    contextInputs: z
      .record(
        z.string().min(1).max(64),
        z.string().regex(/^\{\{\s*[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*\s*\}\}$/, {
          message: 'Context inputs must be whole {{node.path}} or {{input.path}} references',
        }),
      )
      .optional(),
    /**
     * Which agent runtime to use. Validated against the provider vocabulary so
     * the abstraction is real, but the interpreter accepts only 'hermes' today.
     */
    harness: z.enum(PROVIDER_IDS).optional(),
    pollIntervalMs: z.number().int().min(100).max(60_000).optional(),
    maxPolls: z.number().int().min(1).max(2000).optional(),
    inactivityTimeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    maxDurationMs: z.number().int().min(1000).max(1_800_000).optional(),
    /**
     * Accepted so saved graphs keep validating, and ignored: an agent task is
     * one Hermes run, judged once by Jev, and never re-prompted for more turns.
     */
    maxTurns: z.number().int().min(1).max(20).optional(),
    maxFailedToolCalls: z.number().int().min(0).max(100).optional(),
  }),
);

export const swarmNodeSchema = nodeVariant(
  'swarm',
  z.object({
    items: z.array(z.string()).min(1),
    concurrency: z.number().int().min(1).max(16).optional(),
    workerPrompt: z.string().optional(),
    workerTool: z.string().optional(),
  }),
);

export const judgeNodeSchema = nodeVariant(
  'judge',
  z.object({
    question: z.string().min(1),
    /** Outgoing edges use `sourceHandle` to select the branch by option. */
    options: z.array(z.string().min(1)).min(2),
    evidence: z.string().optional(),
  }),
);

export const submitNodeSchema = nodeVariant(
  'submit',
  z.object({
    tool: z.string().min(1),
    args: argsSchema.default({}),
    /** Shown VERBATIM in the approval panel. Not summarised. */
    description: z.string().min(1),
    amountCents: z.number().int().optional(),
    /**
     * See toolNodeSchema.actionKind. A submit node stops for a human either
     * way; this only sharpens which rule the approval panel cites.
     */
    actionKind: z.string().min(1).optional(),
  }),
);

export const approvalNodeSchema = nodeVariant(
  'approval',
  z.object({
    description: z.string().min(1),
    amountCents: z.number().int().optional(),
  }),
);

/**
 * THE HUMAN DOES IT. Not "may the agent do this?" — "the agent must not".
 *
 * `approval` asks permission for an action the agent then performs. `submit`
 * asks permission for a payload the agent then sends. Neither expresses the
 * case this node exists for: a step that the agent must NEVER perform, because
 * performing it would mean the value passing through our process.
 *
 * Passwords, MFA codes, card numbers, a signature. For these the correct policy
 * is not a stricter gate — it is that a person acts directly on the page, in an
 * interactive live view, and the agent resumes afterwards on the same session.
 *
 * WHY NOTHING SENSITIVE CAN LEAK THROUGH THIS NODE, structurally:
 *   - there is no field here to put a secret IN. No `text`, no `args`.
 *   - the value goes keyboard -> remote page. It is never a {{ref}}, never a
 *     prompt, never a `Step.output` (which is streamed AND stored), and so it
 *     never reaches the egress ledger.
 *   - the ledger row for this span records that a HUMAN acted. "The model never
 *     saw the credential" becomes a fact you can read off the trace.
 *
 * THE RULE THAT MUST NOT BE RELAXED: a handoff is never satisfiable by the
 * agent. If a timeout here ever falls through to "let the agent try", this node
 * has become a security hole with a friendly name. `timeoutMs` FAILS the run.
 */
export const handoffNodeSchema = nodeVariant(
  'handoff',
  z.object({
    /**
     * Shown VERBATIM to the person, like an approval's description. Say what
     * to do and say that we cannot see it — the reassurance is the point.
     */
    instruction: z.string().min(1),
    /**
     * Where to park the browser. Omit and pass `sessionId` instead to take over
     * a session an upstream node already opened.
     */
    url: z.string().optional(),
    /**
     * Reuse an existing session, normally "{{open_portal.result.sessionId}}". When set,
     * this node does NOT open (or close) the session — whoever opened it owns it.
     */
    sessionId: z.string().optional(),
    /**
     * 'human_confirms' blocks until someone clicks Done — always available, and
     * the only mode that works without a live view. 'url_matches' additionally
     * resumes on its own once the page reaches `expectUrl`, so the happy path
     * costs no click.
     */
    resumeWhen: z.enum(['human_confirms', 'url_matches']).default('human_confirms'),
    /** Required by `resumeWhen: 'url_matches'`. Matched as a prefix. */
    expectUrl: z.string().optional(),
    /**
     * Give up waiting and FAIL the run. Never a fall-through to the agent —
     * see the rule above. Default 600_000 (10 minutes), which is a person
     * walking away, not a person reading.
     */
    timeoutMs: z.number().int().min(5_000).max(1_800_000).optional(),
  }),
);

export const graphNodeSchema = z.discriminatedUnion('type', [
  fetchNodeSchema,
  toolNodeSchema,
  dispatchNodeSchema,
  redactNodeSchema,
  decideNodeSchema,
  agentTaskNodeSchema,
  swarmNodeSchema,
  judgeNodeSchema,
  submitNodeSchema,
  approvalNodeSchema,
  handoffNodeSchema,
]);

export type GraphNode = z.infer<typeof graphNodeSchema>;

/* -------------------------------------------------------------------------- */
/* Edges, assertions, graph                                                   */
/* -------------------------------------------------------------------------- */

export const graphEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  source: z.string().min(1),
  target: z.string().min(1),
  /**
   * Which branch of a `judge` node this edge represents — one of that node's
   * `options`. Undefined means unconditional.
   */
  sourceHandle: z.string().optional(),
});

export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/**
 * A post-run check. Gives the baseline comparison a SUCCESS axis rather than
 * only a cost axis — without one, a single frontier prompt always "wins" on
 * tokens and latency and the dashboard argues against the product.
 */
export const graphAssertionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** Outcome checks grade every benchmark arm; pipeline checks describe orchestration only. */
  scope: z.enum(['outcome', 'pipeline']).optional(),
  /** Dot-path into the run result, e.g. "verdict" or "flaggedSources.0". */
  path: z.string().min(1),
  /** The value at `path`, stringified, must equal this. */
  expected: z.string(),
});

export type GraphAssertion = z.infer<typeof graphAssertionSchema>;

/**
 * Decisions frozen for a saved graph, so a run executes them instead of asking
 * Jev again. SERVER-OWNED: written by the compile step or learned from a run,
 * never taken from a client save. Every entry is only a cache — the runtime
 * reuses it when its node hash, decision-provider mode and exact tool set (ids
 * and versions) still match, and otherwise asks Jev as if it were absent.
 */
const compiledToolVersionsSchema = z.record(z.string(), z.string());

export const compiledAgentRouteSchema = z.object({
  kind: z.literal('agent_route'),
  nodeHash: z.string(),
  decisionMode: z.string(),
  /** The candidate set the route was decided over: tool id -> descriptor version. */
  tools: compiledToolVersionsSchema,
  privacy: z.enum(['cloud', 'private']),
  intelligence: z.enum(['low', 'high']),
  privacyConfidence: z.number(),
  intelligenceConfidence: z.number(),
  modelTier: z.enum(['local', 'cheap', 'standard', 'frontier']),
  exposedTools: z.array(z.string()),
  confidence: z.number(),
  rationale: z.string().optional(),
  source: z.enum(['compile', 'run']),
  at: z.string(),
});

export const compiledDispatchSchema = z.object({
  kind: z.literal('dispatch'),
  nodeHash: z.string(),
  decisionMode: z.string(),
  /** The registered options the choice was made among, in order. */
  options: z.array(z.string()),
  choice: z.string(),
  confidence: z.number(),
  source: z.enum(['compile', 'run']),
  at: z.string(),
});

export const compiledNodeDecisionSchema = z.discriminatedUnion('kind', [
  compiledAgentRouteSchema,
  compiledDispatchSchema,
]);

export const compiledGraphDecisionsSchema = z.object({
  protocol: z.literal('agentos-graph-compile-v1'),
  nodes: z.record(z.string(), compiledNodeDecisionSchema).default({}),
});

export type CompiledAgentRoute = z.infer<typeof compiledAgentRouteSchema>;
export type CompiledDispatch = z.infer<typeof compiledDispatchSchema>;
export type CompiledNodeDecision = z.infer<typeof compiledNodeDecisionSchema>;
export type CompiledGraphDecisions = z.infer<typeof compiledGraphDecisionsSchema>;

/**
 * Returns the node ids forming a cycle, or null when the graph is acyclic.
 * Exported because the interpreter and the editor both need this answer, and a
 * cycle must never reach the executor: it awaits a promise map, so a cycle is a
 * permanent hang rather than an error.
 */
export function findGraphCycle(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
): string[] | null {
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node.id, []);
  for (const edge of edges) out.get(edge.source)?.push(edge.target);

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const seen = state.get(id);
    if (seen === 'done') return null;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, 'visiting');
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  }

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * All transitive data predecessors, excluding the node itself. Edges, not
 * completion timing, define which node results may enter its reference scope.
 * The visited set also keeps inspection of invalid cyclic drafts bounded.
 */
export function graphAncestorIds(
  nodeId: string,
  edges: { source: string; target: string }[],
): Set<string> {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    const incoming = parents.get(edge.target) ?? [];
    incoming.push(edge.source);
    parents.set(edge.target, incoming);
  }
  const visited = new Set([nodeId]);
  const ancestors = new Set<string>();
  const pending = [...(parents.get(nodeId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    ancestors.add(id);
    pending.push(...(parents.get(id) ?? []));
  }
  return ancestors;
}

export const agentGraphSchema = z
  .object({
    /** Labels on run inputs; derived nodes may tighten but never remove them. */
    dataLabels: z.array(z.enum(['public', 'private', 'secret', 'local_only'])).optional(),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    nodes: z.array(graphNodeSchema).default([]),
    edges: z.array(graphEdgeSchema).default([]),
    /** Bumped on every save. Powers optimistic concurrency once routes exist. */
    version: z.number().int().min(1).default(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    assertions: z.array(graphAssertionSchema).optional(),
    /** Server-owned frozen Jev decisions; see compiledGraphDecisionsSchema. */
    compiled: compiledGraphDecisionsSchema.optional(),
  })
  .superRefine((graph, ctx) => {
    const assertionIds = new Set<string>();
    for (const [index, assertion] of (graph.assertions ?? []).entries()) {
      if (assertionIds.has(assertion.id))
        ctx.addIssue({
          code: 'custom',
          path: ['assertions', index, 'id'],
          message: 'Duplicate assertion id "' + assertion.id + '"',
        });
      assertionIds.add(assertion.id);
    }
    // The interpreter assumes all three of these hold. Enforce them at the
    // boundary so a malformed graph is a 400, never a hung run.
    const ids = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: 'Duplicate node id "' + node.id + '"',
        });
      }
      ids.add(node.id);
    }

    const edgeIds = new Set<string>();
    for (const [index, edge] of graph.edges.entries()) {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', index, 'id'],
          message: 'Duplicate edge id "' + edge.id + '"',
        });
      }
      edgeIds.add(edge.id);

      for (const end of ['source', 'target'] as const) {
        if (!ids.has(edge[end])) {
          ctx.addIssue({
            code: 'custom',
            path: ['edges', index, end],
            message: 'Edge ' + end + ' "' + edge[end] + '" references a node that does not exist',
          });
        }
      }
    }

    const cycle = findGraphCycle(graph.nodes, graph.edges);
    if (cycle) {
      ctx.addIssue({
        code: 'custom',
        path: ['edges'],
        message: 'Graph contains a cycle: ' + cycle.join(' -> '),
      });
    }

    for (const [index, node] of graph.nodes.entries()) {
      if (node.type === 'agent_task' && node.config.contextScope) {
        const scope = node.config.contextScope;
        const peers = graph.nodes.filter(
          (other) => other.type === 'agent_task' && other.config.contextScope?.id === scope.id,
        );
        const ancestors = graphAncestorIds(node.id, graph.edges);
        const creators = peers.filter(
          (other) => other.type === 'agent_task' && other.config.contextScope?.mode === 'fresh',
        );
        if (
          creators.length !== 1 ||
          (scope.mode === 'continue' && !ancestors.has(creators[0]!.id)) ||
          peers.some(
            (other) =>
              other.id !== node.id &&
              !ancestors.has(other.id) &&
              !graphAncestorIds(other.id, graph.edges).has(node.id),
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'config', 'contextScope'],
            message:
              'A context scope requires one fresh owner followed by an ordered chain of continuations.',
          });
        }
      }
      if (node.type !== 'agent_task' || node.config.contextInputs === undefined) continue;
      const ancestors = graphAncestorIds(node.id, graph.edges);
      for (const [name, reference] of Object.entries(node.config.contextInputs)) {
        const root = reference.slice(2, -2).trim().split('.')[0] as string;
        if (root === 'input' || ancestors.has(root)) continue;
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'config', 'contextInputs', name],
          message:
            'Context input must reference a run input or an upstream node connected by edges: ' +
            root,
        });
      }
    }
  });

export type AgentGraph = z.infer<typeof agentGraphSchema>;
