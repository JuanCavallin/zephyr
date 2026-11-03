/**
 * Coding benchmark (docs/cacp-09-benchmark-cli-demo.md): task set loader, hidden-test
 * runner, arm definitions and the resumable runner. The arm definitions and the
 * report rule are pure and live in @htn/shared so the Compare page uses the same math.
 */

export {
  CODING_ARMS,
  CODING_ARM_IDS,
  armDiff,
  armFlags,
  buildCodingReport,
  type CodingArm,
  type CodingArmId,
  type CodingBenchmarkReport,
  type CodingRunResult,
} from '@htn/shared';
export * from './taskSet.js';
export * from './hiddenTests.js';
export * from './runner.js';
export * from './markdown.js';
