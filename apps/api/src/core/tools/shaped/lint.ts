/** `zephyr_lint`: run the worktree's linter and return diagnostics, not the log. */

import { runShaped, type ShapedRunConfig, type ShapedRunInput, type ShapedRunResult } from './runTests.js';

export function runLint(input: Omit<ShapedRunInput, 'filter'>, cfg: ShapedRunConfig): Promise<ShapedRunResult> {
  return runShaped('lint', input, cfg);
}
