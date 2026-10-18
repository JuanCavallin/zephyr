/**
 * Turns the run's event stream (a RunView) into one chronological, human-readable
 * debug timeline. Pure: no React, no fetching, so it can be unit-checked and the
 * same entries feed both the panel and the "copy report" text.
 */

import type { Json, RunView, ToolLifecycleEvent } from '@htn/shared';

export type DebugKind =
  | 'run'
  | 'step'
  | 'routing'
  | 'decision'
  | 'model'
  | 'tool'
  | 'harness'
  | 'approval'
  | 'browser'
  | 'provider'
  | 'log';

export type DebugLevel = 'ok' | 'info' | 'pending' | 'warn' | 'error';

export interface DebugEntry {
  id: string;
  /** Epoch ms; entries are sorted by it. */
  at: number;
  kind: DebugKind;
  level: DebugLevel;
  title: string;
  /** One line shown collapsed. */
  summary?: string;
  /** Shown when the row is expanded. Long values render in a scrollable block. */
  details: { label: string; value: string }[];
  /** Step this belongs to, so the panel can scope to the selected graph node. */
  stepId?: string;
  nodeId?: string;
}

export const KIND_LABEL: Record<DebugKind, string> = {
  run: 'Run',
  step: 'Step',
  routing: 'Routing',
  decision: 'Decision',
  model: 'Model call',
  tool: 'Tool',
  harness: 'Agent turn',
  approval: 'Approval',
  browser: 'Browser',
  provider: 'Provider',
  log: 'Log',
};

const ms = (iso: string | undefined): number => (iso ? new Date(iso).getTime() : Date.now());

function pretty(value: unknown, max = 4000): string {
  if (value === undefined) return '';
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length <= max ? text : text.slice(0, max) + '\n… [+' + (text.length - max) + ' chars]';
}

function detail(label: string, value: unknown): { label: string; value: string }[] {
  const text = pretty(value);
  return text ? [{ label, value: text }] : [];
}

const seconds = (latencyMs: number | undefined): string =>
  latencyMs === undefined
    ? ''
    : latencyMs < 1000
      ? Math.round(latencyMs) + 'ms'
      : (latencyMs / 1000).toFixed(1) + 's';

