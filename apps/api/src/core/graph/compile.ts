/**
 * THE COMPILE STEP: freeze the Jev decisions a saved graph can make once.
 *
 * A graph run asks Jev two kinds of question that do not depend on what the
 * run discovers:
 *
 *   agent_task  which of the node's candidate tools to expose, and which model
 *               tier to run on (one `route` call)
 *   dispatch    which candidate tool fits a goal written without {{refs}}
 *               (one `decide` call)
 *
 * Both are answered here, when the graph is saved, and stored on the graph as
 * `compiled`. A run reuses an entry only while it still describes the node:
 * same node hash, same decision-provider mode, same exact tool set (ids AND
 * versions). Anything else and the run asks Jev, exactly as before, and records
 * what it learned for the next run.
 *
 * What is deliberately NOT compiled: judge verdicts, completion verdicts,
 * browser targets and dispatch goals with {{refs}}. Those judge evidence the
 * run itself produces; freezing them would turn a decision into a guess.
 *
 * Privacy: only nodes whose labels are all public are compiled, so the only
 * text Jev sees is the author's own node goal — never run inputs.
 */

import { createHash } from 'node:crypto';
import type {
  AgentGraph,
  CompiledAgentRoute,
  CompiledDispatch,
  CompiledGraphDecisions,
  CompiledNodeDecision,
  DecisionAdapter,
  GraphNode,
  ProviderCallContext,
  ToolDescriptor,
} from '@htn/shared';
import { eligibleTaskTools, mockTwinsOfLiveTools } from '../tools/taskEligibility.js';

export const COMPILE_PROTOCOL = 'agentos-graph-compile-v1' as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

/** Identity of what a node asks: its type, config and labels. Position and label are cosmetic. */
export function nodeHash(node: GraphNode): string {
  return createHash('sha256')
    .update(canonical({ type: node.type, config: node.config, dataLabels: node.dataLabels }))
    .digest('hex');
}

/** A dispatch whose question and evidence are fixed text, so its answer cannot change per run. */
export function isStaticDispatch(node: Extract<GraphNode, { type: 'dispatch' }>): boolean {
  return !node.config.goal.includes('{{') && !(node.config.evidence ?? '').includes('{{');
}

export function toolVersions(descriptors: readonly ToolDescriptor[]): Record<string, string> {
  return Object.fromEntries(
    [...descriptors]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((descriptor) => [descriptor.id, descriptor.version]),
  );
}

