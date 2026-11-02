/**
 * Harness callbacks: Claude Code HTTP hooks, OTel ingest, and Observed-mode setup.
 *
 *   POST /api/hooks/:harness/:token          PreToolUse | PostToolUse | Stop
 *   POST /api/otel/:token/v1/logs            OTLP/HTTP JSON logs (tool_result, api_request)
 *   POST /api/otel/:token/v1/metrics         OTLP/HTTP JSON metrics (token.usage, cost.usage)
 *   POST /api/observed/claudecode            mint an observed run + settings snippet
 *
 * The first three are called by Claude Code itself, which cannot send the dashboard's
 * local-control cookie, so `createHarnessCallbackRouter` is mounted BEFORE that
 * middleware and authenticates by the run-scoped token in the path instead
 * (core/hooks/hookTokens.ts). An unknown, expired or other-harness token is a 401.
 * The observed-setup route is a dashboard mutation and sits behind local control.
 *
 * PreToolUse goes through the SAME permission bridge as the ACP path: a hook can only
 * deny or ask, never allow, so either layer denying denies the action.
 */

import { Router, type Request, type Response } from 'express';
import type { Json, NativeToolRequest, Run, RunEvent, Step } from '@htn/shared';
import { newId, nowIso } from '../lib/ids.js';
import type { Store } from '../store/types.js';
import {
  HookTokenStore,
  OBSERVED_HOOK_TTL_MS,
  type ResolvedHookBinding,
} from '../core/hooks/hookTokens.js';
import { createPermissionBridge } from '../core/tools/permissionBridge.js';
import { observedSnippet } from '../providers/claudecode/settings.js';

export interface HarnessCallbackDeps {
  tokens: HookTokenStore;
  store: Store;
  emit: (runId: string, event: RunEvent) => Promise<unknown>;
  log?: (message: string) => void;
}

/* ------------------------------- hooks ---------------------------------- */

