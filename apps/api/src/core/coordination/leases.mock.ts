/**
 * Mock permission-bridge seam (Person 1 → Person 3): allow-all `checkLease`.
 *
 * Still rejects paths that are not repo-relative POSIX paths, so callers that forget to
 * normalise with `toRepoPath` find out now rather than when the real lease table lands.
 */

import { repoPathSchema, type LeaseDecision, type LeaseMode, type PermissionBridgeSeam } from '@htn/shared';

export function createMockLeaseBridge(): PermissionBridgeSeam {
  return {
    checkLease(taskId: string, path: string, mode: LeaseMode): LeaseDecision {
      if (!repoPathSchema.safeParse(path).success) {
        return {
          allowed: false,
          reason: 'invalid_path',
          message: 'not a repo-relative POSIX path: ' + path,
        };
      }
      return { allowed: true, reason: 'mock: allow-all (' + mode + ' ' + path + ' for ' + taskId + ')' };
    },
  };
}
