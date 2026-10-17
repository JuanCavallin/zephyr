/**
 * The graph page: describe a workflow, see its shape, edit it, run it.
 *
 * Chat and canvas sit side by side on purpose. The chat produces a DOCUMENT,
 * not a run -- you read what it built, and only then launch it. That gap is the
 * product; a prompt box that immediately executes would be a different (and
 * less defensible) thing.
 *
 * Phase 4: the canvas is directly editable here (drag, connect, delete) and
 * the node panel is a real typed form (NodeInspector) instead of a read-only
 * JSON dump. Chat and canvas both mutate the same document, so every canvas
 * mutation carries `graph.version` -- see the mutation error banner below for
 * what happens when they race.
 */

import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  AgentGraph,
  Conversation,
  GraphCritique,
  GraphEdge,
  GraphNodeType,
  Run,
} from '@htn/shared';
import { GRAPH_NODE_TYPES, isTerminal } from '@htn/shared';
import { useGraph, useGraphs } from '../hooks/useGraph';
import { useTools } from '../hooks/useTools';
import { api, ApiError } from '../lib/api';
import { newClientId } from '../lib/ids';
import { ChatPanel } from '../components/chat/ChatPanel';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { Legend } from '../components/graph/Legend';
import { NodeInspector } from '../components/graph/NodeInspector';
import { ReusePanel } from '../components/graph/ReusePanel';
import { buildDefaultNode, defaultLabelFor } from '../components/graph/nodeDefaults';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