interface HookBody {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

export function denyHook(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function askHook(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
}

function nativeRequest(binding: ResolvedHookBinding, body: HookBody): NativeToolRequest {
  return {
    harness: binding.harness,
    toolName: String(body.tool_name ?? ''),
    rawInput: (body.tool_input ?? {}) as Json,
    sessionId: body.session_id || 'unknown',
    ...(body.tool_use_id ? { toolCallId: body.tool_use_id } : {}),
  };
}

/** A tool_response that reports failure, in any of the shapes Claude Code tools use. */
function responseError(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const r = response as Record<string, unknown>;
  if (r.success === false || r.is_error === true || r.isError === true) {
    return String(r.error ?? r.message ?? 'tool reported failure');
  }
  if (typeof r.error === 'string' && r.error) return r.error;
  return undefined;
}

function summarize(response: unknown): string | undefined {
  if (response === undefined) return undefined;
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  return text.slice(0, 500);
}

/* --------------------------------- OTel --------------------------------- */

type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
};
type OtlpAttribute = { key: string; value?: OtlpValue };

function attrs(list: OtlpAttribute[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const a of list ?? []) {
    const v = a.value ?? {};
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
  }
  return out;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface ExternalTotals {
  toolCalls: number;
  toolFailures: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  apiRequests: number;
  models: string[];
  /** From the metrics exporter (delta temporality, summed); a cross-check on the logs. */
  metricTokens: { input: number; output: number };
  metricCostUsd: number;
}

function emptyTotals(): ExternalTotals {
  return {
    toolCalls: 0,
    toolFailures: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    apiRequests: 0,
    models: [],
    metricTokens: { input: 0, output: 0 },
    metricCostUsd: 0,
  };
}

function totalsOf(run: Run): ExternalTotals {
  const r = (run.result ?? {}) as Record<string, unknown>;
  const t = (r.totals ?? {}) as Partial<ExternalTotals>;
  return { ...emptyTotals(), ...t, metricTokens: { ...emptyTotals().metricTokens, ...(t.metricTokens ?? {}) } };
}

function eventName(record: { body?: OtlpValue }, a: Record<string, unknown>): string {
  const name = String(a['event.name'] ?? record.body?.stringValue ?? '');
  return name.replace(/^claude_code\./, '');
}

/* -------------------------------- router -------------------------------- */

export function createHarnessCallbackRouter(deps: HarnessCallbackDeps): Router {
  const router = Router();
  const log = deps.log ?? (() => {});
  // OTel batches for one run patch the same totals: serialize per run.
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(runId: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(runId) ?? Promise.resolve()).then(fn, fn);
    chains.set(runId, next.catch(() => {}));
    return next;
  };

  function authorize(req: Request, res: Response, harness?: string): ResolvedHookBinding | null {
    const binding = deps.tokens.resolve(String(req.params.token ?? ''));
    if (!binding || (harness !== undefined && binding.harness !== harness)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unknown, expired or foreign hook token.' } });
      return null;
    }
    return binding;
  }

  router.post('/hooks/:harness/:token', async (req, res) => {
    const binding = authorize(req, res, String(req.params.harness));
    if (!binding) return;
    const body = (req.body ?? {}) as HookBody;
    const event = body.hook_event_name;

    if (event === 'PreToolUse') {
      if (!body.tool_name) return void res.json(denyHook('Zephyr: hook carried no tool_name.'));
      try {
        const decision = await binding.bridge.preview(nativeRequest(binding, body));
        if (decision.verdict === 'deny' && decision.policy !== 'ask_user') {
          return void res.json(denyHook('Zephyr: ' + decision.reason));
        }
        if (decision.policy === 'ask_user' && decision.verdict !== 'allow') {
          // Managed: forces Claude Code onto the ACP permission request, where the
          // bridge waits for a reviewer. Observed: the user's own prompt decides.
          return void res.json(askHook('Zephyr: approval required (' + decision.reason + ')'));
        }
        // Auto, or an approval of this exact action is already on record. Never
        // `allow`: Claude Code's own permission flow (and so the ACP path) still runs.
        return void res.json({});
      } catch (error) {
        log('PreToolUse failed closed: ' + (error as Error).message);
        return void res.json(denyHook('Zephyr: classification failed'));
      }
    }

    if (event === 'PostToolUse') {
      if (body.tool_name) {
        const error = responseError(body.tool_response);
        const summary = summarize(body.tool_response);
        await binding.bridge.report(nativeRequest(binding, body), error ? 'failed' : 'succeeded', {
          ...(summary ? { outputSummary: summary } : {}),
          ...(error ? { error } : {}),
        });
      }
      return void res.json({});
    }

    if (event === 'Stop') {
      // Managed runs report the turn end from the ACP prompt result, which carries
      // the real stop reason; the hook would only duplicate it.
      if (binding.mode === 'observed') {
        await deps.emit(binding.runId, {
          type: 'harness.turn.ended',
          runId: binding.runId,
          sessionId: body.session_id || 'unknown',
          turnId: newId('turn'),
          harness: binding.harness,
          stopReason: 'end_turn',
          at: nowIso(),
        });
      }
      return void res.json({});
    }

    // Unknown events are acknowledged and ignored; they carry no decision.
    res.json({});
  });

  router.post('/otel/:token/v1/logs', async (req, res) => {
    const binding = authorize(req, res);
    if (!binding) return;
    const accepted = await serial(binding.runId, () => ingestLogs(binding, req.body));
    res.json({ partialSuccess: {}, accepted });
  });

  router.post('/otel/:token/v1/metrics', async (req, res) => {
    const binding = authorize(req, res);
    if (!binding) return;
    const accepted = await serial(binding.runId, () => ingestMetrics(binding, req.body));
    res.json({ partialSuccess: {}, accepted });
  });

  async function saveTotals(runId: string, totals: ExternalTotals): Promise<void> {
    const run = await deps.store.getRun(runId);
    if (!run) return;
    const result = { ...((run.result ?? {}) as Record<string, Json>), totals: totals as unknown as Json };
    const updated = await deps.store.patchRun(runId, {
      result,
      summary:
        totals.toolCalls + ' tool calls, ' + totals.tokensIn + ' in / ' + totals.tokensOut + ' out tokens',
      updatedAt: nowIso(),
    });
    await deps.emit(runId, { type: 'run.updated', run: updated });
  }

  async function ingestLogs(binding: ResolvedHookBinding, payload: unknown): Promise<number> {
    const run = await deps.store.getRun(binding.runId);
    if (!run) return 0;
    const totals = totalsOf(run);
    let accepted = 0;
    const resourceLogs = ((payload ?? {}) as { resourceLogs?: unknown[] }).resourceLogs ?? [];
    for (const rl of resourceLogs as { scopeLogs?: { logRecords?: unknown[] }[] }[]) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const raw of (sl.logRecords ?? []) as {
          body?: OtlpValue;
          attributes?: OtlpAttribute[];
          timeUnixNano?: string;
        }[]) {
          const a = attrs(raw.attributes);
          const name = eventName(raw, a);
          if (name === 'tool_result') {
            accepted++;
            const ok = a.success === true || a.success === 'true';
            totals.toolCalls++;
            if (!ok) totals.toolFailures++;
            const endedAt = raw.timeUnixNano
              ? new Date(Number(BigInt(raw.timeUnixNano) / 1_000_000n)).toISOString()
              : nowIso();
            const durationMs = num(a.duration_ms);
            const step: Omit<Step, 'seq'> = {
              id: newId('step'),
              runId: binding.runId,
              parentStepId: binding.stepId,
              kind: 'tool',
              label: String(a.tool_name ?? 'tool'),
              status: ok ? 'succeeded' : 'failed',
              providerId: 'claudecode',
              input: {
                toolName: String(a.tool_name ?? ''),
                durationMs,
                ...(a.decision !== undefined ? { decision: String(a.decision) } : {}),
                ...(a['session.id'] !== undefined ? { sessionId: String(a['session.id']) } : {}),
              },
              ...(ok ? {} : { error: { code: 'TOOL_FAILED', message: String(a.error ?? 'tool failed') } }),
              startedAt: new Date(Date.parse(endedAt) - durationMs).toISOString(),
              endedAt,
            };
            const stored = await deps.store.appendStep(step);
            await deps.emit(binding.runId, { type: 'step.upserted', step: stored });
          } else if (name === 'api_request') {
            accepted++;
            totals.apiRequests++;
            totals.tokensIn += num(a.input_tokens);
            totals.tokensOut += num(a.output_tokens);
            totals.cacheReadTokens += num(a.cache_read_tokens);
            totals.cacheCreationTokens += num(a.cache_creation_tokens);
            totals.costUsd = Math.round((totals.costUsd + num(a.cost_usd)) * 1e6) / 1e6;
            const model = a.model === undefined ? '' : String(a.model);
            if (model && !totals.models.includes(model)) totals.models.push(model);
          }
        }
      }
    }
    if (accepted) await saveTotals(binding.runId, totals);
    return accepted;
  }

  async function ingestMetrics(binding: ResolvedHookBinding, payload: unknown): Promise<number> {
    const run = await deps.store.getRun(binding.runId);
    if (!run) return 0;
    const totals = totalsOf(run);
    let accepted = 0;
    type Point = { asDouble?: number; asInt?: string | number; attributes?: OtlpAttribute[] };
    type Metric = { name?: string; sum?: { dataPoints?: Point[] }; gauge?: { dataPoints?: Point[] } };
    const resourceMetrics = ((payload ?? {}) as { resourceMetrics?: unknown[] }).resourceMetrics ?? [];
    for (const rm of resourceMetrics as { scopeMetrics?: { metrics?: Metric[] }[] }[]) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
          for (const p of points) {
            const value = num(p.asDouble ?? p.asInt);
            if (m.name === 'claude_code.token.usage') {
              const type = String(attrs(p.attributes).type ?? '');
              if (type === 'input') totals.metricTokens.input += value;
              else if (type === 'output') totals.metricTokens.output += value;
              accepted++;
            } else if (m.name === 'claude_code.cost.usage') {
              totals.metricCostUsd = Math.round((totals.metricCostUsd + value) * 1e6) / 1e6;
              accepted++;
            }
          }
        }
      }
    }
    if (accepted) await saveTotals(binding.runId, totals);
    return accepted;
  }

  return router;
}

