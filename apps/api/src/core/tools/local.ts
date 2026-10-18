import type { ToolDescriptor } from '@htn/shared';
import type { SessionStateService } from '../sessions/service.js';
import type { InMemoryToolExecutorRegistry } from './executors.js';
import type { InMemoryToolRegistry } from './registry.js';

export const CORE_RUNTIME_STATUS_TOOL_ID = 'agentos.runtime_status';
export const CORE_RUNTIME_STATUS_WIRE_NAME = 'agentos_runtime_status';

const descriptor: ToolDescriptor = {
  id: CORE_RUNTIME_STATUS_TOOL_ID,
  version: '1',
  providerId: 'hermes',
  family: 'agentos',
  description: 'Read the current AgentOS session status and turn number locally.',
  inputSchemaRef: 'agentos://schemas/agentos.runtime_status/1',
  transport: 'local',
  baselineEffect: 'read',
  reversibility: 'reversible',
  requiredScopes: [],
  allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
  availability: 'available',
  executorRef: 'local://agentos.runtime_status',
  executionMode: 'live',
};

/** Register one real, side-effect-free executor used to prove the complete MCP path. */
export function registerCoreLocalTools(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  sessions: SessionStateService,
): void {
  registry.register({
    descriptor,
    wireName: CORE_RUNTIME_STATUS_WIRE_NAME,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
  executors.register({
    ref: descriptor.executorRef,
    destinationFor: () => 'local://agentos/runtime',
    async execute(action) {
      const session = await sessions.resolveStepSession(action.runId, action.stepId);
      if (session.runId !== action.runId || session.stepId !== action.stepId) {
        throw new Error('Active session changed before the local read executed.');
      }
      const summary =
        'AgentOS session is ' + session.status + ' on turn ' + String(session.turn) + '.';
      const publicOnly = action.dataLabels.every((label) => label === 'public');
      return {
        output: { status: session.status, turn: session.turn },
        summary,
        sanitizedSummary: publicOnly ? summary : undefined,
        dataLabels: [...action.dataLabels],
        verified: true,
        executionMode: 'live',
      };
    },
  });
}
