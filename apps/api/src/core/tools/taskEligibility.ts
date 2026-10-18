import type { DecisionState, ToolDescriptor } from '@htn/shared';

/**
 * Which registered tools an agent task may be offered. Shared by the
 * orchestrator (at run time) and the graph compile step (at save time), so a
 * compiled tool set is computed exactly the way the runtime computes it.
 */
export function eligibleTaskTools(
  descriptors: ToolDescriptor[],
  state: DecisionState,
): ToolDescriptor[] {
  return descriptors.filter(
    (descriptor) =>
      descriptor.availability === 'available' &&
      descriptor.baselineEffect !== 'unknown' &&
      descriptor.simulated !== true &&
      state.dataLabels.every((label) => descriptor.allowedDataLabels.includes(label)),
  );
}

/**
 * Mock-backed tools that duplicate an operation a live tool in the same set
 * already serves. With Browserbase live and the local browser mocked, an agent
 * was offered both: `localbrowser.read` "succeeded" with simulated text, the
 * model took that for an empty page and retried the lookup with another tool,
 * so the turn kept going after its tools had succeeded. A mock tool with no
 * live twin stays -- an all-mock demo, or a mock mail.send whose approval gate
 * is the point of the demo.
 */
export function mockTwinsOfLiveTools(descriptors: ToolDescriptor[]): ToolDescriptor[] {
  const twinKey = (descriptor: ToolDescriptor) =>
    (descriptor.interactionMode ?? descriptor.family) +
    ':' +
    descriptor.id.slice(descriptor.id.lastIndexOf('.') + 1);
  const live = new Set(
    descriptors.filter((descriptor) => descriptor.executionMode === 'live').map(twinKey),
  );
  return descriptors.filter(
    (descriptor) => descriptor.executionMode === 'mock' && live.has(twinKey(descriptor)),
  );
}
