import type { ToolDescriptor } from '@htn/shared';
import type { InMemoryToolRegistry } from './registry.js';
import type { InMemoryToolExecutorRegistry } from './executors.js';

/** An explicit synthetic PUBLIC dataset. Reading it is real local execution. */
export const BENCHMARK_FIXTURE = Object.freeze({
  datasetId: 'public-order-v1',
  currency: 'CAD',
  items: [
    { sku: 'A', quantity: 2, unitPriceCents: 1200 },
    { sku: 'B', quantity: 3, unitPriceCents: 750 },
  ],
  shippingCents: 500,
});
export function registerBenchmarkFixture(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
): void {
  const descriptor: ToolDescriptor = {
    id: 'agentos.benchmark_fixture',
    version: '1',
    providerId: 'hermes',
    family: 'benchmark',
    description:
      'Read the fixed synthetic public-order-v1 dataset (CAD integer cents, quantities, shipping). No external app or mutation.',
    inputSchemaRef: 'local://schemas/public-order-v1',
    transport: 'local',
    baselineEffect: 'read',
    reversibility: 'reversible',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: 'available',
    executorRef: 'local://benchmark/public-order-v1',
    executionMode: 'live',
  };
  registry.register({
    descriptor,
    wireName: 'agentos_benchmark_fixture',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
  executors.register({
    ref: descriptor.executorRef,
    destinationFor: () => descriptor.executorRef,
    async execute(action) {
      return {
        output: { ...structuredClone(BENCHMARK_FIXTURE), syntheticDataset: true },
        summary: 'Read synthetic public-order-v1 dataset locally.',
        sanitizedSummary: 'Read synthetic public-order-v1 dataset locally.',
        modelOutput: structuredClone(BENCHMARK_FIXTURE),
        dataLabels: [...action.dataLabels],
        verified: true,
        evidenceVerified: true,
        executionMode: 'live',
      };
    },
  });
}
