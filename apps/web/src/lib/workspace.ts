import type {
  AgentGraph,
  RunView,
  StepStatus,
  ScheduleDecision,
  ToolLifecycleEvent,
  ToolLifecyclePhase,
} from '@htn/shared';

export type Scenario = 'support' | 'trip';

export type TraceNode = {
  id: string;
  label: string;
  kind: string;
  status: StepStatus;
  route: string;
  detail: string;
  position: { x: number; y: number };
  tokens?: number;
  costCents?: number;
  durationMs?: number;
  decision?: ScheduleDecision;
  /** In the plan, but no execution has been reported for it yet. Carries no measurements. */
  planned: boolean;
  /** Created by the runtime and never present in the plan — a fan-out child or a delegation. */
  unplanned: boolean;
  /** A route the user changed from the inspector. Preview only; see `canInterveneLive`. */
  revised?: boolean;
  /**
   * What the node is. Absent means an ordinary step. A tool node is either `tool-called`
   * (the broker reported an exact action for it) or `tool-exposed` (AgentOS/Jev offered it
   * to the agent and nothing has been reported as called). The two must never be conflated:
   * being exposed is not evidence that anything ran.
   */
  role?: 'tool-called' | 'tool-exposed';
  tool?: TraceTool;
};

export type TraceTool = {
  id: string;
  /** 'composio' | 'browserbase' | 'browserless' | 'localbrowser' | 'mcp' ... Undefined when the catalog is unknown. */
  providerId?: string;
  family?: string;
  effect?: string;
  /** Latest lifecycle phase of a called tool. Absent for an exposed-only tool. */
  phase?: ToolLifecyclePhase;
  /** How many exact actions the agent proposed for this tool on this step. */
  attempts: number;
  /** Deterministic final policy: auto | verify | ask_user | deny. */
  policy?: string;
  reasonCodes: string[];
  destination?: string;
  dataLabels: string[];
  /** Truncated JSON of the exact arguments. Already visible in the approval panel. */
  argsPreview?: string;
  outputSummary?: string;
  errorMessage?: string;
  approvalId?: string;
};

/** The slice of a catalog entry the trace needs. Optional everywhere: an old API omits it. */
export type ToolMeta = { providerId?: string; family?: string; effect?: string };

const PROVIDER_LABELS: Record<string, string> = {
  composio: 'Composio',
  browserbase: 'Browserbase',
  browserless: 'Browserless',
  localbrowser: 'Local browser (Playwright)',
  mcp: 'MCP',
  hermes: 'Hermes',
};
export const providerLabel = (id?: string) =>
  id ? (PROVIDER_LABELS[id] ?? id) : 'Provider unknown';

/**
 * A glyph for the app a tool belongs to. Deliberately local and static: no image is fetched
 * from anywhere, so it renders offline, in mock mode, and adds no browser egress.
 *
 * Keyed on the tool's family first (a Composio family is its toolkit slug, e.g. `gmail`),
 * then on the id's domain (`mail.send` -> `mail`). An unknown app gets its provider's
 * glyph rather than a wrong guess.
 */
const APP_GLYPHS: Record<string, string> = {
  mail: '✉️',
  gmail: '✉️',
  outlook: '✉️',
  calendar: '📅',
  googlecalendar: '📅',
  sheets: '📊',
  googlesheets: '📊',
  excel: '📊',
  docs: '📄',
  googledocs: '📄',
  drive: '📁',
  googledrive: '📁',
  notion: '📝',
  github: '🐙',
  gitlab: '🦊',
  slack: '💬',
  discord: '💬',
  teams: '💬',
  linear: '🧭',
  jira: '🧭',
  trello: '🗂️',
  asana: '🗂️',
  hubspot: '🤝',
  salesforce: '🤝',
  crm: '🤝',
  stripe: '💳',
  twitter: '🐦',
  linkedin: '💼',
  forms: '📋',
  web: '🔎',
  browser: '🌐',
  agentos: '🧩',
};
const PROVIDER_GLYPHS: Record<string, string> = {
  composio: '🔌',
  browserbase: '🌐',
  browserless: '☁️',
  localbrowser: '🖥️',
  mcp: '🧩',
};
export function toolGlyph(tool: { id: string; family?: string; providerId?: string }): string {
  const domain = tool.id.split('.')[0]?.toLowerCase() ?? '';
  return (
    APP_GLYPHS[(tool.family ?? '').toLowerCase()] ??
    APP_GLYPHS[domain] ??
    PROVIDER_GLYPHS[tool.providerId ?? ''] ??
    '🔧'
  );
}