export function buildDebugEntries(view: RunView): DebugEntry[] {
  const out: DebugEntry[] = [];
  const stepNode = new Map(view.steps.map((step) => [step.id, step.nodeId]));
  const push = (entry: Omit<DebugEntry, 'nodeId'>) =>
    out.push({ ...entry, nodeId: entry.stepId ? stepNode.get(entry.stepId) : undefined });

  // --- run ------------------------------------------------------------------
  if (view.run) {
    const run = view.run;
    push({
      id: 'run:created',
      at: ms(run.createdAt),
      kind: 'run',
      level: 'info',
      title: 'Run created: ' + run.title,
      details: [...detail('input', run.input), { label: 'run id', value: run.id }],
    });
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      push({
        id: 'run:final',
        at: ms(run.updatedAt),
        kind: 'run',
        level: run.status === 'succeeded' ? 'ok' : 'error',
        title: 'Run ' + run.status,
        summary: run.error ? run.error.code + ': ' + run.error.message : run.summary,
        details: [
          ...detail('error', run.error),
          ...detail('summary', run.summary),
          ...detail('result', run.result),
        ],
      });
    }
  }

  // --- steps ----------------------------------------------------------------
  for (const step of view.steps) {
    const label = step.label + (step.providerId ? ' · ' + step.providerId : '');
    if (step.startedAt) {
      push({
        id: 'step:start:' + step.id,
        at: ms(step.startedAt),
        kind: 'step',
        level: 'info',
        title: 'Step started: ' + label,
        stepId: step.id,
        details: [
          { label: 'kind', value: step.kind },
          ...(step.nodeId ? [{ label: 'graph node', value: step.nodeId }] : []),
          ...detail('input', step.input),
        ],
      });
    }
    const terminal = ['succeeded', 'failed', 'skipped'].includes(step.status);
    const level: DebugLevel =
      step.status === 'failed'
        ? 'error'
        : step.status === 'succeeded'
          ? 'ok'
          : step.status === 'blocked'
            ? 'warn'
            : step.status === 'running'
              ? 'pending'
              : 'info';
    push({
      id: 'step:end:' + step.id,
      at: terminal ? ms(step.endedAt ?? step.startedAt) : ms(step.startedAt) + 1,
      kind: 'step',
      level,
      title: 'Step ' + step.status + ': ' + label,
      summary: step.error ? step.error.code + ': ' + step.error.message : undefined,
      stepId: step.id,
      details: [
        ...(step.startedAt
          ? [
              {
                label: 'duration',
                value: seconds((step.endedAt ? ms(step.endedAt) : Date.now()) - ms(step.startedAt)),
              },
            ]
          : []),
        ...detail('error', step.error),
        ...detail('output', step.output as Json | undefined),
      ],
    });
  }

  // --- routing (which tools / model tier the agent was granted) --------------
  for (const d of view.scheduleDecisions) {
    const noTools = d.availableTools.length > 0 && d.exposedTools.length === 0;
    push({
      id: 'route:' + d.id,
      at: ms(d.at),
      kind: 'routing',
      level: noTools ? 'warn' : 'info',
      title: 'Routing: ' + d.privacy + ' / ' + d.intelligence + ' → ' + d.modelTier + ' tier',
      summary: noTools
        ? 'NO tools granted out of ' + d.availableTools.length + ' available (rule: ' + d.rule + ')'
        : d.exposedTools.length + ' of ' + d.availableTools.length + ' tools granted',
      stepId: d.stepId,
      details: [
        { label: 'rule', value: d.rule },
        {
          label: 'confidence',
          value:
            'privacy ' +
            d.privacyConfidence.toFixed(2) +
            ', intelligence ' +
            d.intelligenceConfidence.toFixed(2) +
            ', overall ' +
            d.confidence.toFixed(2),
        },
        { label: 'available tools', value: d.availableTools.join(', ') || '(none)' },
        { label: 'granted tools', value: d.exposedTools.join(', ') || '(none)' },
        ...(d.escalated ? [{ label: 'escalated', value: d.escalationReason ?? 'yes' }] : []),
      ],
    });
  }

  // --- control decisions (Jev) -------------------------------------------------
  for (const d of view.controlDecisions) {
    const weak = d.confidence < 0.7;
    push({
      id: 'decision:' + d.id,
      at: ms(d.at),
      kind: 'decision',
      level: d.source === 'fallback' || weak ? 'warn' : 'info',
      title:
        d.operation.replace(/_/g, ' ') +
        ' → ' +
        (d.selectedIds.length ? d.selectedIds.join(', ') : '(nothing)'),
      summary:
        'confidence ' +
        d.confidence.toFixed(2) +
        (weak ? ' (below 0.70)' : '') +
        ' · source ' +
        d.source,
      stepId: d.stepId,
      details: [
        { label: 'candidates', value: d.candidateIds.join(', ') || '(none)' },
        { label: 'selected', value: d.selectedIds.join(', ') || '(none)' },
        { label: 'reason codes', value: d.reasonCodes.join(', ') || '(none)' },
        { label: 'source', value: d.source },
      ],
    });
  }

  // --- model calls: one row per call, merged across requested/completed/failed ---
  const calls = new Map<string, typeof view.modelCalls>();
  for (const event of view.modelCalls) {
    calls.set(event.modelCallId, [...(calls.get(event.modelCallId) ?? []), event]);
  }
  const failuresPerStep = new Map<string, number>();
  const orderedCalls = [...calls.values()].sort((a, b) => ms(a[0]!.at) - ms(b[0]!.at));
  for (const events of orderedCalls) {
    const requested = events.find((event) => event.phase === 'requested');
    const finished = events.find((event) => event.phase !== 'requested');
    const first = requested ?? events[0]!;
    const last = finished ?? first;
    const stepKey = first.stepId ?? '';
    const priorFailures = failuresPerStep.get(stepKey) ?? 0;
    if (last.phase === 'failed') failuresPerStep.set(stepKey, priorFailures + 1);
    else if (last.phase === 'completed') failuresPerStep.set(stepKey, 0);
    const model = last.actualModelId ?? first.configuredModelId;
    const phase = last.phase === 'requested' ? 'in flight' : last.phase;
    push({
      id: 'model:' + first.modelCallId,
      at: ms(first.at),
      kind: 'model',
      level: last.phase === 'failed' ? 'error' : last.phase === 'completed' ? 'ok' : 'pending',
      title:
        'Model call ' +
        phase +
        ': ' +
        first.providerId +
        ' / ' +
        model +
        (priorFailures > 0 ? '  ↻ retry #' + priorFailures : ''),
      summary: last.error
        ? last.error.code + ': ' + last.error.message
        : [
            seconds(last.latencyMs),
            last.tokensIn !== undefined ? last.tokensIn + ' in / ' + (last.tokensOut ?? 0) + ' out tokens' : '',
            last.toolCallCount ? last.toolCallCount + ' tool call(s) proposed' : '',
          ]
            .filter(Boolean)
            .join(' · '),
      stepId: first.stepId,
      details: [
        { label: 'route', value: first.routeId },
        { label: 'messages in', value: String(first.messageCount) },
        { label: 'data labels', value: first.dataLabels.join(', ') || '(none)' },
        { label: 'tools offered', value: first.selectedToolIds.join(', ') || '(none)' },
        ...(last.estimatedCostCents !== undefined
          ? [{ label: 'est. cost', value: last.estimatedCostCents.toFixed(3) + '¢' }]
          : []),
        ...(last.ioWithheld || first.ioWithheld
          ? [
              {
                label: 'input / output',
                value: 'Withheld: this session carries non-public data labels.',
              },
            ]
          : []),
        ...detail('INPUT', last.inputPreview ?? first.inputPreview),
        ...detail('OUTPUT', last.outputPreview),
        ...detail('error', last.error),
      ],
    });
  }

  // --- tool actions: one row per action, with its whole phase trail ------------
  const actions = new Map<string, ToolLifecycleEvent[]>();
  for (const event of view.toolLifecycle) {
    actions.set(event.action.id, [...(actions.get(event.action.id) ?? []), event]);
  }
  for (const events of actions.values()) {
    const sorted = [...events].sort((a, b) => ms(a.at) - ms(b.at));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const authorized = [...sorted].reverse().find((event) => event.authorization)?.authorization;
    const level: DebugLevel =
      last.phase === 'failed'
        ? 'error'
        : last.phase === 'blocked'
          ? 'warn'
          : last.phase === 'succeeded'
            ? 'ok'
            : last.phase === 'awaiting_approval'
              ? 'warn'
              : 'pending';
    const outputSummary = sorted.map((event) => event.outputSummary).findLast(Boolean);
    const error = sorted.map((event) => event.error).findLast(Boolean);
    push({
      id: 'tool:' + first.action.id,
      at: ms(first.at),
      kind: 'tool',
      level,
      title: 'Tool ' + last.phase.replace(/_/g, ' ') + ': ' + first.action.toolId,
      summary: error
        ? error.code + ': ' + error.message
        : (outputSummary ?? '').slice(0, 160) || undefined,
      stepId: first.stepId,
      details: [
        { label: 'operation', value: first.action.operation },
        ...detail('arguments', first.action.arguments),
        ...(first.action.destination ? [{ label: 'destination', value: first.action.destination }] : []),
        ...(authorized
          ? [
              {
                label: 'authorization',
                value:
                  (authorized.allowed ? 'allowed' : 'denied') +
                  ' · policy ' +
                  authorized.finalPolicy +
                  ' · Jev suggested ' +
                  authorized.recommendation.policy +
                  ' (' +
                  authorized.recommendation.confidence.toFixed(2) +
                  ') · ' +
                  authorized.reasonCodes.join(', '),
              },
            ]
          : []),
        {
          label: 'phases',
          value: sorted
            .map(
              (event) =>
                new Date(event.at).toISOString().slice(11, 23) + '  ' + event.phase,
            )
            .join('\n'),
        },
        ...detail('output', outputSummary),
        ...detail('error', error),
        ...(last.outcome ? [{ label: 'outcome', value: last.outcome }] : []),
      ],
    });
  }

  // --- harness turns -------------------------------------------------------------
  for (const turn of view.harnessTurns) {
    push({
      id: 'turn:' + turn.id,
      at: ms(turn.at),
      kind: 'harness',
      level: turn.phase === 'failed' ? 'error' : turn.phase === 'cancelled' ? 'warn' : 'info',
      title: 'Agent turn ' + turn.phase.replace(/_/g, ' '),
      details: [{ label: 'turn id', value: turn.turnId }, ...detail('payload', turn.payload)],
    });
  }

  // --- approvals -----------------------------------------------------------------
  for (const approval of view.approvals) {
    push({
      id: 'approval:' + approval.id,
      at: ms(approval.status === 'pending' ? approval.createdAt : (approval.decidedAt ?? approval.createdAt)),
      kind: 'approval',
      level: approval.status === 'pending' ? 'warn' : approval.status === 'rejected' ? 'warn' : 'ok',
      title: 'Approval ' + approval.status + ': ' + approval.question,
      stepId: approval.stepId,
      details: [
        { label: 'rule', value: approval.policyRule },
        { label: 'risk', value: approval.riskClass + ' / ' + approval.reversibility },
        ...detail('proposed action', approval.proposedAction),
        ...detail('revised action', approval.revisedAction),
      ],
    });
  }

  // --- browser sessions ----------------------------------------------------------
  for (const session of view.browserSessions) {
    push({
      id: 'browser:' + session.sessionId,
      at: ms(session.closedAt ?? session.openedAt),
      kind: 'browser',
      level: 'info',
      title: (session.closedAt ? 'Browser session closed: ' : 'Browser session open: ') + session.providerId,
      stepId: session.stepId,
      details: [
        { label: 'session', value: session.sessionId },
        ...(session.mode ? [{ label: 'mode', value: session.mode }] : []),
      ],
    });
  }

  // --- provider egress (every outbound call; polling is noise and skipped) -----------
  for (const egress of view.egress) {
    if (egress.op === 'pollTask') continue;
    push({
      id: 'egress:' + egress.id,
      at: ms(egress.at),
      kind: 'provider',
      level: egress.decision === 'blocked' ? 'error' : egress.decision === 'redacted' ? 'warn' : 'info',
      title: egress.providerId + '.' + egress.op,
      summary: [
        seconds(egress.latencyMs),
        egress.decision,
        egress.dataSpans.length ? egress.dataSpans.length + ' span(s) redacted' : 'no user data',
      ]
        .filter(Boolean)
        .join(' · '),
      stepId: egress.stepId,
      details: [
        { label: 'destination', value: egress.destination },
        { label: 'allowed by', value: egress.policyRule },
        ...(egress.model ? [{ label: 'model', value: egress.model }] : []),
        ...(egress.tokensIn !== undefined
          ? [{ label: 'tokens', value: egress.tokensIn + ' in / ' + (egress.tokensOut ?? 0) + ' out' }]
          : []),
      ],
    });
  }

  // --- free-form logs --------------------------------------------------------------------
  view.logs.forEach((log, index) => {
    push({
      id: 'log:' + index,
      at: ms(log.at),
      kind: 'log',
      level: log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'info',
      title: log.message.length > 140 ? log.message.slice(0, 140) + '…' : log.message,
      details: log.message.length > 140 ? [{ label: 'message', value: log.message }] : [],
    });
  });

  return out.sort((a, b) => a.at - b.at);
}

/** Plain text of the whole timeline, for pasting into a bug report or chat. */
export function debugReport(entries: DebugEntry[], runStart: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const t = ((entry.at - runStart) / 1000).toFixed(1).padStart(7);
    lines.push(
      `${t}s  ${entry.level.toUpperCase().padEnd(7)} ${KIND_LABEL[entry.kind].padEnd(10)} ${entry.title}`,
    );
    if (entry.summary) lines.push('           ' + entry.summary);
    for (const item of entry.details) {
      lines.push('           ' + item.label + ':');
      for (const row of item.value.split('\n')) lines.push('             ' + row);
    }
  }
  return lines.join('\n');
}
