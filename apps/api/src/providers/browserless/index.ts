import type { BrowserAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { createMockBrowser } from '../mockBrowser.js';
import { createLiveBrowserless } from './live.js';

export function create(cfg: ProviderConfig): BrowserAdapter {
  return cfg.mode === 'live' ? createLiveBrowserless(cfg) : createMockBrowser('browserless', cfg);
}
