import type { BrowserAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { createMockBrowser } from '../mockBrowser.js';
import { createLiveLocalBrowser } from './live.js';
export function create(cfg: ProviderConfig): BrowserAdapter {
  return cfg.mode === 'live' ? createLiveLocalBrowser(cfg) : createMockBrowser('localbrowser', cfg);
}