/**
 * What the provider is doing for this tool right now, in the words the user would use.
 * "Connecting" is claimed only while the broker has reported it is executing: earlier
 * phases are policy work, and `awaiting_approval` is the human's turn, not Composio's.
 */
export function toolActivity(node: Pick<TraceNode, 'role' | 'tool'>): string | undefined {
  const tool = node.tool;
  if (!tool) return undefined;
  const from = providerLabel(tool.providerId);
  if (node.role === 'tool-exposed') return `Available via ${from}`;
  switch (tool.phase) {
    case 'proposed':
    case 'policy_decided':
      return 'Checking policy';
    case 'awaiting_approval':
      return 'Needs your approval';
    case 'approved':
    case 'executing':
      return `Connecting to ${from}…`;
    case 'succeeded':
      return `Ran via ${from}`;
    case 'blocked':
      return 'Blocked by policy';
    case 'failed':
      return `Failed via ${from}`;
    default:
      return undefined;
  }
}

const TOOL_STATUS: Record<ToolLifecyclePhase, StepStatus> = {
  proposed: 'running',
  policy_decided: 'running',
  awaiting_approval: 'blocked',
  approved: 'running',
  executing: 'running',
  succeeded: 'succeeded',
  blocked: 'failed',
  failed: 'failed',
};
const TOOL_TERMINAL = new Set<ToolLifecyclePhase>(['succeeded', 'blocked', 'failed']);

export type Trace = {
  nodes: TraceNode[];
  edges: { id: string; source: string; target: string; label?: string; planned?: boolean }[];
  tokens?: number;
  costCents?: number;
  elapsedMs: number;
  provenance: 'preview' | 'mock' | 'live' | 'mixed' | 'unknown';
  status: string;
};

/**
 * What the run API actually supports today, read by the UI to decide which controls are
 * live and which are shown disabled with their reason.
 *
 * `pauseResume` is true: POST /runs/:id/pause and /runs/:id/resume exist, and the
 * orchestrator parks at step boundaries rather than aborting. It is cooperative, so a
 * pause lands at the next boundary, not mid-call.
 *
 * `editRunningNode` is still false, and for a different reason than it used to be.
 * `runs.service.ts` snapshots the graph document at run start on purpose, so that editing a
 * graph cannot retroactively change what an already-finished run did. A mid-run
 * `PATCH /graphs/:id/nodes/:nodeId` therefore still does not reach the running execution,
 * and a revised node would additionally have to clear `authorize_action`. Pausing was
 * necessary for that, not sufficient.
 *
 * The contract for making the rest true is `docs/contracts/run-intervention.md`.
 */
export const RUN_CAPABILITIES = {
  pauseResume: true,
  editRunningNode: false,
} as const;

export const canInterveneLive = RUN_CAPABILITIES.pauseResume && RUN_CAPABILITIES.editRunningNode;

/** Stated on every disabled live-intervention control. Names the missing capability, not a vibe. */
export const LIVE_INTERVENTION_REASON =
  'A run executes a snapshot of the graph taken when it started, so editing a node now would not reach the running execution. Pause and resume work; applying an edit to a live run does not.';

/** Candidate routes offered by the inspector's edit control. Preview only. */
export const ROUTE_OPTIONS = [
  { id: 'local', label: 'Local · private', note: 'Runs on the local endpoint. Nothing leaves.' },
  { id: 'cloud-cheap', label: 'Cloud · cheap', note: 'Lower cost. Public context only.' },
  { id: 'cloud-frontier', label: 'Cloud · frontier', note: 'Strongest model. Highest cost.' },
] as const;
export type RouteOption = (typeof ROUTE_OPTIONS)[number]['id'];
export type RouteOverrides = Partial<Record<string, RouteOption>>;

export function formatCost(cents?: number) {
  return cents === undefined ? '—' : '$' + (cents / 100).toFixed(3);
}

/**
 * Compact token count for dense surfaces like a graph node.
 * Unknown stays unknown — a step that reported nothing renders `—`, never `0`.
 */
