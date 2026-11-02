/** `zephyr_build`: run the worktree's build (or typecheck) and return diagnostics, not the log. */

import { runShaped, type ShapedRunConfig, type ShapedRunInput, type ShapedRunResult } from './runTests.js';

export function runBuild(input: Omit<ShapedRunInput, 'filter'>, cfg: ShapedRunConfig): Promise<ShapedRunResult> {
  return runShaped('build', input, cfg);
}
