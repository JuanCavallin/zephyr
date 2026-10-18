/**
 * An agent task is ONE Hermes run. Jev judges it once, the verdict is recorded
 * as given, and the graph continues whatever it says. The agent is started
 * again only when it, or its model, could not be reached.
 */
import assert from 'node:assert/strict';
import {
  agentGraphSchema,
  type AgentGraph,
  type AgentRuntimeAdapter,
  type CompletionStatus,
  type DecisionAdapter,
  type Json,
  type Run,
} from '@htn/shared';
import { Orchestrator, type OrchestratorDeps } from '../src/core/orchestrator.js';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { createMemoryStore } from '../src/store/memory.js';
import { create as createJev } from '../src/providers/jev/index.js';

const at = new Date().toISOString();
const meta = {
  provider: 'hermes' as const,
  mode: 'mock' as const,
  op: 'test',
  latencyMs: 0,
  destination: null,
};

type Polled = Extract<Awaited<ReturnType<AgentRuntimeAdapter['pollTask']>>, { ok: true }>['data'];
interface Script {
  /** Jev's verdict for every agent node. */
  verdict: CompletionStatus;
  /** Per start attempt: an error for startTask, or what every poll returns. */
  attempts: (
    { startError: string } | { poll: (stepId: string | undefined) => Polled | 'unreachable-model' }
  )[];
  maxDurationMs?: number;
}

function graphOf(nodeIds: string[], extra: Record<string, unknown> = {}): AgentGraph {
  return agentGraphSchema.parse({
    id: 'single-run',
    name: 'Single run checks',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes: nodeIds.map((id) => ({
      id,
      type: 'agent_task',
      label: id,
      position: { x: 0, y: 0 },
      config: {
        goal: 'Summarize public notes about ' + id + '.',
        pollIntervalMs: 100,
        contextInputs: {},
        availableTools: [],
        // Ignored now: an agent task never runs a second turn.
        maxTurns: 4,
        ...extra,
      },
    })),
    edges: nodeIds.slice(1).map((id, index) => ({
      id: nodeIds[index] + '-' + id,
      source: nodeIds[index],
      target: id,
    })),
  });
}

async function execute(graph: AgentGraph, script: Script) {
  const store = createMemoryStore();
  const bus = new RunBus((id, event) => store.appendEvent(id, event));
  const sessions = new SessionStateService(store, bus);
  const mockJev = createJev({ mode: 'mock', keyVar: 'UNUSED' }) as DecisionAdapter;
  const judged: CompletionStatus[] = [];
  const jev: DecisionAdapter = {
    ...mockJev,
    async judgeCompletion() {
      judged.push(script.verdict);
      return {
        ok: true,
        data: {
          status: script.verdict,
          // Low on purpose: the verdict must stand at any confidence.
          confidence: 0.42,
          probabilities: { [script.verdict]: 0.42 },
          reasonCodes: ['scripted-' + script.verdict],
        },
        meta: { ...meta, provider: 'jev', op: 'judge_completion', destination: 'mock://jev' },
      };
    },
  };
  const started: string[] = [];
  const continued: string[] = [];
  const cancelled: string[] = [];
  let attempt = -1;
  const pollFor = new Map<string, Script['attempts'][number]>();
  const runtime: AgentRuntimeAdapter = {
    id: 'hermes',
    mode: 'mock',
    capabilities: ['agent.runtime'],
    async health() {
      return { ok: true, data: {}, meta };
    },
    async invoke() {
      throw new Error('Unexpected invoke');
    },
    async startTask() {
      attempt += 1;
      const step = script.attempts[Math.min(attempt, script.attempts.length - 1)]!;
      if ('startError' in step) {
        return {
          ok: false,
          error: { code: 'UPSTREAM', message: step.startError, retryable: true },
          meta,
        };
      }
      const taskId = 'task-' + (attempt + 1).toString();
      started.push(taskId);
      pollFor.set(taskId, step);
      return { ok: true, data: { taskId }, meta };
    },
    async pollTask(taskId, ctx) {
      const step = pollFor.get(taskId);
      if (!step || 'startError' in step) throw new Error('polled an unknown task');
      const data = step.poll(ctx.stepId);
      if (data === 'unreachable-model') {
        // What a live run looks like when Hermes gives up on an unreachable
        // model: the last model call failed, and the "answer" is the error.
        await bus.emit(ctx.runId, {
          type: 'model.lifecycle',
          lifecycle: {
            id: 'mlc_' + taskId,
            modelCallId: 'chatcmpl_' + taskId,
            runId: ctx.runId,
            stepId: ctx.stepId,
            sessionStateId: 'unused',
            phase: 'failed',
            routeId: 'route',
            providerId: 'anthropic',
            configuredModelId: 'model',
            selectedToolIds: [],
            dataLabels: ['public'],
            messageCount: 1,
            error: { code: 'MODEL_CALL_FAILED', message: 'Connection error.' },
            at: new Date().toISOString(),
          },
        });
        return {
          ok: true,
          data: {
            status: 'done',
            result: { text: 'API call failed after 3 retries: Connection error.' },
          },
          meta,
        };
      }
      return { ok: true, data, meta };
    },
    async continueTask(id) {
      continued.push(id);
      return { ok: true, data: null, meta };
    },
    async cancelTask(id) {
      cancelled.push(id);
      return { ok: true, data: null, meta };
    },
  };
  const orchestrator = new Orchestrator({
    store,
    bus,
    sessionStateService: sessions,
    decisionService: new DecisionService(jev),
    provider: ((capability: string) =>
      capability === 'agent.runtime' ? runtime : jev) as OrchestratorDeps['provider'],
    providerFor: (capability) => (capability === 'agent.runtime' ? 'hermes' : 'jev'),
    agentCeilings: { maxDurationMs: script.maxDurationMs ?? 60_000, networkRetries: 2 },
  });
  const run: Run = {
    id: 'run-single',
    kind: 'graph',
    title: 'Single run',
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    input: { graphId: graph.id, graphSnapshot: graph as unknown as Json },
  };
  await store.createRun(run);
  await (orchestrator as unknown as { execute(run: Run): Promise<void> }).execute(run);
  const events = await store.eventsSince(run.id, 0);
  const logs = events.flatMap(({ event }) => (event.type === 'log' ? [event.message] : []));
  const steps = (await store.listSteps(run.id)).filter((step) => step.kind === 'agent_task');
  return {
    run: await store.getRun(run.id),
    started,
    continued,
    cancelled,
    judged,
    logs,
    steps,
    outputs: steps.map((step) => step.output as Record<string, Json> | undefined),
  };
}

