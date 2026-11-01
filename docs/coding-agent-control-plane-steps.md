# Coding-agent control plane — implementation steps

Breakdown of [coding-agent-control-plane.md](coding-agent-control-plane.md) (the spec) into
nine buildable steps. Each step has its own file with files, interfaces, tasks and the
test that proves it. Where a step file and the spec disagree, the spec wins; where the
spec and [agentos-design.md](agentos-design.md) disagree, the design spec wins.

| # | Step | Spec sections | Owner (spec §15) | Depends on |
|---|---|---|---|---|
| 1 | [Contracts and mocks](cacp-01-contracts-and-mocks.md) | §15 Day 0 | everyone | — |
| 2 | [ACP extraction and workspaces](cacp-02-acp-and-workspaces.md) | §1 (harness, workspace) | P1 | 1 |
| 3 | [Claude Code adapter, native-tool gating, Observed mode](cacp-03-claudecode-and-gating.md) | §1 (native tools, hooks), phase A+B | P1 + P3 | 1, 2 |
| 4 | [Cache-safe model gateway](cacp-04-model-gateway.md) | §2 L4, §9 gateway fidelity | P1 | 1 |
| 5 | [Token levers L1–L3](cacp-05-token-levers.md) | §2 L1–L3, §6 | P3 + P2 | 3, 4 |
| 6 | [Verification and evidence](cacp-06-verification-and-evidence.md) | §3 | P3 + P2 | 3, 5 |
| 7 | [Task board: decomposition, leases, routing, merge queue](cacp-07-task-board.md) | §10, §13 | P3 + P2 + P4 | 3, 6 |
| 8 | [Learning loop](cacp-08-learning-loop.md) | §11 | P2 | 6, 7 |
| 9 | [Benchmark, CLI and demo](cacp-09-benchmark-cli-demo.md) | §5, §7, §13, §14 | P2 + P4 | 4–8 |

## Order and parallelism

```
1 ─┬─ 2 ── 3 ──┬─ 5 ── 6 ── 7 ── 8 ──┐
   └─ 4 ───────┘                      └─ 9
```

- Step 1 unblocks everyone; after it, **2 and 4 run in parallel** (both P1, so split if
  a fifth pair of hands exists), and P4 can start the board UI on mocks.
- Steps 5–6 run in parallel with early step 7 work (decomposition and the conflict graph
  need no live harness, only the mock).
- Milestones from spec §15: M1 = step 1, M2 = steps 2–3 plus a thin board, M3 = step 7,
  M4 = step 8, M5 = step 9.
- Cut line if time runs out (spec §14 "Core"): 1, 2, 3, 7 (without merge queue), 5 (L1
  and L2 only), 9. Learning (8) and full verification (6) degrade to their mocks.

## Conventions every step follows

- Dependency rule: `api → services → core`; providers hold all SDK/subprocess code.
- Every Jev use is a `choice`/`score`/`probability` question with a deterministic
  fallback and a decision event carrying `source`. Authorization never consults Jev.
- Contracts are additive zod schemas in `packages/shared/src`; each owner ships a
  deterministic mock before the real thing.
- Each step ends with a `pnpm check:*` script (or an added case in an existing one) that
  runs offline against mocks, and a short live check that is allowed to be manual.
- Windows is a first-class dev platform: path, shell-parsing and process-tree behavior
  get explicit tests in the step that introduces them.
