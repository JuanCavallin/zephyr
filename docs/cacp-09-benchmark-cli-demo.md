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
- [x] Task set: 20–40 tasks from this repo's history plus 1–2 other repos (bug fix with
      failing test, small feature, refactor, CI fix). Each has a **hidden acceptance test**
      stored outside the worktree and never exposed to the agent. Test: the hidden test
      path is absent from the agent's readable tree.
- [x] Arms: (a) vanilla agent, same model and prompt, no Zephyr; (b) Supervised, all levers;
      (c) leave-one-out for L1, L2 (and L5, L7 when they exist); (d) with/without learned
      skills (step 8). Arms differ only by policy flags — test that arm configs diff to the
      expected flags.
- [x] Metrics per run: hidden-test pass, input/output/cache read/write tokens, cost, wall
      time, approvals requested, stuck-blocks. ≥3 runs per cell; report median and spread.
- [x] Report rule enforced in code: savings are shown only where pass rate is within noise
      of arm (a) or better; otherwise the cell is labelled "not comparable". Test with
      synthetic results on both sides of the bar.
- [x] Unattended runner reusing the existing benchmark scaffolding (resume after crash, one
      Hermes-style run per task, rerun only on network errors).

### CLI and onboarding
- [x] `npx zephyr up`: detect `claude`/`codex` binaries and keys, start server, open board.
      Test detection with fake binaries on PATH, including Windows `.cmd` shims.
- [x] `zephyr run "<task>"` over the HTTP API; Observed hook installer from step 3.
- [x] Templates (add feature, fix CI, upgrade dependency, polish UI) with preset policy,
      budget and concurrency, each with a one-line explanation.
- [x] Per-task summary generated from the evidence bundle.

### UI and demo
- [x] Compare page, per-turn token panel (lever applied, e.g. "14k → 600"), Workspace panel
      (live diff, checkpoints with rewind, shell classifications, shaped results).
- [ ] Demo script: type a feature → board → parallel agents inside leases → verified merges
      → a learned preference → next task cheaper. Rehearse on a real feature; record it.
- [x] Update `docs/DEMO.md` / `docs/SPONSORS.md` / `docs/DEVPOST.md` from measured results
      only.

### Verification
- [x] `pnpm check:benchmark-coding` on mock harness arms (offline).
- [ ] Time a fresh user from `npx zephyr up` to a running board; target under five minutes.

## Status (2026-11-03)

Built and checked offline. The "Done when" bar is **not met**: no live run has been
recorded, and the demo has not been recorded.

**How the build differs from the plan**
- **Task set.** There are 22 tasks across three small fixture repos (`apps/api/bench/coding/`:
  strkit, statkit, taskq).
  - They mirror modules of this repo and cover bugfix, feature, refactor and CI tasks.
  - They are not taken from this repo's history or from other real repos.
  - Hidden tests live under `bench/coding/hidden/`, and a check proves they are absent from
    the agent's tree.
- **Arms.**
  - There are six: vanilla, supervised, leave-one-out for L1, L2 and L3, and skills off.
  - L5 and L7 don't exist yet.
- **Code location.**
  - The benchmark is in `services/benchmarkCoding.service.ts` and `core/benchmark/coding/`.
  - `benchmark.service.ts`, the graph benchmark, is unchanged.
  - The runner is new: it has a resumable JSONL journal and retries network failures only.
- **CLI entry point.**
  - The CLI is `pnpm zephyr …` from the repo root, or `node packages/cli/bin/zephyr.mjs`.
  - `npx zephyr` can't resolve the package because it is not published.
- **Docs.**
  - `README.md` and `docs/DEMO.md` now describe the CLI, the board demo and `/compare`.
  - They say outright that no coding number is measured yet.
  - `docs/DEVPOST.md` and `docs/SPONSORS.md` record the submitted event and have no measured
    coding result to add, so they are unchanged.

**Not done**
- **Live runs.**
  - `--mode live` runs the vanilla arm only (Claude Code `-p`), and needs `--yes-spend`.
  - Live Zephyr arms are refused up front. They need the model gateway, hooks and MCP bound to
    the bench repo, and none of that is wired into the runner.
  - So arm (b) has no live numbers, and `/compare` can show only mock or vanilla-only data.
  - Next step: wire a live supervised agent. Budget the spend and
    get it approved before running.
- **Mock harness.**
  - It replays reference fixes with synthetic token counts, derived from the bytes it moves.
  - Approvals and blocks come from the real permission bridge.
  - Its per-arm token differences test the measuring, not Zephyr.
- **Demo.**
  - The script is in `docs/DEMO.md`. It has not been rehearsed on a real feature, and has not
    been recorded.
- **Fresh-user timing.**
  - Timing `zephyr up` to a running board has not been done.
  - `zephyr up --check` was exercised on a dev machine, and detected `claude.exe` and the
    `codex.cmd` shim.
- **Board CLI e2e.**
  - `zephyr run` against a started board was not exercised end to end in a live run.
  - It is covered by `check:cli` against a fake API.

**Checks:** `check:benchmark-coding`, `check:cli`, `check:workspace-view`, `check:board` and
the web tests all pass.
- `/compare` was viewed in the browser against a 396-run mock journal: 22 tasks × 6 arms × 3
  repetitions, which took about 1 minute.

## Done when

The Compare page shows measured tokens and pass rate for arms (a) and (b), the README
claims no number not present there, and the demo has been recorded end to end.

## Risks

Real runs cost money and time: budget the task set up front, run unattended, and cap
concurrency. If pass rate drops under a lever, report that lever as harmful rather than
tuning the task set.
