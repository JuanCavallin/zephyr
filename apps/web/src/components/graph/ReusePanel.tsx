import { useEffect, useState } from 'react';
import type { AgentGraph, GraphReuseReport } from '@htn/shared';
import { api } from '../../lib/api';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

/**
 * How much of this graph's decision-making recent runs reused instead of
 * asking Jev again: frozen routes and dispatch choices, and remembered
 * browser targets. Also flags remembered pages that stopped matching and
 * sites that block automated reads.
 */
export function ReusePanel({
  graph,
  selectedNodeId,
}: {
  graph: AgentGraph;
  selectedNodeId?: string;
}) {
  const [report, setReport] = useState<GraphReuseReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .graphReuse(graph.id)
      .then((next) => {
        if (active) {
          setReport(next);
          setError(null);
        }
      })
      .catch((issue: unknown) => {
        if (active) setError(issue instanceof Error ? issue.message : 'Could not load reuse.');
      });
    return () => {
      active = false;
    };
    // A save can freeze or drop decisions, so refetch on every version.
  }, [graph.id, graph.version]);

  if (error) return null;
  if (!report) return null;

  const rows = graph.nodes
    .map((node) => ({ node, reuse: report.nodes[node.id] }))
    .filter(
      ({ reuse }) => reuse && (reuse.compiled || reuse.runs > 0 || reuse.remembered.entries > 0),
    );
  const { totals } = report;
  const decisions = totals.frozenDecisions + totals.liveDecisions;
  const targets = totals.rememberedTargets + totals.decidedTargets;

  return (
    <Card title="Reuse">
      <p className="text-xs text-slate-400">
        Last {report.runs} run{report.runs === 1 ? '' : 's'}: {report.warmRuns} warm, median{' '}
        {Math.round(report.medianJevCalls)} Jev call{report.medianJevCalls === 1 ? '' : 's'} per
        run.
        {decisions > 0 &&
          ' ' + totals.frozenDecisions + ' of ' + decisions + ' routing decisions frozen.'}
        {targets > 0 &&
          ' ' + totals.rememberedTargets + ' of ' + targets + ' browser targets remembered.'}
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          Nothing frozen or remembered yet. Saving compiles agent routes and fixed dispatch choices;
          browser targets are remembered after a run visits a public page.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-xs">
          {rows.map(({ node, reuse }) => (
            <li
              key={node.id}
              className={
                'flex flex-wrap items-center gap-2 ' +
                (node.id === selectedNodeId ? 'text-slate-100' : 'text-slate-300')
              }
            >
              <span className="font-medium">{node.label}</span>
              {reuse!.compiled && (
                <Badge tone="accent">
                  {reuse!.compiled.kind === 'agent_route' ? 'route' : 'choice'} frozen
                  {reuse!.compiled.source === 'run' ? ' (learned)' : ''}
                </Badge>
              )}
              {reuse!.frozenDecisions + reuse!.liveDecisions > 0 && (
                <span>
                  {reuse!.frozenDecisions}/{reuse!.frozenDecisions + reuse!.liveDecisions} decisions
                  reused
                </span>
              )}
              {reuse!.remembered.entries > 0 && (
                <span>
                  {reuse!.remembered.entries} target{reuse!.remembered.entries === 1 ? '' : 's'}{' '}
                  remembered, {reuse!.remembered.hits} hit{reuse!.remembered.hits === 1 ? '' : 's'}
                  {reuse!.remembered.corrected > 0 &&
                    ', ' + reuse!.remembered.corrected + ' corrected by you'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {report.alerts.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Site alerts">
          {report.alerts.map((alert) => (
            <li
              key={alert.kind + alert.origin + (alert.pathTemplate ?? '')}
              className="text-amber-300"
            >
              <Badge tone="warn">
                {alert.kind === 'site_changed' ? 'page changed?' : 'blocks automation'}
              </Badge>{' '}
              {alert.origin}
              {alert.pathTemplate ?? ''}: {alert.detail}
            </li>
          ))}
        </ul>
      )}
      {report.promotions.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Promotion suggestions">
          {report.promotions.map((promotion) => (
            <li key={promotion.nodeId} className="text-sky-300">
              <Badge tone="accent">could be fixed steps</Badge>{' '}
              {graph.nodes.find((node) => node.id === promotion.nodeId)?.label ?? promotion.nodeId}{' '}
              did the same thing in its last {promotion.runs} verified runs:{' '}
              {promotion.tools.join(' → ')}
              {promotion.stableArguments ? ', same arguments' : ''}. “Suggest an improvement”
              proposes the change as a separate graph for review.
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