export function formatTokens(tokens?: number) {
  if (tokens === undefined) return '—';
  return tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

export function formatDuration(ms?: number) {
  if (ms === undefined) return '—';
  return ms < 60000
    ? (ms / 1000).toFixed(1) + 's'
    : Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}

export function advancePreview(elapsed: number, delta: number, playing: boolean, limit: number) {
  return playing ? Math.min(limit, elapsed + Math.max(0, delta)) : elapsed;
}

const NODE_WIDTH = 210;
const RANK_SEP = 92;
const ROW_STEP = 132;

/**
 * Deterministic layered left-to-right layout.
 *
 * Node order inside a rank follows the order the nodes were supplied, which is plan order
 * first and runtime-created nodes appended after. That ordering is what keeps a *growing*
 * graph stable: adding a node shifts its rank to stay centred, but never reshuffles the
 * nodes already on screen, so the picture reads as growth rather than as a jump.
 */
export function layoutTrace<T extends { id: string }>(
  nodes: T[],
  edges: { source: string; target: string }[],
): Map<string, { x: number; y: number }> {
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (!rank.has(edge.source) || !rank.has(edge.target)) continue;
      const next = Math.min(nodes.length, (rank.get(edge.source) ?? 0) + 1);
      if (next > (rank.get(edge.target) ?? 0)) {
        rank.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const depth = rank.get(node.id) ?? 0;
    byRank.set(depth, [...(byRank.get(depth) ?? []), node.id]);
  }
  const tallest = Math.max(1, ...[...byRank.values()].map((ids) => ids.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, ids] of byRank) {
    ids.forEach((id, index) => {
      positions.set(id, {
        x: depth * (NODE_WIDTH + RANK_SEP),
        y: (index - (ids.length - 1) / 2) * ROW_STEP + ((tallest - 1) / 2) * ROW_STEP,
      });
    });
  }
  return positions;
}

const RANK: Record<StepStatus, number> = {
  skipped: 0,
  succeeded: 1,
  pending: 2,
  running: 3,
  blocked: 4,
  failed: 5,
};
const sumKnown = (values: (number | undefined)[]) => {
  const known = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return known.length ? known.reduce((sum, value) => sum + value, 0) : undefined;
};

const jsonPreview = (value: unknown, limit = 600) => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};

const pairKey = (stepId: string, toolId: string) => stepId + '\u0000' + toolId;

/**
 * One node per exact tool action the broker reported, plus one per tool that was exposed to
 * a step and never called.
 *
 * WHY THIS EXISTS: an `agent` run has a single outer step. Everything the agent did with a
 * tool arrives only as `tool.lifecycle` events, and what it was allowed to use arrives as
 * Jev, model and session selections. Read from steps alone, the graph would show one node
 * and hide every Composio call.
 *
 * Exposure is unioned across three sources because each is written at a different moment:
 * Jev's `select_tools` decision, the tools on each model request, and the session's latest
 * grant. Called wins over exposed: a tool with a reported action is drawn once per action
 * and not again as a ghost.
 */
