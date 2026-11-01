# Step 9 — Benchmark, CLI and demo

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §5, §7, §13, §14. Owners: Person 2 (benchmark), Person 4 (CLI, compare UI, demo).
**Milestone M5.** Nothing gets a number in the README until this step has run.

## Goal

Prove it is cheaper and still works, and make it easy to start: measured savings with
pass rate held, a one-command start, and a recorded demo on a real feature.

## Files

- Modify `apps/api/src/services/benchmark.service.ts` — coding arms and metrics.
- Create `apps/api/src/core/benchmark/coding/` — task set loader, hidden-test runner,
  arm definitions.
- Create `packages/cli/` — `zephyr up`, `zephyr run "<task>"`, Observed hook install.
- Web: `/compare` "harness vs harness-under-Zephyr" view, per-turn token panel, Workspace
  panel on `/runs/:id`, home "Needs you".
- Update `README.md`, `docs/DEMO.md` only with measured numbers.

## Tasks

### Benchmark
- [ ] Task set: 20–40 tasks from this repo's history plus 1–2 other repos (bug fix with
      failing test, small feature, refactor, CI fix). Each has a **hidden acceptance test**
      stored outside the worktree and never exposed to the agent. Test: the hidden test
      path is absent from the agent's readable tree.
- [ ] Arms: (a) vanilla agent, same model and prompt, no Zephyr; (b) Supervised, all levers;
      (c) leave-one-out for L1, L2 (and L5, L7 when they exist); (d) with/without learned
      skills (step 8). Arms differ only by policy flags — test that arm configs diff to the
      expected flags.
- [ ] Metrics per run: hidden-test pass, input/output/cache read/write tokens, cost, wall
      time, approvals requested, stuck-blocks. ≥3 runs per cell; report median and spread.
- [ ] Report rule enforced in code: savings are shown only where pass rate is within noise
      of arm (a) or better; otherwise the cell is labelled "not comparable". Test with
      synthetic results on both sides of the bar.
- [ ] Unattended runner reusing the existing benchmark scaffolding (resume after crash, one
      Hermes-style run per task, rerun only on network errors).

### CLI and onboarding
- [ ] `npx zephyr up`: detect `claude`/`codex` binaries and keys, start server, open board.
      Test detection with fake binaries on PATH, including Windows `.cmd` shims.
- [ ] `zephyr run "<task>"` over the HTTP API; Observed hook installer from step 3.
- [ ] Templates (add feature, fix CI, upgrade dependency, polish UI) with preset policy,
      budget and concurrency, each with a one-line explanation.
- [ ] Per-task summary generated from the evidence bundle.

### UI and demo
- [ ] Compare page, per-turn token panel (lever applied, e.g. "14k → 600"), Workspace panel
      (live diff, checkpoints with rewind, shell classifications, shaped results).
- [ ] Demo script: type a feature → board → parallel agents inside leases → verified merges
      → a learned preference → next task cheaper. Rehearse on a real feature; record it.
- [ ] Update `docs/DEMO.md` / `docs/SPONSORS.md` / `docs/DEVPOST.md` from measured results
      only.

### Verification
- [ ] `pnpm check:benchmark-coding` on mock harness arms (offline).
- [ ] Time a fresh user from `npx zephyr up` to a running board; target under five minutes.

## Done when

The Compare page shows measured tokens and pass rate for arms (a) and (b), the README
claims no number not present there, and the demo has been recorded end to end.

## Risks

Real runs cost money and time: budget the task set up front, run unattended, and cap
concurrency. If pass rate drops under a lever, report that lever as harmful rather than
tuning the task set.
