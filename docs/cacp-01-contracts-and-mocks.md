# Step 1 — Contracts and mocks

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §15 "Day 0 contracts". Owner: everyone, a few hours. **Milestone M1.**

## Goal

Every cross-stream interface exists as a zod schema in `packages/shared`, each has a
deterministic mock, and a fake board runs end to end on mocks. After this step nobody
waits on anyone.

## Deliverables

1. Additive schemas in `packages/shared/src/` (new file `coding.ts`, re-exported from
   `index.ts`; extend `events.ts` and `providers.ts`):
   - `Task`, `TaskStatus` (`pending | ready | running | review | done | blocked | failed`),
     `Assignee`, `Lease`, `HotFileIntent`
   - `NativeToolRequest` (harness, tool name, raw input, session id)
   - `PreferenceSignal`, `Preference`, `Skill`, `SkillProposal`
   - `EvidenceBundle`
   - events: `task.*` (created, status, progress), `lease.*` (granted, denied, extended,
     expired), `learning.*` (signal, candidate, activated, retired), plus
     `tool.lifecycle`, `harness.turn.ended` if not already present
2. `AgentRuntimeAdapter.onPermissionRequest?` added to `providers.ts` (spec §1 signature).
3. The three seam functions from spec §15 as typed interfaces, one per seam:
   - permission bridge: P1 → P3 `checkLease(taskId, path, mode): LeaseDecision`
   - routing: P3 scheduler → P2 `routeTask(task, candidates): Promise<Assignee>`
   - signals: P3 merge queue and P4 variant picker → P2 `recordSignal(s: PreferenceSignal)`
4. Mocks (each next to its owner's area, all deterministic, no network):
   - `providers/mockharness` — scripted harness that emits tool requests and edits a temp dir
   - mock `routeTask`, mock `recordSignal` (in-memory log), mock `checkLease` (allow-all)
   - mock `EvidenceBundle` factory
5. A seeded fake board: `POST /api/tasks/_demo` creates 3 tasks that progress through
   statuses on a timer via the mock harness and emit `task.*` events on the existing SSE
   stream, so P4 can build the board UI immediately.

## Tasks

- [x] Write `packages/shared/src/coding.ts` with the schemas above; export types via `z.infer`.
- [x] Test (`packages/shared` has no runner, so this lives in
      `apps/api/scripts/contracts.check.ts` like the other checks): each schema round-trips a valid
      fixture and rejects an invalid one (e.g. `Task` with unknown status, `Lease` with an
      empty glob list, `EvidenceBundle` missing the diff hash).
- [x] Add event types to the discriminated union in `events.ts`; test that an unknown
      `type` is still rejected and the existing event fixtures still parse.
- [x] Add the three seam interfaces and mocks; one test per mock showing deterministic output
      for identical input.
- [x] Add `api/tasks.routes.ts` with the `_demo` endpoint behind the dev flag; register in
      `api/index.ts`.
- [x] `pnpm check:contracts` runs the schema and mock tests; wire into the aggregate check.

## Done when

`pnpm check:contracts` is green, `/api/tasks/_demo` produces task events visible on the SSE
stream, and each owner has signed off on the seam signatures (change them afterwards only
by telling the other owner).

## Pitfalls

- Keep schemas additive: do not alter existing event shapes the web app already parses.
- `Lease` globs must be repo-relative POSIX-style paths even on Windows; normalise at the
  boundary, not in the schema.