function buildToolNodes(
  view: RunView,
  catalog: ReadonlyMap<string, ToolMeta> | undefined,
  now: number,
  anchorFor: (stepId: string | undefined) => string | undefined,
): { nodes: TraceNode[]; edges: Trace['edges'] } {
  // Older callers and tests build a RunView without these collections.
  const lifecycle = view.toolLifecycle ?? [];
  const sessions = view.agentSessions ?? [];
  const nodes: TraceNode[] = [];
  const edges: Trace['edges'] = [];
  const meta = (id: string): ToolMeta => catalog?.get(id) ?? {};
  const routeText = (id: string) => {
    const info = meta(id);
    return [providerLabel(info.providerId), info.effect].filter(Boolean).join(' · ');
  };

  const byAction = new Map<string, ToolLifecycleEvent[]>();
  for (const event of lifecycle) {
    byAction.set(event.action.id, [...(byAction.get(event.action.id) ?? []), event]);
  }
  const attempts = new Map<string, number>();
  for (const events of byAction.values()) {
    const { stepId, toolId } = events[0]!.action;
    attempts.set(pairKey(stepId, toolId), (attempts.get(pairKey(stepId, toolId)) ?? 0) + 1);
  }

  for (const [actionId, events] of byAction) {
    const latest = events[events.length - 1]!;
    const { action } = latest;
    const newest = [...events].reverse();
    const auth = newest.find((event) => event.authorization)?.authorization;
    const summary = newest.find((event) => event.outputSummary)?.outputSummary;
    const failure = newest.find((event) => event.error)?.error;
    const approvalId = newest.find((event) => event.approvalId)?.approvalId;
    const info = meta(action.toolId);
    const start = Date.parse(events[0]!.at);
    const end = Date.parse(latest.at);
    const id = 'tool:' + actionId;
    const parent = anchorFor(action.stepId);
    nodes.push({
      id,
      label: action.toolId,
      kind: 'tool_call',
      role: 'tool-called',
      status: TOOL_STATUS[latest.phase],
      planned: false,
      unplanned: false,
      route: routeText(action.toolId),
      detail:
        failure?.message ??
        summary ??
        (latest.phase === 'awaiting_approval'
          ? 'Waiting for your approval of this exact action.'
          : latest.phase === 'succeeded'
            ? 'The tool reported success.'
            : 'Authorized as ' +
              (auth?.finalPolicy ?? 'pending') +
              '. Not yet reported as complete.'),
      position: { x: 0, y: 0 },
      durationMs: Number.isFinite(start)
        ? Math.max(0, (TOOL_TERMINAL.has(latest.phase) ? end : now) - start)
        : undefined,
      tool: {
        id: action.toolId,
        providerId: info.providerId,
        family: info.family,
        effect: info.effect,
        phase: latest.phase,
        attempts: attempts.get(pairKey(action.stepId, action.toolId)) ?? 1,
        policy: auth?.finalPolicy,
        reasonCodes: auth?.reasonCodes ?? [],
        destination: action.destination,
        dataLabels: action.dataLabels,
        argsPreview: jsonPreview(action.arguments),
        outputSummary: summary,
        errorMessage: failure?.message,
        approvalId,
      },
    });
    if (parent) edges.push({ id: parent + '->' + id, source: parent, target: id, planned: false });
  }

  // Exposed: offered to the step and never reported as called.
  const exposed = new Map<string, { stepId: string; toolId: string }>();
  const expose = (stepId: string | undefined, toolIds: string[] | undefined) => {
    if (!stepId) return;
    for (const toolId of toolIds ?? []) exposed.set(pairKey(stepId, toolId), { stepId, toolId });
  };
  for (const session of sessions) expose(session.stepId, session.selectedToolIds);
  for (const call of view.modelCalls ?? []) {
    expose(
      call.stepId ?? sessions.find((session) => session.id === call.sessionStateId)?.stepId,
      call.selectedToolIds,
    );
  }
  for (const decision of view.controlDecisions ?? []) {
    if (decision.operation === 'select_tools') expose(decision.stepId, decision.selectedIds);
  }
  for (const [key, { stepId, toolId }] of exposed) {
    if (attempts.has(key)) continue;
    const info = meta(toolId);
    const id = 'tool-exposed:' + stepId + ':' + toolId;
    const parent = anchorFor(stepId);
    nodes.push({
      id,
      label: toolId,
      kind: 'tool_exposed',
      role: 'tool-exposed',
      status: 'pending',
      // Dashed and measurement-free, like any structure that has not run.
      planned: true,
      unplanned: false,
      route: routeText(toolId),
      detail: 'Offered to the agent for this step. No call has been reported.',
      position: { x: 0, y: 0 },
      tool: {
        id: toolId,
        providerId: info.providerId,
        family: info.family,
        effect: info.effect,
        attempts: 0,
        reasonCodes: [],
        dataLabels: [],
      },
    });
    if (parent) edges.push({ id: parent + '->' + id, source: parent, target: id, planned: true });
  }
  return { nodes, edges };
}

