/**
 * Provider registry.
 *
 * Playbooks ask for a CAPABILITY, never a vendor. BINDINGS below is therefore the
 * one line you edit to re-point the demo — e.g. if Jev is not working by hour 30,
 * point 'decision' at 'anthropic' and nothing else in the codebase changes.
 */

import type {
  BrowserAdapter,
  Capability,
  CapabilityMap,
  ProviderAdapter,
  ProviderId,
  ProviderStatus,
} from '@htn/shared';
import { PROVIDER_IDS } from '@htn/shared';
import { config, type ProviderConfig } from '../config.js';
import { newId } from '../lib/ids.js';
import { withEgress, type RecordEgress } from './withEgress.js';
import { withBrowserOwnership } from './withBrowserOwnership.js';

import { create as createHermes } from './hermes/index.js';
import { create as createJev } from './jev/index.js';
import { create as createBrowserbase } from './browserbase/index.js';
import { create as createBrowserless } from './browserless/index.js';
import { create as createLocalBrowser } from './localbrowser/index.js';
import { create as createComposio } from './composio/index.js';
import { create as createOllama } from './ollama/index.js';
import { create as createMcp } from './mcp/index.js';
import { create as createAnthropic } from './anthropic/index.js';
import { create as createGemini } from './gemini/index.js';
import { create as createGptzero } from './gptzero/index.js';

type Factory = (cfg: ProviderConfig) => ProviderAdapter;

const FACTORIES: Record<ProviderId, Factory> = {
  hermes: createHermes,
  jev: createJev,
  browserbase: createBrowserbase,
  browserless: createBrowserless,
  localbrowser: createLocalBrowser,
  composio: createComposio,
  ollama: createOllama,
  mcp: createMcp,
  anthropic: createAnthropic,
  gemini: createGemini,
  gptzero: createGptzero,
};

/** THE re-wiring knob. One line per capability. */
const BINDINGS: Record<Capability, ProviderId> = {
  'agent.runtime': 'hermes',
  decision: 'jev',
  browser: config.browser.backend,
  // Two browser capabilities on purpose. Policy — not config, and not the
  // executor — chooses between them per step, and the two bindings produce two
  // distinct egress destinations. That is what makes "local-only data never
  // reached Browserbase" a provable ledger fact rather than a claim.
  'browser.local': 'localbrowser',
  toolbox: 'composio',
  'text.model': 'anthropic',
  'content.analysis': 'gptzero',
};

export interface ProviderRegistry {
  /** Explicit provider tools and existing sessions never follow a changed preferred binding. */
  byId(id: ProviderId): ProviderAdapter;
  /** Get the adapter serving a capability. Already wrapped for the egress ledger. */
  provider<C extends Capability>(capability: C): CapabilityMap[C];
  all(): ProviderAdapter[];
  statuses(): Promise<ProviderStatus[]>;
  bindings(): Record<Capability, ProviderId>;
}

export function createProviderRegistry(record: RecordEgress): ProviderRegistry {
  const cache = new Map<ProviderId, ProviderAdapter>();

  function get(id: ProviderId): ProviderAdapter {
    const cached = cache.get(id);
    if (cached) return cached;
    const raw = FACTORIES[id](config.providers[id]);
    const owned =
      id === 'browserbase' || id === 'browserless' || id === 'localbrowser'
        ? withBrowserOwnership(raw as BrowserAdapter)
        : raw;
    const adapter = withEgress(owned, record, newId);
    cache.set(id, adapter);
    return adapter;
  }

  return {
    byId: get,
    provider<C extends Capability>(capability: C): CapabilityMap[C] {
      return get(BINDINGS[capability]) as CapabilityMap[C];
    },
    all() {
      return PROVIDER_IDS.map(get);
    },
    async statuses(): Promise<ProviderStatus[]> {
      return Promise.all(
        PROVIDER_IDS.map(async (id) => {
          const adapter = get(id);
          const health = await adapter.health();
          return {
            id,
            mode: adapter.mode,
            capabilities: adapter.capabilities,
            healthy: health.ok,
            detail: health.ok ? health.data.detail : health.error.message,
          };
        }),
      );
    },
    bindings() {
      return { ...BINDINGS };
    },
  };
}
