/**
 * The graph canvas.
 *
 * Read-only by default (the run view, `RunDetail.tsx`, never passes
 * `editable`). `GraphEditor.tsx` passes `editable`, which turns on drag,
 * connect, and delete -- the node renderer, palette and live overlay do not
 * change between the two modes, which is why they were split out ahead of
 * this rather than written inline.
 *
 * Node positions are kept in local state, resynced from `graph` whenever the
 * document identity changes (a save, a chat edit, a different graph loaded).
 * Dragging only ever touches that local copy; a drag's own `onNodeDragStop`
 * is what pushes the new position back to the server, and the resync that
 * follows the server's response confirms it rather than causing a jump --
 * two sources of truth would otherwise fight over the same coordinate on
 * every render.
 *
 * `steps` and `analytics` are optional: with neither, this renders a static
 * document (the editor). With them, the same component is the live run view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodesDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  executorOf,
  type AgentGraph,
  type Approval,
  type RunAnalytics,
  type Step,
  type StepStatus,
} from '@htn/shared';
import { NodeCard, type NodeCardData } from './NodeCard';
import type { PanelSession } from './BrowserPanel';
import { ActionWorkspace } from '../actions/ActionWorkspace';
import { EXECUTOR_CLASSES } from './palette';

const NODE_TYPES = { agentNode: NodeCard };
const DELETE_KEYS = ['Backspace', 'Delete'];

/**
 * Worst-wins, matching rollup()'s node status. A swarm whose parent succeeded
 * but which had a failed worker should read as failed on the canvas too.
 */
const RANK: Record<StepStatus, number> = {
  failed: 5,
  blocked: 4,
  running: 3,
  pending: 2,
  succeeded: 1,
  skipped: 0,
};

/** Just the host, for the node's one-line mark. A full URL never fits. */
function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function statusByNode(steps: Step[]): Map<string, StepStatus> {
  const out = new Map<string, StepStatus>();
  for (const step of steps) {
    if (!step.nodeId) continue;
    const current = out.get(step.nodeId);
    if (!current || RANK[step.status] > RANK[current]) out.set(step.nodeId, step.status);
  }
  return out;
}

