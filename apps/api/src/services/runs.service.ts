/**
 * Run use-cases. The transaction boundary between HTTP and the orchestrator.
 *
 * Key behaviour: createRun persists, emits, and returns IMMEDIATELY. Execution is
 * fire-and-forget; progress reaches the browser over SSE. A route handler must
 * never await a run.
 */

import type {
  AgentGraph,
  AgentSessionState,
  Approval,
  EgressEvent,
  Json,
  PiiSpan,
  Run,
  ScheduleDecision,
  Step,
  StoredEvent,
  ToolLifecycleEvent,
} from '@htn/shared';
import { isTerminal, stripPiiValue, type BaselineInput } from '@htn/shared';
import { buildBenchmarkExperiment } from '../core/playbooks/baselineTask.js';
import { config } from '../config.js';
import {
  pauseHeldSince,
  pauseRun as gatePauseRun,
  resumeRun as gateResumeRun,
} from '../core/pauseGate.js';
import { getPlaybook, listPlaybooks } from '../core/playbooks/registry.js';
import { GraphNotFoundError } from './graphs.service.js';
import { listToolCatalog } from './toolCatalog.js';
import { formatPreflightIssues, graphPreflightIssues } from '../core/graph/preflight.js';
import { newId, nowIso } from '../lib/ids.js';
import type { ListRunsFilter } from '../store/types.js';
import { bus, orchestrator, store, toolRegistry } from './runtime.js';
import { browserControlStatesForRun } from '../providers/withBrowserOwnership.js';
import { credentials } from './credentials.js';

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Re-check a SAVED graph against the current schema, tool catalog and ref
 * rules before it runs. Graphs are validated when authored, but can go stale
 * as the code changes; without this a stale graph failed mid-run, sometimes
 * after a paid browser session was already open. Only issues certain to break
 * the run block it; warnings are logged and the run proceeds.
 */
async function assertGraphRunnable(graph: AgentGraph): Promise<void> {
  let catalog: Set<string> | null = null;
  try {
    catalog = new Set((await listToolCatalog('sys_graph_preflight')).map((tool) => tool.name));
  } catch {
    // An unreadable catalog must not block every run; the tool check is skipped.
  }
  const issues = graphPreflightIssues(graph, catalog);
  const blocking = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  if (warnings.length > 0) {
    console.warn('[graph-preflight] ' + graph.id + ': ' + formatPreflightIssues(warnings));
  }
  if (blocking.length > 0) {
    throw new ValidationError(
      'Graph "' +
        graph.name +
        '" cannot run against the current code: ' +
        formatPreflightIssues(blocking),
      { issues: blocking },
    );
  }
}

export interface RunDetail {
  toolLifecycle: ToolLifecycleEvent[];
  run: Run;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  /** Values are stripped — the client only ever sees placeholders and classes. */
  piiSpans: PiiSpan[];
  scheduleDecisions: ScheduleDecision[];
  agentSessions: AgentSessionState[];
}

export function availablePlaybooks(): { kind: string; title: string }[] {
  return listPlaybooks();
}

export async function createRun(args: {
  kind: string;
  input: unknown;
  title?: string;
  principalId?: string;
}): Promise<Run> {
  const playbook = getPlaybook(args.kind);
  if (!playbook) {
    throw new ValidationError('Unknown playbook kind "' + args.kind + '"', {
      available: listPlaybooks().map((p) => p.kind),
    });
  }

  // Validate against the playbook's own schema here, so a bad request is a 400
  // rather than a run that fails a second later.
  const parsed = playbook.inputSchema.safeParse(args.input ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid input for playbook "' + args.kind + '"', {
      issues: parsed.error.issues,
    });
  }

  // A graph run SNAPSHOTS the document it is about to execute. Without this,
  // editing a graph would retroactively change what an already-finished run
  // page shows -- the steps would no longer line up with the nodes.
  let input = parsed.data as Json;
  if (args.kind === 'graph') {
    const requested = input as { graphId: string; graphSnapshot?: unknown };
    const graph = await store.getGraph(requested.graphId);
    if (!graph) throw new GraphNotFoundError(requested.graphId);
    await assertGraphRunnable(graph);
    const experiment = await experimentForGraph(
      graph,
      (requested as { variables?: Record<string, unknown> }).variables ?? {},
    );
    input = {
      ...requested,
      graphSnapshot: graph,
      benchmarkExperiment: experiment.experiment,
    } as unknown as Json;
  }
  let baselineGraphName: string | undefined;
  if (args.kind === 'baseline' || args.kind === 'baseline_agent') {
    const resolved = await resolveBaselineInput(parsed.data as BaselineInput);
    input = resolved.input as unknown as Json;
    baselineGraphName = resolved.graphName;
  }

  const at = nowIso();
  const parsedObject =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  const graphId = typeof parsedObject?.graphId === 'string' ? parsedObject.graphId : undefined;
  const run: Run = {
    id: newId('run'),
    kind: args.kind,
    title:
      args.title ??
      (args.kind === 'graph'
        ? playbookTitleFor(input)
        : baselineGraphName
          ? playbook.title + ': ' + baselineGraphName
          : playbook.title),
    status: 'pending',
    input,
    ...(graphId ? { graphId } : {}),
    createdAt: at,
    updatedAt: at,
  };

  credentials.bindRun(run.id, args.principalId);
  await store.createRun(run);
  await bus.emit(run.id, { type: 'run.updated', run });

  // Fire and forget. Do NOT await.
  orchestrator.start(run);

  return run;
}

