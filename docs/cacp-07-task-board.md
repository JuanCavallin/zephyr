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
- [ ] `decompose(request)`: frontier read-only planner (the existing synthesizer) returns
      tasks `{title, acceptance, writeScope: glob[], deps: id[]}`. Zod-validate; reject
      cyclic deps.
- [ ] `conflictGraph`: tasks conflict when write scopes overlap; group into waves of
      non-overlapping tasks honoring deps. Tests: disjoint → one wave, overlapping → split,
      dependency chain → ordered waves, glob overlap cases (`src/**` vs `src/a/x.ts`).
- [ ] Nothing runs on a fresh request until **Run ready tasks** (test: no run starts from
      `POST /api/tasks` alone).

### Leases and intents
- [ ] `leases`: per-task write lease over globs; broker denies out-of-lease edits with a
      reason. Extension request auto-granted if no overlap, else queued/approval. Leases
      expire; resume re-requests. Tests for each branch plus expiry.
- [ ] Hot files (`package.json`, lockfiles, route registries, barrel `index.ts`, shared
      schemas) are never leased. Agents submit `HotFileIntent`; `integrator` applies intents
      serially under a `KeyedLock`. Test: two concurrent `package.json` intents both land,
      in submission order, with no corruption.
- [ ] Reads unrestricted inside the repo; reads outside still follow step 3 rules.

### Routing
- [ ] `routeTask`: Jev `choice` over candidates (harness × tier, local, human) with task
      features and each candidate's history/load. Fallback rules: small → cheap tier;
      UI → assignee with most design preferences; failing twice → escalate. User pins
      override. Test pin beats Jev; Jev down → rule result with `source: 'fallback'`.

### State machine and progress
- [ ] `pending → ready → running → review → done`, plus `blocked`/`failed`; illegal
      transitions throw. Events carry `taskId`. Progress derived from tests, files changed,
      tokens, turns — never agent-reported (test that agent text cannot set progress).
- [ ] Each task owns run, branch, worktree (step 2). Stuck or over-budget → `blocked` with
      reason; leases released.

### Merge queue
- [ ] Rebase onto the integration branch, rerun selected tests (step 6), attach evidence.
      Conflict or failure spawns a fix task back to the same agent with the conflict as
      context. Merge to `main` = `git.publish` → approval unless policy auto-merges green.
      Test: three green tasks merge; one conflicting task produces a fix task; failing tests
      block the merge.
- [ ] Merge queue and approvals call `recordSignal` (feeds step 8).

### Inbox and UI (Person 4)
- [ ] "Needs you" lists approvals, blocked tasks and reviews, oldest first, over SSE. Test:
      every pending approval in the store appears in the inbox.
- [ ] Board cards update independently from `task.*` events; decomposition review supports
      split, merge, reorder, edit scope, pin assignee.

### Verification
- [ ] `pnpm check:board` on mocks: three parallel tasks, an out-of-lease edit denied, two
      `package.json` intents landed, merge queue merges all green.

## Done when

The spec's Person 3 done-condition holds live: three tasks at once, out-of-lease edit
denied, two `package.json` intents both land, merge queue merges all three.

## Risks

Write-scope estimates are guesses; the lease check is the backstop, so denials must be
cheap to extend rather than fatal. Keep the concurrency cap low by default (Windows
process and disk pressure).
