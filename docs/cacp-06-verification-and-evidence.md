# Step 6 — Verification and evidence

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §3, §6 (test relevance, completion, flaky). Owners: Person 3 (protected paths,
evidence), Person 2 (Jev questions). Needs steps 3 and 5.

## Goal

A run ends with evidence, not the agent's say-so: relevant tests chosen and run, protected
files guarded, and a rendered bundle attached to the PR.

## Files

- Create `apps/api/src/core/verify/` — `testInventory.ts`, `testImpact.ts`,
  `protectedPaths.ts`, `evidence.ts`, `render.ts`.
- Create `apps/api/src/services/evidence.service.ts`.
- Modify `core/decisions/service.ts` — `scoreTests`, `completionVerdict`.
- Modify `core/tools/permissionBridge.ts` — protected-path rule.
- Modify the `git.publish` executor to attach the rendered bundle to the PR body.

## Interfaces produced

```ts
selectTests(diff: DiffSummary, inventory: TestInventory, policy: VerifyPolicy):
  Promise<{ selected: { id: string; score: number }[]; source: 'jev' | 'fallback' }>;

isProtected(path: string, policy: VerifyPolicy, runCreated: Set<string>): boolean;

assembleEvidence(runId: string): Promise<EvidenceBundle>;   // schema from step 1
```

## Tasks

- [ ] Test inventory: discover tests per runner from file patterns; coverage map when
      present, else import graph + path heuristics. Test on a fixture repo with two runners.
- [ ] `selectTests`: candidates intersect the diff plus policy always-run; Jev `score` per
      test; fallback runs every candidate. Test both sources; unavailable Jev never
      shrinks the set.
- [ ] Protected paths (default: pre-existing test files, snapshots, CI config, lint config,
      `*.lock`): edits classified **irreversible** → approval carrying the exact diff; new
      test files allowed and flagged. Tests: edit existing test → approval; add new test →
      auto + flagged; lockfile via a hot-file intent (step 7) still goes through approval.
- [ ] Completion judge: Jev `done`/`continue`/`blocked` from test digest, diff stat and turn
      count; fallback rule on test status + budget. Test: failing tests never yield `done`
      from the fallback.
- [ ] Flaky-vs-real: Jev `probability` from per-test failure history; default treat as real.
- [ ] Evidence bundle assembly from the trace and ledger: diff stat + hash, per-turn
      checkpoints, tests (scores, fallback flag, before/after), added/modified tests,
      protected-path approvals, tokens in/out/cache read/write, cost, wall time, egress
      summary. Test against a mock run: every field populated, and a missing optional
      section (no UI walkthrough) does not fail assembly.
- [ ] Render to markdown for PR bodies; attach on `git.publish`. Test the body stays under
      the host's size limit by truncating sections, never the header.
- [ ] Full-suite-before-publish when policy says so; test it blocks publish on failure.
- [ ] `pnpm check:verify`.

## Done when

A mock-harness run that edits code produces `evidence.json` and a rendered summary, and a
Zephyr-opened PR (live, manual) carries the bundle.

## Deferred (step G in the spec)

Browser walkthrough → emitted Playwright spec; adversarial test author (appendix item 1).
