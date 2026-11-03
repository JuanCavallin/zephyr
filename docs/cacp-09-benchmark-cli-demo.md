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
recorded, and the demo has not been recorded. The board CLI is verified end to end
against the real API (offline).

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
  - `--mode live` now runs every arm, and needs `--yes-spend`.
    - The vanilla arm runs Claude Code `-p`.
    - The Zephyr arms run `supervisedClaudeAgent`
      (`services/benchmarkCoding.supervised.ts`). For each run it starts the Anthropic gateway,
      the hook callbacks and the MCP gateway in-process. It then drives Claude Code over ACP in
      a Zephyr worktree and reads tokens and cost from the gateway ledger.
    - `--model` applies to both arms. The Zephyr arms also need `ANTHROPIC_API_KEY` (or
      `ANTHROPIC_BASE_URL`).
  - `check:benchmark-coding` covers this offline, with a fake ACP peer and a fake upstream.
  - **No live run has been made**, so `/compare` has only mock data.
  - Next: one priced pilot (2 arms × 1 task × 3 reps) to estimate the cost per run. Then
    budget the full set and get the spend approved before running it.
- **Mock harness.**
  - It replays reference fixes with synthetic token counts, derived from the bytes it moves.
  - Approvals and blocks come from the real permission bridge.
  - Its per-arm token differences test the measuring, not Zephyr.
- **Demo.**
  - The script is in `docs/DEMO.md`. It has not been rehearsed on a real feature, and has not
    been recorded.
- **Fresh-user timing.**
  - Timing a fresh clone through `pnpm install` and `zephyr up` to a running board has not
    been done; it needs a clean machine.
  - Measured part: `check:cli-e2e` records the API's time from boot to healthy, about 3.5s.
  - `zephyr up --check` was run on a dev machine and detected `claude.exe` and the
    `codex.cmd` shim.

**Board CLI (done).** `check:cli-e2e` starts two real API processes on mock providers, each
against a throwaway git repo. On the `GIT_MODE=live` one, `zephyr run "<task>" --wait` plans a
board and starts it. It stops at the merge approval with exit code 3. Approving through
`/api/approvals/:id/decide` then finishes the board, and every task's commits end up on its
integration branch. `main` is untouched.
- The board needs `GIT_MODE=live`, because the merge queue rebases and fast-forwards with git.
  - On mock workspaces, "Run ready tasks" answers `503 BOARD_UNAVAILABLE`, which names the fix.
  - `zephyr up --check` reports the mode.
  - `--wait` exits 0 when the work is merged, 3 when it needs you (an inbox item for this
    board), and 1 when it failed or timed out.
  - `--variants 2|3` builds that many versions of every task, through the same board edit
    as the card's "Build" selector. When more than one works, "Needs you" shows a picker
    (cacp-08's `VariantPicker`), and `--wait` exits 3. Checked in `check:cli`,
    `board.check.ts` section 9 and the web tests. It has not been run on a real harness.

**Checks:** `check:benchmark-coding`, `check:cli`, `check:cli-e2e`, `check:workspace-view`,
`check:board` and the web tests all pass.
- `/compare` was viewed in the browser against a 396-run mock journal: 22 tasks × 6 arms × 3
  repetitions, which took about 1 minute.

## Done when

The Compare page shows measured tokens and pass rate for arms (a) and (b), the README
claims no number not present there, and the demo has been recorded end to end.

## Risks

Real runs cost money and time: budget the task set up front, run unattended, and cap
concurrency. If pass rate drops under a lever, report that lever as harmful rather than
tuning the task set.
