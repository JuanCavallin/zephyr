import type { AgentRuntimeAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { createLiveClaudeCode } from './live.js';
import { createMockClaudeCode } from './mock.js';

export function create(cfg: ProviderConfig): AgentRuntimeAdapter {
  if (cfg.mode === 'live') return createLiveClaudeCode(cfg);
  return createMockClaudeCode(cfg);
}