export interface GraphCanvasProps {
  graph: AgentGraph;
  /** Live steps from useRunStream. Omit for a static document view. */
  steps?: Step[];
  /** Per-node metrics, normally computed client-side with rollup(). */
  analytics?: RunAnalytics | null;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  className?: string;
  /** Turns on drag, connect, and delete. Only the editor page sets this. */
  editable?: boolean;
  /** Fired once a drag ends -- not on every intermediate mouse move. */
  onMoveNode?: (nodeId: string, position: { x: number; y: number }) => void;
  onConnectNodes?: (source: string, target: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (edgeId: string) => void;
  /** Browser sessions this run opened. Omit in the editor. */
  browserSessions?: PanelSession[];
  /** Pending approvals, so a handoff can be resumed from inside the panel. */
  approvals?: Approval[];
  onResumeHandoff?: (approvalId: string) => void;
  resumeBusy?: boolean;
}

export function GraphCanvas({
  graph,
  steps,
  analytics,
  selectedNodeId,
  onSelectNode,
  className = 'h-[520px]',
  editable = false,
  onMoveNode,
  onConnectNodes,
  onDeleteNode,
  onDeleteEdge,
  browserSessions,
  approvals,
  onResumeHandoff,
  resumeBusy,
}: GraphCanvasProps) {
  const statuses = useMemo(() => statusByNode(steps ?? []), [steps]);

  /** Which session's panel is open. null = none, and that is the default. */
  const [watching, setWatching] = useState<string | null>(null);

  /**
   * A handoff parks a session and waits for a person. That pending approval is
   * matched to its session through the payload the handoff node wrote
   * (interpreter.ts), so the node can shout "your turn" rather than the person
   * having to find the approval panel further down the page.
   */
  const handoffBySession = useMemo(() => {
    const map = new Map<string, Approval>();
    for (const approval of approvals ?? []) {
      if (approval.status !== 'pending') continue;
      const action = approval.proposedAction;
      if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
      const sessionId = (action as Record<string, unknown>).sessionId;
      if (typeof sessionId === 'string') map.set(sessionId, approval);
    }
    return map;
  }, [approvals]);

  /** One session per node -- the most recent, when a node opened several. */
  const browserByNode = useMemo(() => {
    const map = new Map<string, NonNullable<NodeCardData['browser']>>();
    for (const session of browserSessions ?? []) {
      if (!session.nodeId) continue;
      map.set(session.nodeId, {
        sessionId: session.sessionId,
        host: hostOf(session.startUrl),
        live: !session.closedAt,
        awaitingHuman: handoffBySession.has(session.sessionId),
      });
    }
    return map;
  }, [browserSessions, handoffBySession]);

  const openSession = useMemo(
    () => (browserSessions ?? []).find((s) => s.sessionId === watching) ?? null,
    [browserSessions, watching],
  );

  /**
   * Open the panel on its own when a handoff starts waiting. The alternative is
   * a run that has silently stopped with the reason hidden one click away,
   * which is the single worst state this page can be in.
   */
  useEffect(() => {
    if (watching !== null) return;
    const waiting = (browserSessions ?? []).find((s) => handoffBySession.has(s.sessionId));
    if (waiting) setWatching(waiting.sessionId);
  }, [browserSessions, handoffBySession, watching]);

  const metricsByNode = useMemo(() => {
    const map = new Map<string, RunAnalytics['nodes'][number]>();
    for (const node of analytics?.nodes ?? []) map.set(node.nodeId, node);
    return map;
  }, [analytics]);

  const buildNodes = useCallback(
    (): Node<NodeCardData>[] =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'agentNode',
        position: node.position,
        draggable: editable,
        connectable: editable,
        data: {
          node,
          status: statuses.get(node.id),
          metrics: metricsByNode.get(node.id),
          selected: selectedNodeId === node.id,
          onOpen: onSelectNode,
          editable,
          onDelete: onDeleteNode,
          ...(browserByNode.get(node.id) ? { browser: browserByNode.get(node.id) } : {}),
          onWatchBrowser: setWatching,
        },
      })),
    [
      graph.nodes,
      statuses,
      metricsByNode,
      selectedNodeId,
      onSelectNode,
      editable,
      onDeleteNode,
      browserByNode,
    ],
  );

  // Local copy so a drag feels instant. Resynced whenever the graph document
  // itself changes underneath us (a save response, a chat edit landing, or a
  // different graph loading) -- see the file header for why this doesn't
  // fight an in-progress drag.
  const [rfNodes, setRfNodes] = useState<Node<NodeCardData>[]>(buildNodes);
  useEffect(() => {
    setRfNodes(buildNodes());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, statuses, metricsByNode, selectedNodeId, editable, browserByNode]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<NodeCardData>>[]) => {
      // Node removal goes through the explicit delete affordance only (see
      // NodeCard's "x") so it can be routed through the server's cascading
      // removeNode -- never let a stray keyboard gesture silently drop a node
      // from the canvas without also asking the server to drop its edges.
      const filtered = editable ? changes.filter((change) => change.type !== 'remove') : [];
      if (filtered.length > 0) setRfNodes((current) => applyNodeChanges(filtered, current));
    },
    [editable],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node<NodeCardData>) => {
      onMoveNode?.(node.id, node.position);
    },
    [onMoveNode],
  );

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      onConnectNodes?.(connection.source, connection.target);
    },
    [onConnectNodes],
  );

  const handleNodesDelete: OnNodesDelete<Node<NodeCardData>> = useCallback(
    (deleted) => {
      for (const node of deleted) onDeleteNode?.(node.id);
    },
    [onDeleteNode],
  );

  const handleEdgesDelete: OnEdgesDelete<Edge> = useCallback(
    (deleted) => {
      for (const edge of deleted) onDeleteEdge?.(edge.id);
    },
    [onDeleteEdge],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => {
        const targetStatus = statuses.get(edge.target);
        const sourceStatus = statuses.get(edge.source);
        // An edge animates only while the work it feeds is actually happening,
        // so motion on the canvas always means something is running right now.
        const active = targetStatus === 'running' || targetStatus === 'blocked';
        const traversed = sourceStatus === 'succeeded' && targetStatus !== undefined;
        const source = graph.nodes.find((n) => n.id === edge.source);

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: active,
          deletable: editable,
          // A branch edge is labelled with the option that selects it, so a
          // judge's two outgoing paths are self-explaining.
          label: edge.sourceHandle,
          // Theme tokens, not hexes: a fixed dark label box is a black slab on the light theme.
          labelStyle: { fill: 'var(--secondary)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--panel)' },
          style: {
            stroke: traversed
              ? source
                ? EXECUTOR_CLASSES[executorOf(source.type)].stroke
                : '#475569'
              : '#334155',
            strokeWidth: active ? 2 : 1.5,
            // A branch that was never taken stays faint rather than vanishing,
            // so you can see the path the run did NOT go down.
            opacity: steps && steps.length > 0 && !traversed && !active ? 0.35 : 1,
          },
        };
      }),
    [graph.edges, graph.nodes, statuses, steps, editable],
  );

  return (
    <div
      className={'relative w-full overflow-hidden rounded-lg border border-slate-800 ' + className}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        // Attribution stays visible: hiding it is reserved for React Flow Pro subscribers.
        attributionPosition="top-right"
        nodesConnectable={editable}
        nodesDraggable={editable}
        elementsSelectable={editable}
        deleteKeyCode={editable ? DELETE_KEYS : null}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        onNodeClick={(_event, node) => onSelectNode?.(node.id)}
        className="bg-slate-950"
      >
        <Background color="var(--line-3)" gap={16} />
        <Controls
          showInteractive={false}
          className="!bottom-2 !left-2 [&>button]:!border-slate-700 [&>button]:!bg-slate-800 [&>button]:!fill-slate-300"
        />
        <MiniMap
          pannable
          zoomable
          className="!bottom-2 !right-2 !bg-slate-900"
          maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
          nodeColor={(node) => {
            const data = node.data as NodeCardData;
            return EXECUTOR_CLASSES[executorOf(data.node.type)].stroke;
          }}
        />
      </ReactFlow>

      {/* Docked, not modal: the graph dims but stays on screen, so you never
          lose track of WHICH node this browser belongs to. See BrowserPanel. */}
      {openSession && (
        <ActionWorkspace
          key={openSession.sessionId}
          session={openSession}
          steps={(steps ?? []).filter((step) => step.nodeId === openSession.nodeId)}
          {...(handoffBySession.get(openSession.sessionId)
            ? { handoff: handoffBySession.get(openSession.sessionId) }
            : {})}
          {...(onResumeHandoff ? { onResume: onResumeHandoff } : {})}
          {...(resumeBusy !== undefined ? { busy: resumeBusy } : {})}
          onClose={() => setWatching(null)}
        />
      )}
    </div>
  );
}
