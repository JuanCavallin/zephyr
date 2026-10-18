import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { DataLabel, Json } from '@htn/shared';
import { ApprovalRejectedError } from '../approvalGate.js';
import type { GatewayTurnBinding, SessionStateService } from '../sessions/service.js';
import { ToolBrokerError, type ToolBroker } from '../tools/broker.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';
import { modelToolText } from '../tools/executors.js';
import { compactSummary } from '../modelGateway/service.js';

export interface AgentOsMcpServerDependencies {
  registry: ToolRegistry;
  broker: ToolBroker;
  sessions: SessionStateService;
  binding: GatewayTurnBinding;
}

/** A fresh server is connected to each stateless Streamable HTTP request. */
export function createAgentOsMcpServer(deps: AgentOsMcpServerDependencies): Server {
  const server = new Server(
    { name: 'agentos-tool-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const session = await deps.sessions.requireGatewayTurn(deps.binding);
    const allowedIds = new Set(session.taskToolIds ?? session.candidateToolIds);
    const registered = (await deps.registry.list()).filter(
      (tool) =>
        isExecutable(tool) &&
        allowedIds.has(tool.descriptor.id) &&
        (!session.boundBrowserSessionId || !isSeparateBrowserOperation(tool.descriptor.id)) &&
        (session.toolCeiling === undefined || session.toolCeiling.includes(tool.descriptor.id)),
    );
    return { tools: registered.map(toMcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const registered = await deps.registry.getByWireName(request.params.name);
    if (!registered || !isExecutable(registered)) {
      const unknown = toolError('TOOL_NOT_REGISTERED', 'Unknown or unavailable AgentOS tool.');
      const session = await deps.sessions.requireGatewayTurn(deps.binding).catch(() => null);
      if (session) await recordTrustedError(deps.sessions, session.id, unknown);
      return unknown;
    }

    const args = toJsonArguments(request.params.arguments);
    const callKey = registered.descriptor.id + ' ' + stableJson(args);
    let sessionId: string | undefined;
    let turnKey: string | undefined;
    try {
      const session = await deps.sessions.requireGatewayTurn(deps.binding);
      sessionId = session.id;
      turnKey = session.id + ':' + deps.binding.turn.toString();
      if (rejectedBySession.get(session.id)?.has(callKey)) {
        const refused = toolError('TOOL_ACTION_REJECTED', REJECTED_AGAIN);
        await recordTrustedError(deps.sessions, session.id, refused);
        return refused;
      }
      const previous = lastCallByTurn.get(turnKey);
      if (registered.descriptor.baselineEffect === 'read' && previous?.key === callKey) {
        return await repeatedCall(deps.sessions, session.id, previous);
      }
      const result = await deps.broker.execute({
        sessionStateId: session.id,
        expectedTurn: deps.binding.turn,
        toolId: registered.descriptor.id,
        arguments: args,
        signal: extra.signal,
      });
      const response = {
        content: [
          {
            type: 'text',
            // Raw provider output stays local. Hermes receives only the compact broker summary,
            // or the explicitly sanitized version when an executor supplied one.
            text: modelToolText(result),
          },
        ],
      } satisfies CallToolResult;
      // Mirrors the broker: only a public, sanitized result was recorded as
      // trusted, so only that may be re-recorded for a repeated call.
      const trusted =
        Boolean(result.sanitizedSummary) && result.dataLabels.every((label) => label === 'public');
      remember(turnKey, {
        key: callKey,
        result: response,
        ...(trusted ? { trustedLabels: result.dataLabels } : {}),
      });
      return response;
    } catch (error) {
      // A failure is never replayed: grants, ceilings and approvals change
      // between calls, so the same call may well succeed next time. It still
      // counts as the call in between for whatever came before it.
      if (turnKey) lastCallByTurn.delete(turnKey);
      const failed = failureResult(error, sessionId, callKey);
      if (sessionId) await recordTrustedError(deps.sessions, sessionId, failed);
      return failed;
    }
  });

  return server;
}

/**
 * What the agent is told when a call fails. Always recorded as a trusted
 * result by the caller: the generic text is fixed AgentOS copy with no task
 * data in it, and left unrecorded its echo was labelled local_only, which
 * spread to the session and shut out every cloud model for the rest of the run
 * ("No policy-eligible model route").
 */
function failureResult(error: unknown, sessionId: string | undefined, callKey: string) {
  // The person reviewing the action said no. Say so plainly, and remember it:
  // asking them again for the same exact action is a loop.
  if (error instanceof ApprovalRejectedError) {
    if (sessionId) rememberRejection(sessionId, callKey);
    return toolError('TOOL_ACTION_REJECTED', REJECTED);
  }
  return error instanceof ToolBrokerError
    ? toolError(error.code, error.message)
    : toolError('TOOL_GATEWAY_FAILED', 'AgentOS refused the tool call.');
}

const REJECTED =
  'The person reviewing this action rejected it, so it did not run. Do not try it again; ' +
  'finish with what you have and say it was not done.';
const REJECTED_AGAIN =
  'This exact action was already rejected in this run, so AgentOS did not ask again. ' +
  'Do not repeat it.';

/** Exact actions a person rejected, per agent session. Bounded like the call memory. */
const rejectedBySession = new Map<string, Set<string>>();

function rememberRejection(sessionId: string, callKey: string): void {
  const rejected = rejectedBySession.get(sessionId) ?? new Set<string>();
  rejected.add(callKey);
  rejectedBySession.delete(sessionId);
  rejectedBySession.set(sessionId, rejected);
  if (rejectedBySession.size > MAX_REMEMBERED_TURNS) {
    const oldest = rejectedBySession.keys().next().value;
    if (oldest !== undefined) rejectedBySession.delete(oldest);
  }
}

interface RememberedCall {
  key: string;
  result: CallToolResult;
  /** Present when the result was recorded as a trusted tool entry, with its labels. */
  trustedLabels?: DataLabel[];
}

/**
 * The last successful call each agent turn made. An identical READ made
 * straight after it is answered from that result instead of running again:
 * back-to-back identical reads are the commonest way an agent loops ("let me
 * check again"). Only the immediately previous call counts -- anything in
 * between, a click or another read, may have changed what the read would
 * return -- and writes are never short-circuited. One entry per turn, oldest
 * dropped first.
 */
const lastCallByTurn = new Map<string, RememberedCall>();
const MAX_REMEMBERED_TURNS = 500;

function remember(turnKey: string, call: RememberedCall): void {
  lastCallByTurn.delete(turnKey);
  lastCallByTurn.set(turnKey, call);
  if (lastCallByTurn.size > MAX_REMEMBERED_TURNS) {
    const oldest = lastCallByTurn.keys().next().value;
    if (oldest !== undefined) lastCallByTurn.delete(oldest);
  }
}

async function repeatedCall(
  sessions: SessionStateService,
  sessionId: string,
  previous: RememberedCall,
): Promise<CallToolResult> {
  const [first] = previous.result.content;
  const text =
    'Repeated call: you just made this exact call and nothing ran in between, so AgentOS ' +
    'returned the same result instead of running it again. Use it, or try something ' +
    'different.\n\n' +
    (first?.type === 'text' ? first.text : '');
  // The model gateway labels an echoed tool result by matching it to a trusted
  // entry; without one this text would be treated as local_only.
  if (previous.trustedLabels) {
    const summary = compactSummary(text);
    await sessions.appendContext(sessionId, [
      { role: 'tool', summary, sanitizedSummary: summary, dataLabels: previous.trustedLabels },
    ]);
  }
  return { content: [{ type: 'text', text }] };
}

/** Key order must not make two identical calls look different. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableJson(record[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

function isSeparateBrowserOperation(toolId: string): boolean {
  return (
    (toolId.startsWith('browserbase.') ||
      toolId.startsWith('browserless.') ||
      toolId.startsWith('localbrowser.')) &&
    ['open', 'search', 'read'].includes(toolId.slice(toolId.lastIndexOf('.') + 1))
  );
}

function isExecutable(tool: RegisteredTool): boolean {
  return (
    tool.descriptor.availability === 'available' &&
    tool.descriptor.baselineEffect !== 'unknown' &&
    tool.descriptor.simulated !== true
  );
}

function toMcpTool(registered: RegisteredTool): Tool {
  const descriptor = registered.descriptor;
  return {
    name: registered.wireName,
    title: descriptor.id,
    description: descriptor.description,
    inputSchema: structuredClone(registered.inputSchema) as Tool['inputSchema'],
    annotations: {
      readOnlyHint: descriptor.baselineEffect === 'read',
      destructiveHint: descriptor.baselineEffect === 'destructive',
      idempotentHint: descriptor.baselineEffect === 'read',
      openWorldHint: descriptor.transport !== 'local',
    },
  };
}

function toJsonArguments(value: Record<string, unknown> | undefined): Json {
  if (!value) return {};
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * Record a broker error as a trusted public tool result, so the model gateway
 * can match Hermes's echo of it. Without this, one failed call in a public
 * session was labelled local_only, which spread to the session and blocked
 * every cloud model for the rest of the run, including later graph nodes.
 * Only for all-public sessions: a non-public session's error may carry its
 * data, so its echo stays local_only (the fail-safe default).
 */
async function recordTrustedError(
  sessions: SessionStateService,
  sessionId: string,
  failed: CallToolResult,
): Promise<void> {
  const session = await sessions.get(sessionId);
  if (!session || !session.dataLabels.every((label) => label === 'public')) return;
  const [first] = failed.content;
  if (first?.type !== 'text') return;
  const summary = compactSummary(first.text);
  await sessions.appendContext(sessionId, [
    { role: 'tool', summary, sanitizedSummary: summary, dataLabels: ['public'] },
  ]);
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: code + ': ' + message }],
  };
}