/**
 * Give a baseline THE GRAPH'S TASK, snapshotted at creation like a graph run
 * snapshots its graph: the chat request that built the graph, the run's
 * variables, and the graph's inline source text, plus the assertions and
 * answer fields it will be judged by. See core/playbooks/baselineTask.ts.
 */
async function resolveBaselineInput(
  requested: BaselineInput,
): Promise<{ input: BaselineInput; graphName?: string }> {
  if (!requested.graphId) {
    // Older callers sent only `target`, which is the demo graph's one variable.
    const variables =
      Object.keys(requested.variables).length > 0
        ? requested.variables
        : { target: requested.target };
    return { input: { ...requested, variables, promptSource: 'legacy_case_file' } };
  }
  // Exactly the graph run's variables, even none: inventing `target` here would
  // change the inputs hash, and the baseline could never pair with its graph run.
  const variables = requested.variables;
  const graph = await store.getGraph(requested.graphId);
  if (!graph) throw new GraphNotFoundError(requested.graphId);
  const { task, experiment } = await experimentForGraph(graph, variables);
  return {
    input: {
      ...requested,
      variables,
      ...task,
      benchmarkExperiment: experiment,
      outcomeAssertions: experiment.outcomeAssertions,
      graphVersion: graph.version,
      ...(graph.assertions ? { assertions: graph.assertions } : {}),
    },
    graphName: graph.name,
  };
}

async function experimentForGraph(graph: AgentGraph, variables: Record<string, unknown>) {
  const requests = (await store.listConversations())
    .filter((conversation) => conversation.graphId === graph.id)
    .flatMap((conversation) => conversation.messages)
    .filter((message) => message.role === 'user')
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((message) => message.text);
  const tools = (await toolRegistry.list()).filter(
    (tool) => tool.descriptor.availability === 'available' && !tool.descriptor.simulated,
  );
  const named = new Set<string>();
  for (const node of graph.nodes) {
    const cfg = node.config as Record<string, unknown>;
    if (typeof cfg.tool === 'string') named.add(cfg.tool);
    for (const key of ['availableTools', 'candidateTools'])
      if (Array.isArray(cfg[key]))
        for (const id of cfg[key]) if (typeof id === 'string') named.add(id);
  }
  const toolIds = tools
    .filter((tool) => named.size === 0 || named.has(tool.descriptor.id))
    .map((tool) => tool.descriptor.id);
  // Explicit allowlist: never hash/serialize credentials or private user data.
  const configuration = {
    mockAll: config.mock.all,
    browserBackend: config.browser.backend,
    credentialSource: config.credentials.source,
    browserCredentialSource: config.credentials.browserSource,
    webSearch: { backend: config.webSearch.backend, mode: config.webSearch.mode },
    agent: config.agent,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, cfg]) => [
        id,
        { mode: cfg.mode, models: cfg.models },
      ]),
    ),
    tools: tools
      .filter((tool) => toolIds.includes(tool.descriptor.id))
      .map((tool) => ({
        id: tool.descriptor.id,
        version: tool.descriptor.version,
        mode: tool.descriptor.executionMode,
      })),
  };
  return buildBenchmarkExperiment({ graph, requests, variables, configuration, toolIds });
}

