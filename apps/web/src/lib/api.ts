/**
 * Typed API client. Every shape comes from @htn/shared, so a backend change that
 * breaks a contract is a red squiggle here rather than a runtime surprise at hour 30.
 */

import type {
  AgentGraph,
  Approval,
  ApprovalDecision,
  Conversation,
  ConversationMessage,
  CreateMcpConnectionInput,
  EgressEvent,
  GraphAssertion,
  GraphCritique,
  GraphDelegation,
  GraphEdge,
  GraphNode,
  McpConnection,
  PiiSpan,
  Run,
  RunAnalytics,
  Step,
  ProviderStatus,
  Capability,
  ProviderId,
  ActionEvidence,
  ActionPreview,
  BrowserViewer,
  BenchmarkReport,
  GraphReuseReport,
  ToolLifecycleEvent,
} from '@htn/shared';
export type { BrowserViewer } from '@htn/shared';

export interface CredentialStatus {
  providerId: string;
  purpose: string;
  configured: boolean;
  source: string;
  version?: number;
  metadata?: { projectId?: string };
}

export interface CredentialConfiguration {
  source: 'operator' | 'user';
  browserSource: 'operator' | 'user';
  lifetime: 'process';
  providers: CredentialStatus[];
}

export interface RunDetail {
  run: Run;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  piiSpans: PiiSpan[];
  toolLifecycle?: ToolLifecycleEvent[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let credentialSession: Promise<unknown> | undefined;
async function ensureLocalSession(): Promise<void> {
  credentialSession ??= request('/credentials/session', { method: 'POST' }).catch((error) => {
    credentialSession = undefined;
    throw error;
  });
  await credentialSession;
}

async function request<T>(path: string, init?: RequestInit, retrySession = true): Promise<T> {
  if (path !== '/credentials/session') await ensureLocalSession();
  const res = await fetch('/api' + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    if (res.status === 401 && retrySession && path !== '/credentials/session') {
      credentialSession = undefined;
      return request<T>(path, init, false);
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
    );
  }

  return (await res.json()) as T;
}

async function credentialRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

/**
 * One reviewed tool. `name` is the AgentOS id (`mail.send`), never a vendor slug. The
 * provider fields are additive and optional so an older API still parses; without them a
 * tool simply renders without a provider badge.
 */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  availability?: 'available' | 'unavailable' | 'requires_connection';
  /** Who executes it: 'composio', 'browserbase', 'browserless', 'localbrowser', 'mcp', ... */
  providerId?: string;
  family?: string;
  effect?: 'read' | 'write' | 'destructive' | 'unknown';
  reversibility?: string;
  /** 'mock' when its backend is simulated. Absent when the API does not say. */
  executionMode?: 'live' | 'mock';
}

export const api = {
  health: () => request<{ ok: boolean; uptimeSeconds: number }>('/health'),

  providers: () =>
    request<{ providers: ProviderStatus[]; bindings: Record<Capability, ProviderId> }>(
      '/providers',
    ),

  playbooks: () =>
    request<{ playbooks: { kind: string; title: string; directLaunch: boolean }[] }>('/playbooks'),

  /** The node tool-picker's catalog. Served by whatever backs `toolbox`. */
  tools: () => request<{ tools: ToolCatalogEntry[]; cached: boolean }>('/tools'),

  /**
   * Server-computed run metrics. For a LIVE run prefer calling rollup() from
   * @htn/shared directly over the useRunStream state — same function, no
   * request, and it updates with the stream.
   */
  analytics: (id: string) => request<RunAnalytics>('/runs/' + id + '/analytics'),

  /* ------------------------------------------------------------- Graphs */

  graphs: () => request<{ graphs: AgentGraph[] }>('/graphs'),

  graph: (id: string) => request<{ graph: AgentGraph }>('/graphs/' + id),

  createGraph: (body: { name?: string; description?: string }) =>
    request<{ graph: AgentGraph }>('/graphs', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Whole-document save. `version` is the copy you last read: the server
   * returns 409 if someone else saved in between, which WILL happen once chat
   * and the canvas are both writing. Re-read and merge rather than retrying
   * blind.
   */
  saveGraph: (
    id: string,
    body: { name?: string; nodes: GraphNode[]; edges: GraphEdge[]; version?: number },
  ) =>
    request<{ graph: AgentGraph }>('/graphs/' + id, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  addNode: (id: string, node: GraphNode, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/nodes', {
      method: 'POST',
      body: JSON.stringify({ node, version }),
    }),

  patchNode: (id: string, nodeId: string, patch: Partial<GraphNode>, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/nodes/' + nodeId, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, version }),
    }),

  /** Cascades to every edge touching the node. */
  removeNode: (id: string, nodeId: string, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/nodes/' + nodeId, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),

  addEdge: (id: string, edge: GraphEdge, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/edges', {
      method: 'POST',
      body: JSON.stringify({ edge, version }),
    }),

  removeEdge: (id: string, edgeId: string, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/edges/' + edgeId, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),

  /* --------------------------------------------------------- Conversations */

  /**
   * Chat that AUTHORS a workflow graph; it never launches a run. `graphId` seeds the
   * conversation so its first message EDITS that graph instead of building a new one.
   */
  createConversation: (graphId?: string) =>
    request<{ conversation: Conversation }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ graphId }),
    }),

  /** One endpoint for both building and editing; an edit bumps the graph's version. */
  sendMessage: (id: string, text: string) =>
    request<{
      conversation: Conversation;
      message: ConversationMessage;
      graph: AgentGraph;
      delegation: GraphDelegation;
    }>('/conversations/' + id + '/messages', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /**
   * Self-improvement: critiques this graph's own runs and asks the synthesiser for a better
   * version. Always lands as a NEW forked graph to review; the source is never modified.
   */
  optimizeGraph: (graphId: string) =>
    request<{
      graph: AgentGraph;
      critique: GraphCritique;
      suggestedAssertions: GraphAssertion[];
    }>('/graphs/' + graphId + '/optimize', { method: 'POST' }),

  /** Launch a run of a graph. The run snapshots the graph as it is right now. */
  runGraph: (graphId: string, variables: Record<string, unknown> = {}, pairId?: string) =>
    request<{ run: Run }>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'graph',
        input: { graphId, variables, ...(pairId ? { pairId } : {}) },
      }),
    }),

  /** Graph vs baseline across every stored run. Mocked runs only when asked. */
  benchmarks: (includeMock = false, warmth: 'all' | 'cold' | 'warm' = 'all') =>
    request<BenchmarkReport>(
      '/benchmarks?' +
        new URLSearchParams({
          ...(includeMock ? { includeMock: '1' } : {}),
          ...(warmth !== 'all' ? { warmth } : {}),
        }).toString(),
    ),

  listRuns: (filter: { graphId?: string; kind?: string; status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (filter.graphId) params.set('graphId', filter.graphId);
    if (filter.kind) params.set('kind', filter.kind);
    if (filter.status) params.set('status', filter.status);
    if (filter.limit) params.set('limit', String(filter.limit));
    const qs = params.toString();
    return request<{ runs: Run[] }>('/runs' + (qs ? '?' + qs : ''));
  },

  createRun: (kind: string, input: unknown, title?: string) =>
    request<{ run: Run }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ kind, input, title }),
    }),

  /**
   * The main composer's launch path: one supervised `agent` run from a plain goal.
   * Labels and sanitisation are left to the backend's redaction pass on purpose --
   * see docs/frontend-handoff.md, "Starting the real agent flow".
   */
  startAgentTask: (goal: string) =>
    request<{ run: Run }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ kind: 'agent', title: goal.slice(0, 200), input: { goal } }),
    }),

  getRun: (id: string) => request<RunDetail>('/runs/' + id),

  cancelRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/cancel', { method: 'POST' }),

  /**
   * A CURRENT viewer URL for a handoff's browser session.
   *
   * Fetched WHEN THE PERSON CLICKS, never cached: Browserbase's debug URL is
   * signed with a short-lived token, so the one captured when the session
   * opened renders a blank, uninteractive page by the time anyone follows it.
   */
  browserLiveView: (runId: string, sessionId: string) =>
    request<BrowserViewer>('/runs/' + runId + '/browser/' + sessionId + '/live-view'),

  browserTakeControl: (runId: string, sessionId: string, revision: number) =>
    request<BrowserViewer>('/runs/' + runId + '/browser/' + sessionId + '/take-control', {
      method: 'POST',
      body: JSON.stringify({ revision, idempotencyKey: crypto.randomUUID() }),
    }),

  browserReleaseControl: (runId: string, sessionId: string, revision: number) =>
    request<BrowserViewer>('/runs/' + runId + '/browser/' + sessionId + '/release-control', {
      method: 'POST',
      body: JSON.stringify({ revision, idempotencyKey: crypto.randomUUID() }),
    }),

  browserInput: (
    runId: string,
    sessionId: string,
    revision: number,
    input:
      | { type: 'click'; x: number; y: number }
      | { type: 'key'; key: string }
      | { type: 'text'; text: string }
      | { type: 'scroll'; deltaX: number; deltaY: number },
  ) =>
    request<{ ok: boolean }>('/runs/' + runId + '/browser/' + sessionId + '/input', {
      method: 'POST',
      body: JSON.stringify({ revision, input }),
    }),

  actionEvidence: (runId: string, actionId: string) =>
    request<{ evidence: ActionEvidence[] }>(
      '/runs/' + runId + '/actions/' + actionId + '/evidence',
    ),

  actionPreview: (runId: string, previewRef: string) =>
    request<{ preview: ActionPreview }>('/runs/' + runId + '/previews/' + previewRef),

  credentials: () => credentialRequest<CredentialConfiguration>('/credentials'),
  saveCredential: (providerId: string, secret: string, metadata?: { projectId: string }) =>
    credentialRequest<{ provider: CredentialStatus }>('/credentials/' + providerId, {
      method: 'PUT',
      body: JSON.stringify({ secret, ...(metadata ? { metadata } : {}) }),
    }),
  removeCredential: (providerId: string) =>
    credentialRequest<{ provider: CredentialStatus }>('/credentials/' + providerId, {
      method: 'DELETE',
    }),

  /**
   * Pause is cooperative: this resolves once the server has accepted the
   * request, and the run reports status 'paused' over SSE when it actually
   * reaches a step boundary. Do not render "paused" off this response.
   */
  pauseRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/pause', { method: 'POST' }),

  resumeRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/resume', { method: 'POST' }),

  /** "Save as a new task": fork the graph THIS run executed into a new document. */
  saveRunAsGraph: (id: string) =>
    request<{ graph: AgentGraph }>('/runs/' + id + '/save-as-graph', { method: 'POST' }),

  decide: (approvalId: string, decision: ApprovalDecision) =>
    request<{ approval: Approval }>('/approvals/' + approvalId + '/decide', {
      method: 'POST',
      body: JSON.stringify(decision),
    }),

  graphReuse: (graphId: string) =>
    request<GraphReuseReport>('/graphs/' + encodeURIComponent(graphId) + '/reuse'),

  /** Use a different element on a pending browser-target review; remembered for later runs. */
  correctBrowserTarget: (approvalId: string, index: number) =>
    request<{ approval: Approval }>('/approvals/' + approvalId + '/browser-target', {
      method: 'POST',
      body: JSON.stringify({ index }),
    }),

  /* ------------------------------------------------------------ Connections */

  listMcpConnections: () => request<{ connections: McpConnection[] }>('/mcp-connections'),

  addMcpConnection: (input: CreateMcpConnectionInput) =>
    request<{ connection: McpConnection }>('/mcp-connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  refreshMcpConnection: (id: string) =>
    request<{ connection: McpConnection }>('/mcp-connections/' + id + '/refresh', {
      method: 'POST',
    }),

  setMcpConnectionEnabled: (id: string, enabled: boolean) =>
    request<{ connection: McpConnection }>('/mcp-connections/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  /** 204 No Content on success; `request` assumes a JSON body, so this bypasses it. */
  removeMcpConnection: async (id: string): Promise<void> => {
    const res = await fetch('/api/mcp-connections/' + id, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      throw new ApiError(
        res.status,
        body?.error?.code ?? 'UNKNOWN',
        body?.error?.message ?? res.statusText,
      );
    }
  },

  /** Provider-native Composio tools, with their connected-account state. */
  composioTools: () =>
    request<{
      tools: { name: string; toolkit?: string; version?: string; connected: boolean }[];
    }>('/providers/composio/tools'),

  composioConnect: (authConfigId?: string) =>
    request<{ url: string }>('/providers/composio/connect', {
      method: 'POST',
      body: JSON.stringify({ authConfigId }),
    }),

  composioRefresh: () =>
    request<{
      registered: string[];
      skipped: string[];
      requiresConnection: string[];
      warning?: string;
    }>('/providers/composio/refresh', { method: 'POST' }),
};