export function buildTrace(
  view: RunView,
  graph?: AgentGraph | null,
  now = Date.now(),
  catalog?: ReadonlyMap<string, ToolMeta>,
): Trace {
  // Plan order first, then anything the runtime created that was never in the plan.
  // `ctx.fanOut()` makes child steps at execution time; those nodes are real work and must
  // appear, but they must also be visibly distinguished from planned structure.
  const planned = graph?.nodes ?? [];
  const plannedIds = new Set(planned.map((node) => node.id));
  const runtimeSteps = graph
    ? view.steps.filter((step) => !step.nodeId || !plannedIds.has(step.nodeId))
    : view.steps;
  const runtime = runtimeSteps.map((step) => ({
    id: step.id,
    label: step.label,
    type: step.kind,
  }));
  const sources = [
    ...planned.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    ...runtime,
  ];
  const sourceIds = new Set(sources.map((node) => node.id));

  const plannedEdges = (graph?.edges ?? []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.sourceHandle,
    planned: true,
  }));
  // A runtime step hangs off its parent step, or off the plan node its parent executed.
  const parentOf = (stepId: string) => {
    const step = view.steps.find((item) => item.id === stepId);
    if (!step?.parentStepId) return undefined;
    const parent = view.steps.find((item) => item.id === step.parentStepId);
    if (!parent) return undefined;
    const viaNode = graph && parent.nodeId && plannedIds.has(parent.nodeId) ? parent.nodeId : null;
    return viaNode ?? parent.id;
  };
  const runtimeEdges = runtimeSteps
    .map((step) => ({ id: step.id + '-parent', source: parentOf(step.id), target: step.id }))
    .filter((edge): edge is { id: string; source: string; target: string } =>
      Boolean(edge.source && sourceIds.has(edge.source)),
    )
    .map((edge) => ({ ...edge, planned: false }));
  // Tool nodes hang off the step that owned them. In a graph run that is the plan node the
  // step executed, so a tool never floats detached from the node the author drew.
  const anchorFor = (stepId: string | undefined) => {
    if (!stepId) return undefined;
    const step = view.steps.find((item) => item.id === stepId);
    if (graph && step?.nodeId && plannedIds.has(step.nodeId)) return step.nodeId;
    return sourceIds.has(stepId) ? stepId : undefined;
  };
  const toolNodes = buildToolNodes(view, catalog, now, anchorFor);
  const edges = [...plannedEdges, ...runtimeEdges, ...toolNodes.edges];

  // PLACEMENT ONLY -- never rendered. A run with no authored graph (a playbook, a free-form
  // agent task) has no edges between its top-level steps, so the layout stacked them in one
  // rank and the cards overlapped as soon as a label wrapped. Ordering them left to right by
  // `seq` says "this ran after that", which is true; drawing an edge would claim "this
  // DEPENDS on that", which the trace cannot know. So the hint feeds the layout and stays
  // out of `edges` (see the "does not invent dependencies" test).
  const topLevel = graph
    ? []
    : runtimeSteps.filter((step) => !step.parentStepId).sort((x, y) => x.seq - y.seq);
  const placementHints = topLevel.slice(1).map((step, index) => ({
    source: topLevel[index]!.id,
    target: step.id,
  }));

  const positions = layoutTrace(
    [...sources, ...toolNodes.nodes.map((node) => ({ id: node.id }))],
    [...edges, ...placementHints],
  );
  const nodes = sources.map((node): TraceNode => {
    const steps = view.steps.filter((step) =>
      graph && plannedIds.has(node.id) ? step.nodeId === node.id : step.id === node.id,
    );
    const rows = view.egress.filter((row) => steps.some((step) => step.id === row.stepId));
    const decision = view.scheduleDecisions.findLast((item) =>
      steps.some((step) => step.id === item.stepId),
    );
    const starts = steps.map((step) => Date.parse(step.startedAt ?? '')).filter(Number.isFinite);
    const ends = steps.map((step) => Date.parse(step.endedAt ?? '')).filter(Number.isFinite);
    const status = steps.length
      ? steps.reduce(
          (worst, step) => (RANK[step.status] > RANK[worst] ? step.status : worst),
          'skipped' as StepStatus,
        )
      : 'pending';
    const isPlanned = !steps.length;
    return {
      id: node.id,
      label: node.label,
      kind: node.type,
      status,
      planned: isPlanned,
      unplanned: !plannedIds.has(node.id) && !!graph,
      route: decision
        ? `${decision.privacy} · ${decision.modelTier}`
        : (steps.find((step) => step.providerId)?.providerId ?? 'Not reported'),
      detail:
        steps.find((step) => step.error)?.error?.message ??
        decision?.rule ??
        (steps.length
          ? 'Recorded execution step. Select a routed step to inspect its decision.'
          : 'Planned workflow node. Execution has not been reported.'),
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      // A planned node has no measurements at all — not zeroes.
      tokens: isPlanned
        ? undefined
        : sumKnown(rows.flatMap((row) => [row.tokensIn, row.tokensOut])),
      costCents: isPlanned ? undefined : sumKnown(rows.map((row) => row.estimatedCostCents)),
      durationMs: starts.length
        ? Math.max(
            0,
            (steps.some((step) => step.status === 'running')
              ? now
              : ends.length
                ? Math.max(...ends)
                : Math.min(...starts)) - Math.min(...starts),
          )
        : undefined,
      decision,
    };
  });

  nodes.push(
    ...toolNodes.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })),
  );

  const destinations = view.egress.filter(
    (event) => !event.destination.startsWith('hermes-internal://'),
  );
  const mocked = destinations.filter((event) => event.destination.startsWith('mock://')).length;
  const starts = view.steps.map((step) => Date.parse(step.startedAt ?? '')).filter(Number.isFinite);
  const ends = view.steps.map((step) => Date.parse(step.endedAt ?? '')).filter(Number.isFinite);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(view.run?.status ?? '');
  return {
    nodes,
    edges,
    tokens: sumKnown(view.egress.flatMap((event) => [event.tokensIn, event.tokensOut])),
    costCents: sumKnown(view.egress.map((event) => event.estimatedCostCents)),
    elapsedMs: starts.length
      ? Math.max(0, (terminal ? Math.max(...ends, ...starts) : now) - Math.min(...starts))
      : 0,
    provenance: !destinations.length
      ? 'unknown'
      : mocked === destinations.length
        ? 'mock'
        : mocked
          ? 'mixed'
          : 'live',
    status: view.run?.status ?? 'pending',
  };
}

