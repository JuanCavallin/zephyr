/**
 * The persistence port.
 *
 * Kept deliberately narrow so swapping the in-memory implementation for SQLite is
 * one new file plus one line in store/index.ts.
 *
 * Rules that keep that swap cheap:
 *   1. EVERY method is async, even in memory — otherwise SQLite touches 40 call sites.
 *   2. Methods return plain domain objects, never ORM entities.
 *   3. Nothing outside store/ may import a database driver.
 *   4. No relations and no query builder leak out — services compose.
 */

import type {
  AgentSessionState,
  AgentGraph,
  Approval,
  BrowserSiteBlock,
  BrowserTargetMemory,
  Conversation,
  EgressEvent,
  McpConnection,
  PiiSpanWithValue,
  Run,
  RunEvent,
  RunStatus,
  ScheduleDecision,
  Step,
  StoredEvent,
} from '@htn/shared';

export interface ListRunsFilter {
  graphId?: string;
  status?: RunStatus;
  kind?: string;
  limit?: number;
}

export interface Store {
  // Runs
  createRun(run: Run): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  listRuns(filter?: ListRunsFilter): Promise<Run[]>;
  patchRun(id: string, patch: Partial<Run>): Promise<Run>;

  // Steps
  appendStep(step: Omit<Step, 'seq'>): Promise<Step>;
  patchStep(id: string, patch: Partial<Step>): Promise<Step>;
  getStep(id: string): Promise<Step | null>;
  listSteps(runId: string): Promise<Step[]>;

  // Approvals
  createApproval(approval: Approval): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  patchApproval(id: string, patch: Partial<Approval>): Promise<Approval>;
  listApprovals(runId: string): Promise<Approval[]>;

  // Canonical AgentOS session state. Harnesses and decision models are views
  // over this state; neither is allowed to become the source of truth.
  createSessionState(state: AgentSessionState): Promise<AgentSessionState>;
  getSessionState(id: string): Promise<AgentSessionState | null>;
  getSessionStateByHarnessSession(harnessSessionId: string): Promise<AgentSessionState | null>;
  patchSessionState(id: string, patch: Partial<AgentSessionState>): Promise<AgentSessionState>;
  listSessionStates(runId?: string): Promise<AgentSessionState[]>;

  // User-configured upstream MCP servers. Secret values are environment refs,
  // never fields on this record.
  // Cross-run browser memory (core/tools/targetMemory.ts). Public pages only,
  // identity only; small and bounded per scope.
  getTargetMemory(key: string): Promise<BrowserTargetMemory | null>;
  putTargetMemory(entry: BrowserTargetMemory): Promise<void>;
  deleteTargetMemory(key: string): Promise<void>;
  /** Newest first; `scope` filters to one graph node or ad-hoc kind. */
  listTargetMemory(scope?: string): Promise<BrowserTargetMemory[]>;
  recordSiteBlock(
    origin: string,
    reason: BrowserSiteBlock['reason'],
    at: string,
  ): Promise<BrowserSiteBlock>;
  listSiteBlocks(): Promise<BrowserSiteBlock[]>;

  saveMcpConnection(connection: McpConnection): Promise<McpConnection>;
  getMcpConnection(id: string): Promise<McpConnection | null>;
  listMcpConnections(): Promise<McpConnection[]>;
  deleteMcpConnection(id: string): Promise<boolean>;

  // Egress ledger (append-only)
  appendEgress(event: EgressEvent): Promise<EgressEvent>;
  listEgress(runId: string): Promise<EgressEvent[]>;

  // Schedule decisions (append-only, one per routed subtask — see scheduler.ts)
  createScheduleDecision(decision: ScheduleDecision): Promise<ScheduleDecision>;
  listScheduleDecisions(runId: string): Promise<ScheduleDecision[]>;

  // PII spans. Values stay server-side; never returned to the client as-is.
  appendPiiSpan(span: PiiSpanWithValue): Promise<PiiSpanWithValue>;
  listPiiSpans(runId: string): Promise<PiiSpanWithValue[]>;

  // Graphs. Unlike everything else here a graph is MUTABLE and not scoped to a
  // run: it is the editable document a run is launched from. Runs snapshot the
  // graph they executed, so editing one never rewrites history.
  saveGraph(graph: AgentGraph): Promise<AgentGraph>;
  getGraph(id: string): Promise<AgentGraph | null>;
  listGraphs(): Promise<AgentGraph[]>;
  deleteGraph(id: string): Promise<boolean>;

  // Conversations. Mutable like graphs, and not scoped to a run. The chat that
  // AUTHORS a graph depends on these -- see api/conversations.routes.ts, which
  // is the front door of the workspace UI (Workspace.tsx's composer), so
  // dropping them takes the app's main entry flow with it.
  saveConversation(conversation: Conversation): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  listConversations(): Promise<Conversation[]>;

  // Event log — append-only, monotonic seq per run. Powers SSE replay.
  appendEvent(runId: string, event: RunEvent): Promise<StoredEvent>;
  eventsSince(runId: string, seq: number): Promise<StoredEvent[]>;
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(entity: string, id: string) {
    super(entity + ' ' + id + ' not found');
    this.name = 'NotFoundError';
  }
}