export function GraphEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Set only when this graph was just opened as an optimisation proposal.
  const proposal = (
    useLocation().state as {
      proposal?: {
        sourceId: string;
        sourceName: string;
        critique: GraphCritique;
        suggestedAssertions: number;
      };
    } | null
  )?.proposal;
  const { graphs, refresh: refreshGraphs, error: graphListError } = useGraphs();
  const { graph: loaded, refresh: refreshGraph } = useGraph(id ?? undefined);
  const { tools } = useTools();

  // The chat can replace the graph under us, so the displayed document is local
  // state seeded from whatever was loaded.
  const [graph, setGraph] = useState<AgentGraph | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [launching, setLaunching] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addType, setAddType] = useState<GraphNodeType>('tool');
  // Chat and the canvas both mutate the same document -- a 409 here means the
  // other one won -- see mutateGraph's optimistic-concurrency check.
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Synthesis reads the graph's version once, before a multi-second model
  // call, then writes back afterward. A canvas edit inside that window can't
  // be merged into a rewrite the model already computed without seeing it --
  // so canvas mutation is locked for the duration rather than raced against.
  const [chatBusy, setChatBusy] = useState(false);
  const [previousGraphRun, setPreviousGraphRun] = useState<Run | null>(null);
  const [loadingPreviousRun, setLoadingPreviousRun] = useState(false);

  useEffect(() => {
    if (loaded) setGraph(loaded);
  }, [loaded]);

  useEffect(() => {
    if (!graph?.id) {
      setPreviousGraphRun(null);
      return;
    }
    let active = true;
    setLoadingPreviousRun(true);
    void api
      .listRuns({ graphId: graph.id, kind: 'graph', limit: 30 })
      .then(({ runs }) => {
        if (active) setPreviousGraphRun(runs.find((run) => isTerminal(run.status)) ?? null);
      })
      .catch(() => {
        if (active) setPreviousGraphRun(null);
      })
      .finally(() => {
        if (active) setLoadingPreviousRun(false);
      });
    return () => {
      active = false;
    };
  }, [graph?.id]);

  // With no graph in the URL, show the most recent one so the canvas is not
  // empty while the chat is still untouched.
  useEffect(() => {
    if (!id && !graph && graphs.length > 0) setGraph(graphs[0] as AgentGraph);
  }, [id, graph, graphs]);

  // A DELIBERATE navigation to a different graph (the dropdown, or a link from
  // elsewhere) must drop any active conversation. Without this, an existing
  // conversation keeps the `graphId` it was seeded with, and a message typed
  // after switching would silently edit the graph you navigated AWAY from
  // while the canvas shows the one you switched TO. This does not fire when
  // the chat itself updates `graph` in place -- only when the URL's :id changes.
  useEffect(() => {
    setConversation(null);
  }, [id]);

  const DEMO_TARGET = 'ACME-2026-TERM-FEES';

  const launch = async () => {
    if (!graph) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const { run } = await api.runGraph(graph.id, { target: DEMO_TARGET });
      navigate('/runs/' + run.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  /**
   * Ask for an improved version of this workflow, based on its own run history. The
   * proposal is a separate graph, opened for review -- it never runs, and never replaces
   * this one, on its own. The critique travels in router state so the fork can say WHY.
   */
  const suggestImprovement = async () => {
    if (!graph) return;
    setOptimizing(true);
    setLaunchError(null);
    try {
      const result = await api.optimizeGraph(graph.id);
      navigate('/graphs/' + result.graph.id, {
        state: {
          proposal: {
            sourceId: graph.id,
            sourceName: graph.name,
            critique: result.critique,
            suggestedAssertions: result.suggestedAssertions.length,
          },
        },
      });
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setOptimizing(false);
    }
  };

  /**
   * Launch the graph next to its baseline(s) on THE SAME TASK: the server
   * hands each baseline the graph's own prompt and variables. A shared pairId
   * lets the Benchmarks page pair these runs exactly.
   *
   * withAgent adds B1 -- one frontier agent with every tool -- which is the
   * fair "no orchestration" control but a real, full agent run, so it is opt-in.
   */
  const launchWithBaseline = async (withAgent = false) => {
    if (!graph) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const variables = { target: DEMO_TARGET };
      const pairId = 'pair_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const baselineInput = { graphId: graph.id, variables, pairId };
      // Every POST fires before any is awaited -- genuinely parallel -- so no
      // arm's latency adds to another's.
      const [{ run: graphRun }, { run: baselineRun }, agentRun] = await Promise.all([
        api.runGraph(graph.id, variables, pairId),
        api.createRun('baseline', baselineInput),
        withAgent ? api.createRun('baseline_agent', baselineInput) : Promise.resolve(null),
      ]);
      navigate(
        '/compare?a=' +
          graphRun.id +
          '&b=' +
          baselineRun.id +
          (agentRun ? '&c=' + agentRun.run.id : ''),
      );
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const launchAgainstPrevious = async () => {
    if (!graph || !previousGraphRun) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const { run } = await api.runGraph(graph.id, { target: DEMO_TARGET });
      navigate('/compare?a=' + run.id + '&b=' + previousGraphRun.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  // Explicit, so it never gets confused with "no :id in the URL yet" -- that
  // case defaults to the most recent task (see the effect above) rather than
  // starting a blank one. This is the only path that intentionally wants blank.
  const startNewTask = async () => {
    setCreating(true);
    setLaunchError(null);
    try {
      const { graph: created } = await api.createGraph({});
      await refreshGraphs();
      navigate('/graphs/' + created.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  function reportMutationError(err: unknown) {
    setMutationError(err instanceof Error ? err.message : String(err));
  }

  const addNode = async () => {
    if (!graph) return;
    // A loose grid so a run of adds doesn't stack nodes exactly on top of
    // each other; the user drags from here into whatever shape they want.
    const position = {
      x: 80 + (graph.nodes.length % 4) * 220,
      y: 80 + Math.floor(graph.nodes.length / 4) * 140,
    };
    const node = buildDefaultNode(
      addType,
      position,
      tools.map((t) => t.name),
    );
    try {
      const { graph: next } = await api.addNode(graph.id, node, graph.version);
      setGraph(next);
      setSelectedNodeId(node.id);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
    }
  };

  const moveNode = async (nodeId: string, position: { x: number; y: number }) => {
    if (!graph) return;
    try {
      const { graph: next } = await api.patchNode(graph.id, nodeId, { position }, graph.version);
      setGraph(next);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
      // The dragged position is already showing locally; pull the server's
      // truth back down rather than leaving the canvas out of sync with it.
      void refreshGraph();
    }
  };

  const connectNodes = async (source: string, target: string) => {
    if (!graph) return;
    const edge: GraphEdge = { id: newClientId('edge'), source, target };
    try {
      const { graph: next } = await api.addEdge(graph.id, edge, graph.version);
      setGraph(next);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
    }
  };

  const deleteNode = async (nodeId: string) => {
    if (!graph) return;
    try {
      const { graph: next } = await api.removeNode(graph.id, nodeId, graph.version);
      setGraph(next);
      if (selectedNodeId === nodeId) setSelectedNodeId(undefined);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
    }
  };

  const deleteEdge = async (edgeId: string) => {
    if (!graph) return;
    try {
      const { graph: next } = await api.removeEdge(graph.id, edgeId, graph.version);
      setGraph(next);
      setMutationError(null);
    } catch (err) {
      // Deleting a node cascades to its edges server-side. Selecting a node
      // and pressing delete fires both this and deleteNode for the same
      // gesture, so the edge side of that race landing a 409 (the node's
      // delete already bumped the version and dropped the edge) is the
      // expected outcome, not a real conflict -- nothing to show for it.
      if (err instanceof ApiError && err.status === 409) return;
      reportMutationError(err);
    }
  };

  const selected = graph?.nodes.find((n) => n.id === selectedNodeId);

  return (
    <div className="editor-workspace space-y-5">
      <div className="editor-toolbar flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-100">{graph?.name ?? 'New workflow'}</h1>
        {graph && <Badge tone="muted">v{graph.version}</Badge>}
        {graph && <Badge tone="muted">{graph.nodes.length} nodes</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {graphs.length > 0 && (
            <select
              value={graph?.id ?? ''}
              onChange={(event) => navigate('/graphs/' + event.target.value)}
              title="Switch task"
              className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
            >
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <Button variant="ghost" onClick={() => void startNewTask()} disabled={creating}>
            {creating ? 'Creating…' : '+ New task'}
          </Button>
          {graph && (
            <>
              <select
                value={addType}
                onChange={(event) => setAddType(event.target.value as GraphNodeType)}
                className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
              >
                {GRAPH_NODE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {defaultLabelFor(type)}
                  </option>
                ))}
              </select>
              <Button variant="ghost" onClick={() => void addNode()} disabled={chatBusy}>
                + Add node
              </Button>
            </>
          )}
          <Button onClick={() => void launch()} disabled={launching || !graph}>
            {launching ? 'Starting…' : 'Run graph'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void launchWithBaseline()}
            disabled={launching || !graph}
            title="Also send this workflow's own task to one frontier model call (no tools)"
          >
            Run + compare to baseline
          </Button>
          <Button
            variant="ghost"
            onClick={() => void launchWithBaseline(true)}
            disabled={launching || !graph}
            title="Also run the task as one frontier agent with every tool and no Jev routing -- a full agent run, so it costs real money in live mode"
          >
            Run + compare to both baselines
          </Button>
          <Button
            variant="ghost"
            onClick={() => void launchAgainstPrevious()}
            disabled={launching || !graph || !previousGraphRun || loadingPreviousRun}
            title={
              previousGraphRun
                ? 'Compare this run with the latest terminal run of this graph'
                : 'Run this graph once before comparing with a previous run'
            }
          >
            {loadingPreviousRun ? 'Finding previous run…' : 'Run + compare to previous'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void suggestImprovement()}
            disabled={optimizing || launching || chatBusy || !graph}
            title="Critique this workflow's own runs and propose an improved copy to review"
          >
            {optimizing ? 'Analysing runs…' : 'Suggest an improvement'}
          </Button>
        </div>
      </div>

      {graphListError && (
        <div className="notice editor-offline" role="status">
          The workflow API is unavailable. Start the backend to load or edit saved workflows.{' '}
          <button className="text-link" onClick={() => void refreshGraphs()}>
            Try again
          </button>
        </div>
      )}
      {proposal && (
        <div className="notice" role="status">
          <strong>Proposed improvement</strong> of{' '}
          <button className="text-link" onClick={() => navigate('/graphs/' + proposal.sourceId)}>
            {proposal.sourceName}
          </button>
          , from {proposal.critique.runsAnalyzed} past run
          {proposal.critique.runsAnalyzed === 1 ? '' : 's'}:{' '}
          {proposal.critique.assertionFailures.length} failing check(s),{' '}
          {proposal.critique.costOutliers.length} cost outlier(s),{' '}
          {proposal.critique.latencyOutliers.length} latency outlier(s),{' '}
          {proposal.critique.toolDivergenceOutliers.length} tool-selection outlier(s).{' '}
          {proposal.critique.lowConfidence &&
            'Low confidence: fewer than 3 runs, so treat this as a hint. '}
          {proposal.suggestedAssertions > 0 &&
            proposal.suggestedAssertions +
              ' new success check(s) were suggested and NOT applied: a proposal may not grade itself. '}
          Nothing has run. The original workflow is unchanged.
        </div>
      )}
      {graph?.description && <p className="text-sm text-slate-400">{graph.description}</p>}
      {launchError && <p className="text-xs text-rose-400">{launchError}</p>}
      {chatBusy && (
        <p className="text-xs text-sky-400">
          Chat is rewriting this graph — canvas editing is locked until it replies.
        </p>
      )}
      {mutationError && (
        <p className="text-xs text-rose-400">
          {mutationError}{' '}
          <button
            type="button"
            onClick={() => {
              setMutationError(null);
              void refreshGraph();
            }}
            className="underline underline-offset-2 hover:text-rose-300"
          >
            reload graph
          </button>
        </p>
      )}

      <div className="editor-layout">
        <ChatPanel
          conversation={conversation}
          graphId={graph?.id}
          onConversation={setConversation}
          onGraph={(next) => {
            setGraph(next);
            setSelectedNodeId(undefined);
            setMutationError(null);
            void refreshGraphs();
          }}
          onBusyChange={setChatBusy}
          className="h-[560px]"
        />

        {graph ? (
          <GraphCanvas
            graph={graph}
            editable={!chatBusy}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onMoveNode={(nodeId, position) => void moveNode(nodeId, position)}
            onConnectNodes={(source, target) => void connectNodes(source, target)}
            onDeleteNode={(nodeId) => void deleteNode(nodeId)}
            onDeleteEdge={(edgeId) => void deleteEdge(edgeId)}
            className="h-[560px]"
          />
        ) : (
          <div className="flex h-[560px] items-center justify-center rounded-lg border border-dashed border-slate-800 text-sm text-slate-600">
            Describe a workflow to build one.
          </div>
        )}
      </div>

      <Legend />

      <Card title={selected ? 'Node: ' + selected.label : 'Select a node'}>
        {chatBusy ? (
          <p className="text-sm text-slate-500">
            Chat is rewriting this graph. The inspector reopens once it replies.
          </p>
        ) : selected && graph ? (
          <NodeInspector
            // Every field below is an uncontrolled input seeded via
            // defaultValue -- remount on node switch so it doesn't keep
            // showing the previously-selected node's typed-but-unblurred text.
            key={selected.id}
            graph={graph}
            node={selected}
            tools={tools}
            onPatched={(next) => {
              setGraph(next);
              setMutationError(null);
            }}
            onDeleted={(next) => {
              setGraph(next);
              setSelectedNodeId(undefined);
              setMutationError(null);
            }}
            onError={reportMutationError}
          />
        ) : (
          <p className="text-sm text-slate-500">
            Click a node to edit it, drag to reposition, or drag from its bottom handle to a target
            node to connect them.
          </p>
        )}
      </Card>

      {graph && <ReusePanel graph={graph} selectedNodeId={selectedNodeId} />}
    </div>
  );
}