/* ---------------------------- observed setup ---------------------------- */

export interface ObservedSetupDeps extends HarnessCallbackDeps {
  /** Base URL Claude Code can reach Zephyr on, e.g. http://127.0.0.1:8787. */
  apiBaseUrl: string;
}

export interface ObservedRun {
  run: Run;
  step: Step;
  token: string;
  snippet: ReturnType<typeof observedSnippet>;
}

/**
 * An `external` run for an unmodified Claude Code session, its observed hook token and
 * the settings snippet that points the session at Zephyr. The session's PreToolUse
 * calls are still classified: a deny from the bridge denies there too.
 */
export async function createObservedRun(
  deps: ObservedSetupDeps,
  input: { cwd: string; title?: string },
): Promise<ObservedRun> {
  const at = nowIso();
  const run = await deps.store.createRun({
    id: newId('run'),
    kind: 'external',
    title: input.title ?? 'Claude Code (observed)',
    status: 'running',
    input: { harness: 'claudecode', mode: 'observed', cwd: input.cwd },
    result: { totals: emptyTotals() as unknown as Json },
    createdAt: at,
    updatedAt: at,
  });
  await deps.emit(run.id, { type: 'run.updated', run });
  const step = await deps.store.appendStep({
    id: newId('step'),
    runId: run.id,
    parentStepId: null,
    kind: 'agent_task',
    label: 'Claude Code session (observed)',
    status: 'running',
    providerId: 'claudecode',
    startedAt: at,
  });
  await deps.emit(run.id, { type: 'step.upserted', step });
  const bridge = createPermissionBridge({
    harness: 'claudecode',
    worktree: input.cwd,
    run: { runId: run.id, stepId: step.id },
    onLifecycle: (lifecycle) => deps.emit(run.id, { type: 'tool.lifecycle', lifecycle }).then(() => {}),
    log: deps.log,
  });
  const token = deps.tokens.mint(
    { harness: 'claudecode', runId: run.id, stepId: step.id, mode: 'observed', bridge },
    OBSERVED_HOOK_TTL_MS,
  );
  return { run, step, token, snippet: observedSnippet({ apiBaseUrl: deps.apiBaseUrl, token }) };
}

export function createObservedRouter(deps: ObservedSetupDeps): Router {
  const router = Router();
  router.post('/observed/claudecode', async (req, res) => {
    const body = (req.body ?? {}) as { cwd?: unknown; title?: unknown };
    if (typeof body.cwd !== 'string' || !body.cwd.trim()) {
      return void res.status(400).json({ error: { code: 'BAD_INPUT', message: 'cwd (the project directory) is required.' } });
    }
    const observed = await createObservedRun(deps, {
      cwd: body.cwd,
      ...(typeof body.title === 'string' && body.title ? { title: body.title } : {}),
    });
    res.status(201).json({ runId: observed.run.id, snippet: observed.snippet });
  });
  return router;
}
