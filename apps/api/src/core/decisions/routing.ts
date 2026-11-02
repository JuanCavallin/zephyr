/**
 * Step 7 task routing: features and the deterministic fallback.
 *
 * Jev picks ONE candidate (a `choice`, never generated); these rules decide when Jev is
 * unavailable, ineligible, or returns a key that is not a candidate. A user pin always
 * wins, before Jev is asked.
 *
 * Fallback rules, in order:
 *   1. failed twice or more -> escalate: an agent on a higher tier than the last
 *      assignee, else a human;
 *   2. UI work -> the agent with the most design preferences;
 *   3. small (write scope <= 2 paths) -> the cheapest-tier agent;
 *   4. otherwise the least-loaded `standard` agent, else the cheapest, else a human.
 * Ties go to the earlier candidate.
 */

import type { Assignee, ModelTier, RouteCandidateInput, RouteTaskInput, Task } from '@htn/shared';

export const TIER_RANK: Record<ModelTier, number> = { local: 0, cheap: 1, standard: 2, frontier: 3 };

/** The failure count at which routing escalates. */
export const ESCALATE_AFTER_FAILURES = 2;

export function candidateKey(a: Assignee): string {
  return a.kind === 'human' ? 'human' : ['agent', a.harness, a.tier, ...(a.model ? [a.model] : [])].join(':');
}

const UI_PATH = /(^|\/)(apps\/web|web|ui|components|pages|styles)\/|\.(tsx|jsx|css|scss|html|vue|svelte)$/i;
const UI_WORDS = /\b(ui|ux|page|screen|component|layout|style|styles|css|design|button|modal|form|board view)\b/i;

export function isUiTask(task: Pick<Task, 'title' | 'writeScope'>): boolean {
  return task.writeScope.some((p) => UI_PATH.test(p)) || UI_WORDS.test(task.title);
}

export function routeFeatures(
  task: Pick<Task, 'title' | 'acceptance' | 'writeScope'>,
  candidates: RouteCandidateInput[],
  failures = 0,
): RouteTaskInput {
  return {
    task: {
      title: task.title,
      acceptance: task.acceptance,
      writeScope: [...task.writeScope],
      ui: isUiTask(task),
      failures,
    },
    candidates,
  };
}

type AgentCandidate = RouteCandidateInput & { assignee: Extract<Assignee, { kind: 'agent' }> };

function agentsOf(candidates: RouteCandidateInput[]): AgentCandidate[] {
  return candidates.filter((c): c is AgentCandidate => c.assignee.kind === 'agent');
}

function best<T>(items: T[], better: (a: T, b: T) => boolean): T | undefined {
  return items.reduce<T | undefined>((acc, c) => (acc === undefined || better(c, acc) ? c : acc), undefined);
}

export interface FallbackRoute {
  assignee: Assignee;
  rule: 'escalate' | 'ui-design-preferences' | 'small-cheap' | 'standard' | 'cheapest' | 'human';
}

export function fallbackRoute(input: RouteTaskInput, previous?: Assignee): FallbackRoute {
  const agents = agentsOf(input.candidates);
  const human = input.candidates.find((c) => c.assignee.kind === 'human')?.assignee;
  const toHuman = (reason: string): FallbackRoute => ({
    assignee: human ?? { kind: 'human', reason },
    rule: 'human',
  });

  if (input.task.failures >= ESCALATE_AFTER_FAILURES) {
    const floor = previous?.kind === 'agent' ? TIER_RANK[previous.tier] : TIER_RANK.standard;
    const higher = best(
      agents.filter((c) => TIER_RANK[c.assignee.tier] > floor),
      (a, b) => TIER_RANK[a.assignee.tier] < TIER_RANK[b.assignee.tier],
    );
    if (higher) return { assignee: higher.assignee, rule: 'escalate' };
    return { ...toHuman('failed ' + input.task.failures + ' times'), rule: 'escalate' };
  }
  if (agents.length === 0) return toHuman('no agent candidates');
  if (input.task.ui) {
    const designer = best(agents, (a, b) => a.designPreferences > b.designPreferences);
    if (designer && designer.designPreferences > 0) return { assignee: designer.assignee, rule: 'ui-design-preferences' };
  }
  const cheapest = best(agents, (a, b) => TIER_RANK[a.assignee.tier] < TIER_RANK[b.assignee.tier])!;
  if (input.task.writeScope.length <= 2) return { assignee: cheapest.assignee, rule: 'small-cheap' };
  const standard = best(
    agents.filter((c) => c.assignee.tier === 'standard'),
    (a, b) => a.load < b.load,
  );
  if (standard) return { assignee: standard.assignee, rule: 'standard' };
  return { assignee: cheapest.assignee, rule: 'cheapest' };
}