const answered = {
  poll: () => ({ status: 'done' as const, result: { text: 'Three notes, summarised.' } }),
};

// 1. `continue` is recorded, not acted on: one start, no continuation, success.
{
  const result = await execute(graphOf(['research']), {
    verdict: 'continue',
    attempts: [answered],
  });
  assert.equal(result.run?.status, 'succeeded', result.run?.summary);
  assert.deepEqual(result.started, ['task-1']);
  assert.deepEqual(result.continued, [], 'AgentOS must never re-prompt the agent');
  assert.deepEqual(result.judged, ['continue'], 'Jev judges the run exactly once');
  const decision = result.outputs[0]?.completionDecision as Record<string, Json>;
  assert.equal(decision.status, 'continue', "Jev's verdict is recorded as given");
  assert.equal(result.outputs[0]?.attempts, 1);
  assert.ok(result.logs.some((line) => /not run again; the graph continues/.test(line)));
}

// 2. `blocked` does not pause the run, and the next node still runs.
{
  const result = await execute(graphOf(['research', 'checkout']), {
    verdict: 'blocked',
    attempts: [answered],
  });
  assert.equal(result.run?.status, 'succeeded', result.run?.summary);
  assert.deepEqual(result.started, ['task-1', 'task-2'], 'the graph carries on to the next node');
  assert.deepEqual(result.continued, []);
  assert.deepEqual(result.judged, ['blocked', 'blocked']);
  assert.ok(result.steps.every((step) => step.status === 'succeeded'));
}

// 3. A low-confidence `done` is followed too.
{
  const result = await execute(graphOf(['research']), { verdict: 'done', attempts: [answered] });
  assert.equal(result.run?.status, 'succeeded', result.run?.summary);
  assert.deepEqual(result.started, ['task-1']);
  const decision = result.outputs[0]?.completionDecision as Record<string, Json>;
  assert.equal(decision.status, 'done');
  assert.equal(decision.verified, true);
}

// 4. An agent that could not be started is started again (network error only).
{
  const result = await execute(graphOf(['research']), {
    verdict: 'done',
    attempts: [{ startError: 'connect ECONNREFUSED 127.0.0.1:8787' }, answered],
  });
  assert.equal(result.run?.status, 'succeeded', result.run?.summary);
  assert.deepEqual(result.started, ['task-2']);
  assert.equal(result.outputs[0]?.attempts, 2);
  assert.ok(result.logs.some((line) => /could not reach its agent .*ECONNREFUSED/.test(line)));
}

// 5. A run whose model was unreachable is a run that never happened: retried.
{
  const result = await execute(graphOf(['research']), {
    verdict: 'done',
    attempts: [{ poll: () => 'unreachable-model' }, answered],
  });
  assert.equal(result.run?.status, 'succeeded', result.run?.summary);
  assert.deepEqual(result.started, ['task-1', 'task-2']);
  assert.ok(result.cancelled.includes('task-1'), 'the unreachable run is closed before the retry');
  assert.deepEqual(result.judged, ['done'], 'only the run that happened is judged');
}

// 6. Retries are bounded: still unreachable after 1 + 2 attempts fails the node.
{
  const result = await execute(graphOf(['research']), {
    verdict: 'done',
    attempts: [{ startError: 'socket hang up' }],
  });
  assert.equal(result.run?.status, 'failed');
  assert.match(result.run?.summary ?? '', /could not reach its agent after 3 attempt/);
  assert.deepEqual(result.judged, []);
}

// 7. A run stopped by its time budget passes on what it had said, is judged
//    once, and is not resumed.
{
  const result = await execute(graphOf(['research']), {
    verdict: 'blocked',
    maxDurationMs: 1500,
    attempts: [
      {
        poll: () => ({
          status: 'running' as const,
          partial: { text: 'Found two of the three notes so far.' },
        }),
      },
    ],
  });
  assert.equal(result.run?.status, 'succeeded', result.run?.summary);
  assert.deepEqual(result.started, ['task-1']);
  assert.ok(result.cancelled.includes('task-1'), 'a stopped run is cancelled, not continued');
  assert.equal(result.outputs[0]?.endedBy, 'duration-budget');
  assert.equal(result.outputs[0]?.resultPresent, true, 'the partial answer is the result');
  assert.deepEqual(result.judged, ['blocked']);
}

console.log(
  'PASS: one Hermes run per agent task; Jev verdicts recorded at any confidence and never ' +
    're-prompted; the graph continues past blocked; only unreachable agents are retried, boundedly.',
);