export const SCENARIOS = {
  support: {
    title: 'Research high-risk accounts',
    prompt:
      'Research our high-risk accounts, prepare a brief, and draft outreach. Ask me before sending anything.',
    intro:
      'I’ll keep private account data local, research public signals, and bring the outreach draft back for your approval.',
    result:
      'Your account brief is ready for review. The private context and public research have been combined into a draft. Nothing has been sent.',
    notes: [
      'Private account context stays local',
      'Public research uses a lower-cost route',
      'Outreach waits for your approval',
    ],
  },
  trip: {
    title: 'A weekend in Toronto',
    prompt:
      'Plan a 3-day trip to Toronto for two people. Include food, attractions, and a rough budget. Keep it realistic and low effort.',
    intro:
      'I’ll explore places to visit, food, and places to stay in parallel, then bring it together into an easy three-day plan.',
    result:
      'A slower weekend in Toronto. Start downtown and along the waterfront, spend a day around Kensington Market, then leave the final afternoon for the islands.',
    notes: [
      'Day 1 · Downtown & the waterfront',
      'Day 2 · Kensington Market & neighbourhood cafés',
      'Day 3 · Toronto Islands & a relaxed afternoon',
    ],
  },
};

export const PREVIEW_LIMIT = 18000;

type PreviewDefinition = {
  id: string;
  label: string;
  kind: string;
  start: number;
  end: number;
  route: string;
  detail: string;
  /** Absent for a tool node: a tool call reports no tokens of its own. */
  tokens?: number;
  cost?: number;
  /** Set when the step is created by the runtime at this time rather than planned up front. */
  spawnedAt?: number;
  /** When a planned node first appears, for structure that is decided rather than spawned. */
  appearsAt?: number;
  /**
   * A tool node. `called: false` is exposed-only. `gated` means it waits on the approval
   * gate and is decided by it, so the preview cannot show it running before approval.
   */
  tool?: {
    id: string;
    family: string;
    providerId: string;
    effect: string;
    called: boolean;
    gated?: boolean;
  };
  parent: string | null;
};

const NEVER = Number.POSITIVE_INFINITY;

/**
 * Illustrative Composio tools for the preview. Named in AgentOS's own vocabulary, exactly as
 * the reviewed registry names them, but nothing here calls anything.
 */
