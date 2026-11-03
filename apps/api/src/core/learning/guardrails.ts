/**
 * Step 8 guardrails (spec §11): learning can improve the agent but never widen what it
 * may do. Learned content is guidance in a context pack; it is never a permission, and
 * it may not talk the agent out of a check. A draft that fails here is dropped before
 * scoring, and the same check runs again before anything is emitted or loaded.
 *
 * Rejected, with a reason each:
 *   - weakening a success check: skipping, disabling or deleting tests, lint, typecheck, CI;
 *   - naming a protected path (existing tests, snapshots, CI and lint config, lockfiles,
 *     policy globs, `.env`, `.git`, Zephyr's own config);
 *   - policy and approvals: anything about approving, authorizing, permissions, policy;
 *   - widening a grant: allow-all, bypass, `--no-verify`, `allowed-tools`, force pushes.
 */

import type { VerifyPolicy } from '@htn/shared';
import { protectionOf } from '../verify/protectedPaths.js';

export type GuardrailReason = 'weakens-success-check' | 'protected-path' | 'policy-or-approval' | 'widens-grant';

export interface GuardrailVerdict {
  ok: boolean;
  reasons: GuardrailReason[];
  /** What tripped each reason, for the feed. */
  matches: string[];
}

const CHECKS = String.raw`(?:tests?|specs?|test suites?|assertions?|asserts?|ci|lint(?:ing|er)?|type-?check(?:s|ing|er)?|tsc|coverage|pre-commit|(?:git|commit) hooks?|(?:status|success|required) checks?|verification)`;

const WEAKENS = [
  new RegExp(String.raw`\b(?:skip|skipping|disable|disabling|delete|deleting|remove|removing|comment(?:ing)? out|mute|silence|ignore|ignoring|bypass|loosen|weaken|relax|xfail)\b[^.\n]{0,40}\b${CHECKS}\b`, 'i'),
  new RegExp(String.raw`\b${CHECKS}\b[^.\n]{0,30}\b(?:skip(?:ped)?|disabled|optional|unnecessary|not needed|can fail|may fail)\b`, 'i'),
  /\b(?:it|describe|test)\.(?:skip|only)\b|@ts-(?:ignore|nocheck|expect-error)|eslint-disable|\bnoqa\b|# type: ignore/i,
  /\b(?:update|regenerate|overwrite)\b[^.\n]{0,20}\bsnapshots?\b/i,
];

const POLICY = /\b(?:approv(?:e|al|als|ing)|authori[sz](?:e|ation|ing)|permissions?|polic(?:y|ies)|grants?|auto-?merge|allowlist|denylist|sandbox|escalat(?:e|ion))\b/i;

const WIDENS =
  /\b(?:allow[- ]all|allow everything|allowed-tools|bypass|no-verify|--force\b|force[- ]push|skip[- ]permissions|dangerously|yolo|auto-?approve|sudo|chmod 777|disable (?:the )?(?:guard|safety|hook)s?)\b|--no-verify|--dangerously/i;

/** Paths that are always out of bounds for learned content, whatever the policy. */
const ALWAYS_PROTECTED = /(?:^|[\s`'"(/])(?:\.env(?:\.[\w-]+)?|\.git\/|\.zephyr\/|zephyr\.config\.\w+|\.claude\/settings(?:\.local)?\.json)\b/i;

/** Anything that looks like a repo path: has a slash, or a file extension. */
const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.*-]+)+\/?|[\w@-]+(?:\.[\w-]+)*\.[a-z][a-z0-9]{0,6}\b/gi;

const DEFAULT_POLICY: Pick<VerifyPolicy, 'protectDefaults' | 'protectedGlobs'> = {
  protectDefaults: true,
  protectedGlobs: [],
};

/** Check learned text (a statement, or a skill's name, description and body). */
export function checkLearnedContent(
  text: string,
  policy: Pick<VerifyPolicy, 'protectDefaults' | 'protectedGlobs'> = DEFAULT_POLICY,
): GuardrailVerdict {
  const reasons = new Set<GuardrailReason>();
  const matches: string[] = [];
  const hit = (reason: GuardrailReason, what: string) => {
    reasons.add(reason);
    matches.push(`${reason}: ${what.trim()}`);
  };
  for (const pattern of WEAKENS) {
    const m = pattern.exec(text);
    if (m) hit('weakens-success-check', m[0]);
  }
  const policyHit = POLICY.exec(text);
  if (policyHit) hit('policy-or-approval', policyHit[0]);
  const widen = WIDENS.exec(text);
  if (widen) hit('widens-grant', widen[0]);
  const always = ALWAYS_PROTECTED.exec(text);
  if (always) hit('protected-path', always[0]);
  for (const token of text.match(PATH_TOKEN) ?? []) {
    const path = token.replace(/^\.\//, '').replace(/[.,;:]+$/, '');
    if (/^https?:/i.test(path) || /^\d+(\.\d+)+$/.test(path)) continue;
    const reason = protectionOf(path, policy, new Set());
    if (reason) hit('protected-path', `${path} (${reason})`);
  }
  return { ok: reasons.size === 0, reasons: [...reasons], matches };
}

/** The text a learned entry would put in front of an agent. */
export function learnedText(entry: { text: string; skill?: { name: string; description: string; body: string } }): string {
  return entry.skill ? [entry.skill.name, entry.skill.description, entry.skill.body].join('\n') : entry.text;
}
