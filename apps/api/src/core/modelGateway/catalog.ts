import type { ModelRoute, TextModelAdapter } from '@htn/shared';

const BOUND_ROUTE_PREFIX = 'bound-text-model-';

/**
 * Bound routes carry the bound adapter's providerId but a placeholder modelId
 * ('bound-cheap'). Direct provider backends must leave them to the bound
 * adapter, or a provider that is both bound and direct (Anthropic) sends the
 * placeholder upstream and gets a 404.
 */
export function isBoundTextRoute(route: ModelRoute): boolean {
  return route.id.startsWith(BOUND_ROUTE_PREFIX);
}

/**
 * Logical routes backed by the currently-bound text model capability.
 */
export function modelRoutesFor(adapter: TextModelAdapter): ModelRoute[] {
  if (adapter.mode !== 'live') {
    return [
      {
        id: BOUND_ROUTE_PREFIX + 'local-cheap',
        providerId: adapter.id,
        modelId: 'mock-local-cheap',
        costTier: 'cheap',
        deployment: 'local',
        contextScope: 'local_only',
        supportsTools: false,
        allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
        enabled: true,
        noTraining: true,
        zeroDataRetention: true,
      },
    ];
  }

  return (['cheap', 'standard', 'frontier'] as const).map((costTier) => ({
    id: BOUND_ROUTE_PREFIX + 'cloud-' + costTier,
    providerId: adapter.id,
    modelId: 'bound-' + costTier,
    costTier,
    deployment: 'cloud' as const,
    contextScope: 'public' as const,
    supportsTools: false,
    // Until provider-specific retention policy is represented, only explicitly
    // public state can use this cloud bridge.
    allowedDataLabels: ['public'] as const,
    enabled: true,
  }));
}
