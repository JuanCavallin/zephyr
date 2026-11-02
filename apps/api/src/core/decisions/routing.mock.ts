/**
 * Mock routing seam (Person 3 scheduler → Person 2). Rule-based and deterministic; the
 * real implementation asks Jev to pick among `candidates` (a `choice`, never generated).
 *
 * Rules, in order:
 *   1. a pinned task keeps its assignee;
 *   2. no candidates → a human;
 *   3. a small write scope (≤ 2 paths) → the cheapest-tier agent candidate;
 *   4. otherwise the first `standard`-tier agent, else the cheapest agent, else a human.
 * Ties go to the earlier candidate.
 */

import type { Assignee, ModelTier, RoutingSeam, Task } from '@htn/shared';

const TIER_COST: Record<ModelTier, number> = { local: 0, cheap: 1, standard: 2, frontier: 3 };

export function createMockRouter(): RoutingSeam {
  return {
    async routeTask(task: Task, candidates: Assignee[]): Promise<Assignee> {
      if (task.pinned && task.assignee) return task.assignee;
      const agents = candidates.filter((c): c is Extract<Assignee, { kind: 'agent' }> => c.kind === 'agent');
      if (agents.length === 0) {
        return candidates[0] ?? { kind: 'human', reason: 'no candidates' };
      }
      const cheapest = agents.reduce((best, c) => (TIER_COST[c.tier] < TIER_COST[best.tier] ? c : best));
      if (task.writeScope.length <= 2) return cheapest;
      return agents.find((c) => c.tier === 'standard') ?? cheapest;
    },
  };
}
