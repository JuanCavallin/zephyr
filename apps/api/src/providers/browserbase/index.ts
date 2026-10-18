import type { BrowserAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { createMockBrowser } from '../mockBrowser.js';
import { createLiveBrowserbase } from './live.js';
export function create(cfg: ProviderConfig): BrowserAdapter {
  return cfg.mode === 'live' ? createLiveBrowserbase(cfg) : createMockBrowser('browserbase', cfg);
}
