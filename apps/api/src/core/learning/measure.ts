/**
 * The skill measurement hook (spec §11, feeding step 9).
 *
 * Every run that loads a skill is tagged with the skill's id and version (see
 * `createKnowledgeLoader`). When a run ends, its outcome is recorded against the tags.
 * The arms compared here are a skill's versions: when the current version passes
 * clearly less often than the version before it, the skill goes back to candidate, so
 * it stops loading until new evidence or the user brings it back.
 */

import type { SkillRunTag } from './profileStore.js';

export interface SkillArm {
  skillId: string;
  version: number;
  passed: number;
  failed: number;
  /** passed / (passed + failed); null with no finished runs. */
  passRate: number | null;
}

/** Pass counts per skill version, from finished runs only. */
export function skillArms(runs: SkillRunTag[]): SkillArm[] {
  const arms = new Map<string, SkillArm>();
  for (const r of runs) {
    const key = r.skillId + '@' + r.skillVersion;
    const arm = arms.get(key) ?? { skillId: r.skillId, version: r.skillVersion, passed: 0, failed: 0, passRate: null };
    if (r.outcome === 'passed') arm.passed++;
    else if (r.outcome === 'failed') arm.failed++;
    arms.set(key, arm);
  }
  for (const arm of arms.values()) {
    const n = arm.passed + arm.failed;
    arm.passRate = n === 0 ? null : arm.passed / n;
  }
  return [...arms.values()].sort((a, b) => a.skillId.localeCompare(b.skillId) || a.version - b.version);
}

export interface RegressionOptions {
  /** Finished runs each arm needs before it is compared. Default 5. */
  minRuns?: number;
  /** How far the pass rate must fall to count as a regression. Default 0.2. */
  drop?: number;
}

export interface SkillRegression {
  skillId: string;
  version: number;
  baseline: SkillArm;
  current: SkillArm;
}

/**
 * Skills whose given version passes at least `drop` less often than the latest earlier
 * version with enough runs. Not enough data is never a regression.
 */
export function skillRegressions(
  runs: SkillRunTag[],
  current: { id: string; version: number }[],
  opts: RegressionOptions = {},
): SkillRegression[] {
  const minRuns = opts.minRuns ?? 5;
  const drop = opts.drop ?? 0.2;
  const arms = skillArms(runs);
  const enough = (a: SkillArm) => a.passed + a.failed >= minRuns;
  const out: SkillRegression[] = [];
  for (const skill of current) {
    const mine = arms.filter((a) => a.skillId === skill.id);
    const now = mine.find((a) => a.version === skill.version);
    const before = mine.filter((a) => a.version < skill.version && enough(a)).at(-1);
    if (!now || !before || !enough(now)) continue;
    if (now.passRate! <= before.passRate! - drop) out.push({ skillId: skill.id, version: skill.version, baseline: before, current: now });
  }
  return out;
}