function previewTools(trip: boolean): PreviewDefinition[] {
  const detail = (text: string) => `Illustrative. ${text} No tool is called in this preview.`;
  const tools: PreviewDefinition[] = [
    {
      id: 'tool-sheets',
      label: 'sheets.read',
      kind: 'tool_exposed',
      start: NEVER,
      end: NEVER,
      appearsAt: 1800,
      route: 'Composio · read',
      detail: detail('Offered to the agent for this step, then not needed.'),
      tool: {
        id: 'sheets.read',
        family: 'googlesheets',
        providerId: 'composio',
        effect: 'read',
        called: false,
      },
      parent: 'route',
    },
    {
      id: 'tool-calendar',
      label: 'calendar.create',
      kind: 'tool_exposed',
      start: NEVER,
      end: NEVER,
      appearsAt: 1800,
      route: 'Composio · write',
      detail: detail('Offered to the agent for this step, then not needed.'),
      tool: {
        id: 'calendar.create',
        family: 'googlecalendar',
        providerId: 'composio',
        effect: 'write',
        called: false,
      },
      parent: 'route',
    },
    {
      id: 'tool-draft',
      label: 'docs.draft',
      kind: 'tool_call',
      start: 13000,
      end: 15200,
      route: 'Composio · write',
      detail: detail('Saves the draft to a document through a connected account.'),
      tool: {
        id: 'docs.draft',
        family: 'googledocs',
        providerId: 'composio',
        effect: 'write',
        called: true,
      },
      parent: 'synthesis',
    },
  ];
  if (!trip) {
    tools.push({
      id: 'tool-send',
      label: 'mail.send',
      kind: 'tool_call',
      start: PREVIEW_LIMIT,
      end: PREVIEW_LIMIT,
      route: 'Composio · write',
      detail: detail('Sends the outreach email. It runs only after you approve the exact message.'),
      tool: {
        id: 'mail.send',
        family: 'mail',
        providerId: 'composio',
        effect: 'write',
        called: true,
        gated: true,
      },
      parent: 'finish',
    });
  }
  return tools;
}

function previewSteps(trip: boolean): PreviewDefinition[] {
  return [
    {
      id: 'route',
      label: 'Route the request',
      kind: 'judge',
      start: 0,
      end: 1800,
      route: 'Jev · decision',
      detail:
        'Illustrative routing decision: narrow the candidate tools and select policy-eligible model routes.',
      tokens: 156,
      cost: 0.08,
      parent: null,
    },
    {
      id: 'context',
      label: trip ? 'Find places to explore' : 'Read account context',
      kind: trip ? 'browse' : 'redact',
      start: 1800,
      end: 6300,
      route: trip ? 'Cloud · cheap' : 'Local · private',
      detail: trip
        ? 'Illustrative public research branch for neighbourhoods and attractions.'
        : 'Illustrative privacy path. Synthetic account data is handled locally.',
      tokens: 480,
      cost: trip ? 0.19 : 0,
      parent: 'route',
    },
    {
      id: 'research',
      label: trip ? 'Discover food spots' : 'Research public signals',
      kind: 'browse',
      start: 1800,
      end: 8900,
      route: 'Hermes · cloud',
      detail:
        'Illustrative delegated research using public information only. Internal harness steps are not fully observable.',
      tokens: 860,
      cost: 0.48,
      parent: 'route',
    },
    {
      id: 'compare',
      label: trip ? 'Compare places to stay' : 'Assess account risk',
      kind: 'decide',
      start: 1800,
      end: 11500,
      route: 'Cloud · cheap',
      detail:
        'Illustrative bounded analysis branch. No actual external request is made in this preview.',
      tokens: 632,
      cost: 0.26,
      parent: 'route',
    },
    {
      // Never in the plan. The runtime fans this worker out once the research branch is under
      // way, which is exactly what `ctx.fanOut()` does on a real run.
      id: 'fanout',
      label: trip ? 'Check a second neighbourhood' : 'Check a second filing source',
      kind: 'swarm',
      start: 5200,
      end: 10400,
      spawnedAt: 5200,
      route: 'Hermes · worker',
      detail:
        'Illustrative runtime-created worker. It was never in the plan — the executing step fanned it out.',
      tokens: 344,
      cost: 0.17,
      parent: 'research',
    },
    {
      id: 'synthesis',
      label: trip ? 'Build your itinerary' : 'Prepare account brief',
      kind: 'agent_task',
      start: 11500,
      end: 16500,
      route: 'Hermes · synthesis',
      detail: 'Illustrative synthesis joins the completed branches into one reviewable result.',
      tokens: 1130,
      cost: 0.82,
      parent: 'compare',
    },
    {
      id: 'finish',
      label: trip ? 'Ready for your trip' : 'Approve outreach',
      kind: trip ? 'result' : 'approval',
      start: 16500,
      end: 18000,
      route: trip ? 'Result' : 'Human approval',
      detail: trip
        ? 'Sample itinerary, not live travel research or verified prices.'
        : 'Preview gate only. Approving this example does not send a message.',
      tokens: 0,
      cost: 0,
      parent: 'synthesis',
    },
  ];
}

/** Steps, then tools, with the closing step last so it stays the final node. */
function previewDefinitions(trip: boolean): PreviewDefinition[] {
  const steps = previewSteps(trip);
  return [...steps.slice(0, -1), ...previewTools(trip), ...steps.slice(-1)];
}