/** A graph run is more useful named after its graph than after the playbook. */
function playbookTitleFor(input: Json): string {
  const snapshot = (input as { graphSnapshot?: { name?: string } }).graphSnapshot;
  return snapshot?.name ?? 'Run an agent graph';
}

export async function listRuns(filter: ListRunsFilter): Promise<Run[]> {
  return store.listRuns(filter);
}

export async function getRun(id: string): Promise<Run | null> {
  return store.getRun(id);
}

export async function getRunEvents(id: string, since = 0): Promise<StoredEvent[] | null> {
  if (!(await store.getRun(id))) return null;
  return store.eventsSince(id, Math.max(0, since));
}

export async function getRunDetail(id: string): Promise<RunDetail | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  const [steps, approvals, egress, piiWithValues, scheduleDecisions, agentSessions, events] =
    await Promise.all([
      store.listSteps(id),
      store.listApprovals(id),
      store.listEgress(id),
      store.listPiiSpans(id),
      store.listScheduleDecisions(id),
      store.listSessionStates(id),
      store.eventsSince(id, 0),
    ]);

  return {
    run,
    steps,
    approvals,
    egress,
    piiSpans: piiWithValues.map(stripPiiValue),
    scheduleDecisions,
    agentSessions,
    toolLifecycle: events.flatMap(({ event }) =>
      event.type === 'tool.lifecycle' ? [event.lifecycle] : [],
    ),
  };
}

/**
 * Pause and resume.
 *
 * Both are no-ops on a run that is not executing in THIS process: a pause latch
 * only means something to the loop that checks it, so pretending a restarted
 * run can be paused would be a lie the UI would then render as truth.
 */
export async function pauseRun(id: string): Promise<Run | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  if (isTerminal(run.status)) {
    throw new ValidationError('Run ' + id + ' is already ' + run.status, { status: run.status });
  }
  if (!orchestrator.isRunning(id)) {
    throw new ValidationError(
      'Run ' + id + ' is not executing in this process and cannot be paused',
      { status: run.status },
    );
  }

  // The status flips to 'paused' when the run actually reaches a checkpoint,
  // not here -- reporting it earlier would claim a step had stopped while it
  // was still running.
  gatePauseRun(id);
  return run;
}

export async function resumeRun(id: string): Promise<Run | null> {
  const run = await store.getRun(id);
  if (!run) return null;
  if (
    browserControlStatesForRun(id).some(
      (state) => state.owner === 'human' || state.phase !== 'agent_running',
    )
  ) {
    throw new ValidationError(
      'Return browser control through the Action workspace before resuming the run.',
    );
  }
  if ((await store.listApprovals(id)).some((approval) => approval.status === 'pending')) {
    throw new ValidationError('Resolve pending approvals before resuming the run.');
  }

  // Written BEFORE releasing the latch: patchRun is read-modify-write, and the
  // orchestrator's own `status: running` patch fires the moment the latch
  // opens. Recording first means that later patch already carries the span.
  // (A held latch implies gateResumeRun below succeeds.)
  await closePauseSpan(id, pauseHeldSince(id));
  if (!gateResumeRun(id)) {
    throw new ValidationError('Run ' + id + ' is not paused', { status: run.status });
  }
  return run;
}

/**
 * Record the stretch a run sat fully paused, so analytics can leave it out of
 * the run's time (see PauseSpan). Only written once the pause actually took
 * hold; a pause requested and released mid-drain records nothing.
 */
async function closePauseSpan(runId: string, heldAt: string | undefined): Promise<void> {
  if (!heldAt) return;
  const current = await store.getRun(runId);
  if (!current) return;
  const run = await store.patchRun(runId, {
    pauses: [...(current.pauses ?? []), { at: heldAt, resumedAt: nowIso() }],
  });
  await bus.emit(runId, { type: 'run.updated', run });
}

export async function cancelRun(id: string): Promise<Run | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  // A run cancelled while paused still spent that time paused.
  await closePauseSpan(id, pauseHeldSince(id));
  const stopped = orchestrator.cancel(id);
  if (!stopped) {
    // Not executing in this process (e.g. after a restart). Mark it terminal
    // rather than leaving a run that will never move again.
    const patched = await store.patchRun(id, { status: 'cancelled', summary: 'Cancelled.' });
    await bus.emit(id, { type: 'run.updated', run: patched });
    return patched;
  }
  // The orchestrator's abort path writes the terminal status and emits.
  return run;
}
