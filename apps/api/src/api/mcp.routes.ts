import { sessionStateService, toolBroker, toolRegistry } from '../services/runtime.js';
import { createMcpGatewayRouter } from './mcpGateway.js';

export { createMcpGatewayRouter, type McpGatewayDeps } from './mcpGateway.js';

export const mcpGatewayRouter = createMcpGatewayRouter({
  registry: toolRegistry,
  broker: toolBroker,
  sessions: sessionStateService,
});
