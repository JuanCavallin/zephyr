/**
 * The SSE wire format AND the frontend reducer's input. One union, one reducer.
 *
 * Adding a new event type is safe: the client reducer's `default` case ignores
 * anything it doesn't recognise, so an older tab never breaks on a newer server.
 */

import { z } from 'zod';
import type { BrowserSessionRecord } from './browser.js';
import { CODING_EVENT_TYPES, codingEventSchema, type CodingEvent } from './coding.js';
import type { Approval, EgressEvent, Iso, PiiSpan, Run, Step } from './domain.js';
import type {
  AgentSessionState,
  ControlDecisionRecord,
  HarnessTurnEvent,
  ModelLifecycleEvent,
  ToolLifecycleEvent,
} from './control.js';
import type { ScheduleDecision } from './scheduling.js';

export type RunEvent =
  | { type: 'run.updated'; run: Run }
  | { type: 'step.upserted'; step: Step }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'egress.logged'; egress: EgressEvent }
  | { type: 'pii.detected'; span: PiiSpan }
  | { type: 'schedule.decided'; decision: ScheduleDecision }
  /**
   * A browser session became watchable. Announced on the stream rather than
   * carried on a step because the opening node is often not the node you want
   * to watch — see BrowserSessionRecord for the full reasoning.
   */
  | { type: 'browser.session.opened'; session: BrowserSessionRecord }
  /**
   * The session was released. The UI must stop showing its live view as live:
   * Browserbase's debug URL returns 410 Gone from this moment, so a viewer
   * left pointed at it renders an error rather than a page.
   */
  | { type: 'browser.session.closed'; runId: string; sessionId: string; at: Iso }
  | { type: 'control.decided'; decision: ControlDecisionRecord }
  | { type: 'model.lifecycle'; lifecycle: ModelLifecycleEvent }
  | { type: 'harness.turn'; turn: HarnessTurnEvent }
  | { type: 'tool.lifecycle'; lifecycle: ToolLifecycleEvent }
  | { type: 'session.updated'; session: AgentSessionState }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string; at: Iso }
  /** Coding-agent control plane: task.*, lease.*, learning.*, harness.turn.ended. See coding.ts. */
  | CodingEvent;

export type RunEventType = RunEvent['type'];

/**
 * Event types that predate the zod contracts. Their shapes are TypeScript-only, so
 * `runEventSchema` checks only that the type is known; the coding events are
 * validated field by field.
 */
export const LEGACY_RUN_EVENT_TYPES = [
  'run.updated',
  'step.upserted',
  'approval.requested',
  'approval.resolved',
  'egress.logged',
  'pii.detected',
  'schedule.decided',
  'browser.session.opened',
  'browser.session.closed',
  'control.decided',
  'model.lifecycle',
  'harness.turn',
  'tool.lifecycle',
  'session.updated',
  'log',
] as const;

/** Every RunEvent type. Compile-time checked against the union in both directions. */
export const RUN_EVENT_TYPES = [...LEGACY_RUN_EVENT_TYPES, ...CODING_EVENT_TYPES] as RunEventType[];
type LegacyRunEventType = (typeof LEGACY_RUN_EVENT_TYPES)[number];
const _legacyCoversUnion: Exclude<RunEventType, LegacyRunEventType | CodingEvent['type']> extends never
  ? true
  : never = true;
const _legacyIsKnown: Exclude<LegacyRunEventType, RunEventType> extends never ? true : never = true;
void _legacyCoversUnion;
void _legacyIsKnown;

/**
 * Runtime check for anything claiming to be a RunEvent (SSE consumers, replay, tests).
 * Unknown `type` values are rejected; coding events must match their schema exactly.
 */
export const runEventSchema = z.union([
  codingEventSchema,
  z.looseObject({ type: z.enum(LEGACY_RUN_EVENT_TYPES) }),
]);

export function parseRunEvent(value: unknown): RunEvent {
  return runEventSchema.parse(value) as RunEvent;
}

/** An event as persisted. `seq` is monotonic per run and powers SSE replay. */
export interface StoredEvent {
  seq: number;
  runId: string;
  event: RunEvent;
  at: Iso;
}

export const RUN_WORK_EVENT_TYPES = [
  'gateway.call',
  'gateway.blocked',
  'harness.turn.ended',
  'workspace.checkpoint',
  'verify.tests',
] as const satisfies readonly CodingEvent['type'][];
export type RunWorkEvent = Extract<CodingEvent, { type: (typeof RUN_WORK_EVENT_TYPES)[number] }>;

export function isRunWorkEvent(event: { type: string }): event is RunWorkEvent {
  return (RUN_WORK_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Everything the RunDetail page renders, rebuilt from the event stream alone.
 * The reducer that produces this lives in apps/web/src/hooks/useRunStream.ts.
 */
export interface RunView {
  run: Run | null;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  piiSpans: PiiSpan[];
  scheduleDecisions: ScheduleDecision[];
  /**
   * Browser sessions this run opened, newest last. `closedAt` is set in place
   * when the matching close event arrives, so a finished run still lists every
   * session it used — the panel needs that to show a decision replay.
   */
  browserSessions: (BrowserSessionRecord & { closedAt?: Iso })[];
  controlDecisions: ControlDecisionRecord[];
  modelCalls: ModelLifecycleEvent[];
  harnessTurns: HarnessTurnEvent[];
  /**
   * Every `tool.lifecycle` event, in arrival order. One tool action produces several
   * (proposed -> policy_decided -> ... -> succeeded), all sharing `action.id`; group by it.
   */
  toolLifecycle: ToolLifecycleEvent[];
  agentSessions: AgentSessionState[];
  /**
   * The coding-run events the Workspace and token panels read: model calls through the
   * gateway (usage per call), budget blocks, turn ends, per-turn checkpoints and test
   * selections. Appended in arrival order.
   */
  codingWork: RunWorkEvent[];
  logs: { level: 'info' | 'warn' | 'error'; message: string; at: Iso }[];
  /** Highest `seq` applied. Used as the replay cursor on reconnect. */
  lastSeq: number;
}

export const emptyRunView: RunView = {
  run: null,
  steps: [],
  approvals: [],
  egress: [],
  piiSpans: [],
  scheduleDecisions: [],
  browserSessions: [],
  controlDecisions: [],
  modelCalls: [],
  harnessTurns: [],
  toolLifecycle: [],
  agentSessions: [],
  codingWork: [],
  logs: [],
  lastSeq: 0,
};