function sameVersions(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** The frozen route for this node, or undefined when anything it was decided over changed. */
export function usableAgentRoute(
  entry: CompiledNodeDecision | undefined,
  expected: { nodeHash: string; decisionMode: string; tools: Record<string, string> },
): CompiledAgentRoute | undefined {
  if (entry?.kind !== 'agent_route') return undefined;
  if (entry.nodeHash !== expected.nodeHash || entry.decisionMode !== expected.decisionMode)
    return undefined;
  if (!sameVersions(entry.tools, expected.tools)) return undefined;
  // Never widen: a frozen grant can only name tools from the set it was decided over.
  if (entry.exposedTools.some((id) => !Object.hasOwn(expected.tools, id))) return undefined;
  return entry;
}

export function usableDispatch(
  entry: CompiledNodeDecision | undefined,
  expected: { nodeHash: string; decisionMode: string; options: readonly string[] },
): CompiledDispatch | undefined {
  if (entry?.kind !== 'dispatch') return undefined;
  if (entry.nodeHash !== expected.nodeHash || entry.decisionMode !== expected.decisionMode)
    return undefined;
  if (
    entry.options.length !== expected.options.length ||
    entry.options.some((id, index) => expected.options[index] !== id) ||
    !expected.options.includes(entry.choice)
  )
    return undefined;
  return entry;
}

/** Entries whose node still exists unchanged; everything else is dropped. */
export function prunedCompiled(
  compiled: CompiledGraphDecisions | undefined,
  graph: AgentGraph,
): CompiledGraphDecisions | undefined {
  if (!compiled) return undefined;
  const nodes = Object.fromEntries(
    Object.entries(compiled.nodes).filter(([nodeId, entry]) => {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      return (
        node !== undefined &&
        node.type === entryNodeType(entry) &&
        nodeHash(node) === entry.nodeHash
      );
    }),
  );
  return Object.keys(nodes).length > 0 ? { protocol: COMPILE_PROTOCOL, nodes } : undefined;
}

function entryNodeType(entry: CompiledNodeDecision): GraphNode['type'] {
  return entry.kind === 'agent_route' ? 'agent_task' : 'dispatch';
}

export interface CompileDeps {
  decider: DecisionAdapter;
  /** Registry lookup; unknown ids are dropped, as at run time. */
  resolveTools(ids: string[]): Promise<ToolDescriptor[]>;
  /** The same extra candidates the orchestrator adds to every agent task. */
  localToolCandidates?: () => Promise<string[]>;
  now(): string;
  signal?: AbortSignal;
}

/** The candidate set an agent node would be routed over, computed as the runtime does. */
export async function agentCandidateTools(
  node: Extract<GraphNode, { type: 'agent_task' }>,
  deps: Pick<CompileDeps, 'resolveTools' | 'localToolCandidates'>,
): Promise<ToolDescriptor[]> {
  const labels = node.config.dataLabels ?? ['public'];
  const local = deps.localToolCandidates ? await deps.localToolCandidates() : [];
  let ids = [...new Set([...node.config.availableTools, ...local])];
  const ceiling = node.config.toolCeiling;
  if (ceiling !== undefined) ids = ids.filter((id) => ceiling.includes(id));
  const eligible = eligibleTaskTools(await deps.resolveTools(ids), {
    taskSummary: node.config.goal,
    dataLabels: labels,
    sanitizedForRemote: true,
  });
  const twins = mockTwinsOfLiveTools(eligible);
  return eligible.filter((descriptor) => !twins.includes(descriptor));
}

function compilable(node: GraphNode): boolean {
  const labels = [
    ...(node.dataLabels ?? []),
    ...(node.type === 'agent_task' ? (node.config.dataLabels ?? []) : []),
  ];
  return labels.every((label) => label === 'public');
}

/**
 * Compile every node that lacks a usable entry. Best effort: a Jev failure for
 * one node leaves it uncompiled (the run asks Jev), it never fails the save.
 */
export async function compileGraph(
  graph: AgentGraph,
  deps: CompileDeps,
): Promise<CompiledGraphDecisions | undefined> {
  const existing = prunedCompiled(graph.compiled, graph)?.nodes ?? {};
  const nodes: Record<string, CompiledNodeDecision> = { ...existing };
  const decisionMode = deps.decider.mode;
  const ctx = (nodeId: string): ProviderCallContext => ({
    runId: 'compile:' + graph.id,
    stepId: nodeId,
    policyRule: 'graph-compile',
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  for (const node of graph.nodes) {
    if (!compilable(node)) continue;
    const hash = nodeHash(node);
    if (node.type === 'agent_task') {
      if (node.config.harness && node.config.harness !== 'hermes') continue;
      const candidates = await agentCandidateTools(node, deps);
      if (candidates.length === 0) continue;
      const tools = toolVersions(candidates);
      if (usableAgentRoute(existing[node.id], { nodeHash: hash, decisionMode, tools })) continue;
      const routed = await deps.decider
        .route({ task: node.config.goal, availableTools: Object.keys(tools) }, ctx(node.id))
        .catch(() => null);
      if (!routed?.ok) continue;
      nodes[node.id] = {
        kind: 'agent_route',
        nodeHash: hash,
        decisionMode,
        tools,
        privacy: routed.data.privacy,
        intelligence: routed.data.intelligence,
        privacyConfidence: routed.data.privacyConfidence,
        intelligenceConfidence: routed.data.intelligenceConfidence,
        modelTier: routed.data.modelTier,
        exposedTools: routed.data.exposedTools.filter((id) => Object.hasOwn(tools, id)),
        confidence: routed.data.confidence,
        ...(routed.data.rationale ? { rationale: routed.data.rationale } : {}),
        source: 'compile',
        at: deps.now(),
      };
    } else if (node.type === 'dispatch' && isStaticDispatch(node)) {
      const registered = (await deps.resolveTools(node.config.candidateTools))
        .filter((descriptor) => descriptor.availability === 'available')
        .map((descriptor) => descriptor.id);
      // Same rule as runDispatch/registeredToolIds: the author's order, only
      // executable tools, and an empty match keeps the author's whole list.
      const options = node.config.candidateTools.filter((id) =>
        registered.length > 0 ? registered.includes(id) : true,
      );
      if (usableDispatch(existing[node.id], { nodeHash: hash, decisionMode, options })) continue;
      const decided = await deps.decider
        .decide(
          { question: node.config.goal, options, evidence: node.config.evidence },
          ctx(node.id),
        )
        .catch(() => null);
      if (!decided?.ok || !options.includes(decided.data.choice)) continue;
      nodes[node.id] = {
        kind: 'dispatch',
        nodeHash: hash,
        decisionMode,
        options,
        choice: decided.data.choice,
        confidence: decided.data.confidence,
        source: 'compile',
        at: deps.now(),
      };
    }
  }
  return Object.keys(nodes).length > 0 ? { protocol: COMPILE_PROTOCOL, nodes } : undefined;
}
