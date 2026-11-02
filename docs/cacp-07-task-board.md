# Step 7 — Task board: decomposition, leases, routing, merge queue

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §10, §13. Owners: Person 3 (tasks, leases, intents, merge queue), Person 2
(routing), Person 4 (UI, inbox). **Milestone M3.** Builds on `core/swarm.ts` `fanOut` and
`core/locks.ts` `KeyedLock`; no new execution engine.

## Goal

Type a request → reviewable board of tasks → Run ready tasks → several agents work in
parallel inside write leases → finished tasks pass a merge queue with evidence → a single
"Needs you" inbox covers every decision a human owes.

## Files

- Create `apps/api/src/core/coordination/` — `decompose.ts`, `conflictGraph.ts`,
  `leases.ts`, `intents.ts`, `integrator.ts`, `mergeQueue.ts`, `stateMachine.ts`.
- Create `apps/api/src/services/tasks.service.ts`; `apps/api/src/api/tasks.routes.ts`
  (replace the step 1 `_demo` mock path with real handlers, keep it behind the flag).
- Modify `core/decisions/service.ts` — `routeTask` real implementation (replaces mock).
- Modify `core/tools/permissionBridge.ts` — call `checkLease` (the step 1 seam).
- Web (`apps/web`): board, decomposition review, inbox.

## Tasks

### Decomposition and waves
- [x] `decompose(request)`: frontier read-only planner (the existing synthesizer) returns
      tasks `{title, acceptance, writeScope: glob[], deps: id[]}`. Zod-validate; reject
      cyclic deps.
- [x] `conflictGraph`: tasks conflict when write scopes overlap; group into waves of
      non-overlapping tasks honoring deps. Tests: disjoint → one wave, overlapping → split,
      dependency chain → ordered waves, glob overlap cases (`src/**` vs `src/a/x.ts`).
- [x] Nothing runs on a fresh request until **Run ready tasks** (test: no run starts from
      `POST /api/tasks` alone).

### Leases and intents
- [x] `leases`: per-task write lease over globs; broker denies out-of-lease edits with a
      reason. Extension request auto-granted if no overlap, else queued/approval. Leases
      expire; resume re-requests. Tests for each branch plus expiry.
- [x] Hot files (`package.json`, lockfiles, route registries, barrel `index.ts`, shared
      schemas) are never leased. Agents submit `HotFileIntent`; `integrator` applies intents
      serially under a `KeyedLock`. Test: two concurrent `package.json` intents both land,
      in submission order, with no corruption.
- [x] Reads unrestricted inside the repo; reads outside still follow step 3 rules.

### Routing
- [x] `routeTask`: Jev `choice` over candidates (harness × tier, local, human) with task
      features and each candidate's history/load. Fallback rules: small → cheap tier;
      UI → assignee with most design preferences; failing twice → escalate. User pins
      override. Test pin beats Jev; Jev down → rule result with `source: 'fallback'`.

### State machine and progress
- [x] `pending → ready → running → review → done`, plus `blocked`/`failed`; illegal
      transitions throw. Events carry `taskId`. Progress derived from tests, files changed,
      tokens, turns — never agent-reported (test that agent text cannot set progress).
- [x] Each task owns run, branch, worktree (step 2). Stuck or over-budget → `blocked` with
      reason; leases released.

### Merge queue
- [x] Rebase onto the integration branch, rerun selected tests (step 6), attach evidence.
      Conflict or failure spawns a fix task back to the same agent with the conflict as
      context. Merge to `main` = `git.publish` → approval unless policy auto-merges green.
      Test: three green tasks merge; one conflicting task produces a fix task; failing tests
      block the merge.
- [x] Merge queue and approvals call `recordSignal` (feeds step 8).

### Inbox and UI (Person 4)
- [x] "Needs you" lists approvals, blocked tasks and reviews, oldest first, over SSE. Test:
      every pending approval in the store appears in the inbox.
- [x] Board cards update independently from `task.*` events; decomposition review supports
      split, merge, reorder, edit scope, pin assignee.

### Verification
- [x] `pnpm check:board` on mocks: three parallel tasks, an out-of-lease edit denied, two
      `package.json` intents landed, merge queue merges all green.

## Done when

The spec's Person 3 done-condition holds live: three tasks at once, out-of-lease edit
denied, two `package.json` intents both land, merge queue merges all three.

## Status (2026-11-02)

Every task above is implemented on branch `juan`. Where it lives:

- Planning and waves: `core/coordination/decompose.ts`, `conflictGraph.ts`.
- Leases, intents, integrator, merge queue, state machine: the other files in `core/coordination/`. The lease check is in `core/tools/permissionBridge.ts`.
- Routing: `core/decisions/routing.ts` and `DecisionService.routeTask`. Jev returns a `choice`; a pin beats it; the rules are the fallback.
- Service and HTTP: `services/tasks.service.ts`, `services/board.runtime.ts`, `api/tasks.routes.ts`. `_demo` stays dev-only.
- Web: `/board` and `/board/:id` (`apps/web/src/pages/Board.tsx`, `lib/board.ts`, `hooks/useBoard.ts`), with the "Needs you" inbox alongside.

Verification:

- `pnpm check:board`: 38 checks on mocks, offline. Section 8 is the done condition end to end, on real git worktrees with the scripted mockharness behind the real permission bridge.
- `apps/web`: `pnpm test` (board reducer and helpers) and `pnpm test:board-browser`. The browser test runs against a mock API and exercises plan, edit scope, pin, reorder, merge, split and the inbox.
- Not yet run: the done condition with live Claude Code or Codex harnesses. Every check uses mockharness.

## Risks

Write-scope estimates are guesses; the lease check is the backstop, so denials must be
cheap to extend rather than fatal. Keep the concurrency cap low by default (Windows
process and disk pressure).