const PREVIEW_EDGES = [
  ['route', 'context'],
  ['route', 'research'],
  ['route', 'compare'],
  ['research', 'fanout'],
  ['context', 'synthesis'],
  ['research', 'synthesis'],
  ['compare', 'synthesis'],
  ['fanout', 'synthesis'],
  ['synthesis', 'finish'],
  ['route', 'tool-sheets'],
  ['route', 'tool-calendar'],
  ['synthesis', 'tool-draft'],
  ['finish', 'tool-send'],
];

export function previewTrace(
  scenario: Scenario,
  elapsed: number,
  approval?: 'approved' | 'rejected',
  overrides: RouteOverrides = {},
): Trace {
  const trip = scenario === 'trip';
  const definitions = previewDefinitions(trip);
  // A runtime-created node does not exist on the canvas before the runtime creates it.
  const present = definitions.filter((item) => elapsed >= (item.spawnedAt ?? item.appearsAt ?? 0));
  const presentIds = new Set(present.map((item) => item.id));
  const edges = PREVIEW_EDGES.filter(
    ([source, target]) => presentIds.has(source!) && presentIds.has(target!),
  ).map(([source, target]) => {
    const target_ = definitions.find((item) => item.id === target);
    return {
      id: source + '-' + target,
      source: source!,
      target: target!,
      planned: target_?.spawnedAt === undefined,
    };
  });
  const positions = layoutTrace(present, edges);

  const nodes: TraceNode[] = present.map((item) => {
    let status: StepStatus =
      elapsed < item.start ? 'pending' : elapsed < item.end ? 'running' : 'succeeded';
    if (item.id === 'finish' && !trip && elapsed >= PREVIEW_LIMIT)
      status =
        approval === 'approved' ? 'succeeded' : approval === 'rejected' ? 'skipped' : 'blocked';
    // A gated tool is decided by the approval gate, never by the clock.
    if (item.tool?.gated)
      status =
        approval === 'approved' ? 'succeeded' : approval === 'rejected' ? 'skipped' : 'pending';
    const started = item.tool?.gated
      ? approval === 'approved'
      : item.tool && !item.tool.called
        ? false
        : elapsed >= item.start;
    const completed = item.tool?.gated ? approval === 'approved' : elapsed >= item.end;
    const override = overrides[item.id];
    // A tool call is not a routed model step, so there is no route to change.
    const chosen = item.tool ? undefined : ROUTE_OPTIONS.find((option) => option.id === override);
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
      status,
      planned: !started,
      unplanned: item.spawnedAt !== undefined,
      revised: !!chosen,
      route: chosen?.label ?? item.route,
      detail: chosen
        ? `Route changed in this preview to ${chosen.label}. ${chosen.note} On a live run this edit would be re-authorized before execution resumed.`
        : item.detail,
      position: positions.get(item.id) ?? { x: 0, y: 0 },
      // Nothing is reported for a step that has not started. `—`, never `0`.
      tokens: completed ? item.tokens : undefined,
      costCents: completed ? item.cost : undefined,
      durationMs:
        started && !item.tool?.gated
          ? Math.max(0, Math.min(elapsed, item.end) - item.start)
          : undefined,
      ...(item.tool
        ? {
            role: item.tool.called ? ('tool-called' as const) : ('tool-exposed' as const),
            tool: {
              id: item.tool.id,
              providerId: item.tool.providerId,
              family: item.tool.family,
              effect: item.tool.effect,
              attempts: item.tool.called ? 1 : 0,
              phase: !item.tool.called
                ? undefined
                : status === 'running'
                  ? ('executing' as const)
                  : status === 'succeeded'
                    ? ('succeeded' as const)
                    : undefined,
              reasonCodes: [],
              dataLabels: [],
            },
          }
        : {}),
    };
  });

  return {
    nodes,
    edges,
    tokens: sumKnown(nodes.map((node) => node.tokens)),
    costCents: sumKnown(nodes.map((node) => node.costCents)),
    elapsedMs: elapsed,
    provenance: 'preview',
    status:
      elapsed < PREVIEW_LIMIT
        ? 'running'
        : trip || approval === 'approved'
          ? 'succeeded'
          : approval === 'rejected'
            ? 'cancelled'
            : 'awaiting_approval',
  };
}
