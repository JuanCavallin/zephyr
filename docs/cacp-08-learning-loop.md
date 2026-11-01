# Step 8 — Learning loop

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §11. Owner: Person 2 (variant picker UI: Person 4). **Milestone M4.** Needs steps 6
and 7 for signal sources.

## Goal

After a user edits an agent's diff, a preference appears with its evidence; the next
relevant task loads it under a token cap. Personal learning applies automatically and is
revertible; project knowledge is proposed as a PR. Learning can improve the agent but can
never widen a permission.

## Files

- Create `apps/api/src/core/learning/` — `signalLog.ts`, `draft.ts`, `score.ts`,
  `lifecycle.ts`, `relevance.ts`, `emit.ts`, `profileStore.ts` (SQLite at
  `~/.zephyr/profile.db`).
- Create `apps/api/src/services/learning.service.ts`; `apps/api/src/api/learning.routes.ts`.
- Modify `core/context/pack.ts` (step 5) — include top-k relevant preferences/skills.
- Web: "What Zephyr learned" feed, revert button, variant picker.

## Interfaces produced

```ts
recordSignal(s: PreferenceSignal): Promise<void>;                 // seam from step 1
relevantKnowledge(task: string, cap: number): Promise<{ id: string; kind: 'pref' | 'skill'; text: string }[]>;
```

## Tasks

- [ ] `signalLog` and `profileStore` with migrations; entries store links to evidence.
      Test persistence and that deleting the profile removes all signals (one-command
      export and delete).
- [ ] Signal capture, strongest first: diff between agent output and merged result (from
      the merge queue), variant picks, rejected/revised approvals with reason, reverts of
      agent commits, card feedback, request wording. Test the edit-diff capture on a fixture
      pair.
- [ ] Draft step: a **normal model** proposes candidate preferences/skill edits from
      signals (generative; not Jev). Runs in the background after a task finishes, off the
      critical path. Test with a stubbed model that failure here never fails the task.
- [ ] Jev scoring: `probability` that evidence supports a candidate; `choice` against
      existing entries (new / duplicate of #k / contradicts #k). Fallback: treat as new with
      low confidence, never auto-activate. Test all three outcomes.
- [ ] Lifecycle: confidence rises with evidence, activates above threshold, retires when
      contradicted; versioned with one-click revert. Test threshold crossing and revert.
- [ ] Emitters: personal → profile only; project → proposed as a PR touching
      `.claude/skills/<name>/SKILL.md` and `AGENTS.md` (fork-don't-modify). Test emitted
      file formats and that personal entries are never written into the repo unless promoted.
- [ ] Relevance at task start: Jev `score` per entry, top-k under a token cap. Fallback:
      keyword overlap. Test the cap is respected and project knowledge outranks personal
      taste in shared code.
- [ ] Guardrails (explicit tests): learned content cannot touch success checks, protected
      paths or policy; cannot widen a grant; private-route runs' signals go only to a local
      model.
- [ ] Skill measurement hook: tag runs with loaded skill ids so step 9 can compare arms and
      demote skills whose tasks' pass rate drops.
- [ ] `pnpm check:learning`: edit → signal → candidate → active preference → loaded into the
      next task's pack, all on stubs.

## Done when

Live: edit an agent diff, see a preference with evidence in the feed, start a related task
and see it in the context pack; revert removes it.
