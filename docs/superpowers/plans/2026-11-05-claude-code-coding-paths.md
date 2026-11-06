# Claude Code coding paths (board executor, publish, graph `coding_task`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coding work in Zephyr runs on Claude Code (subscription login), can push its branch to the
remote behind one human approval, and is available as a workflow-graph node.

**Architecture:** One helper drives Claude Code in a worktree someone else opened
(`runClaudeCodeInWorktree`). The board uses it as its `TaskExecutor` when `CLAUDECODE_MODE=live`; a new
graph node type `coding_task` uses it through an optional `PlaybookContext.runCodingTask` seam. Pushing
reuses `publishRun` (approval bound to branch + diff hash), with the `gh pr create` step made optional
because `gh` is not installed on this machine.

**Tech Stack:** TypeScript, Express, zod, ACP (`claude-agent-acp` 0.99.1), git worktrees. Checks are
`tsx scripts/*.check.ts` scripts; `pnpm -C apps/api typecheck`.

**Spec:** this conversation; [docs/agentos-design.md](../../agentos-design.md) for the safety invariants.

## Global Constraints

- `authorize_action` is never skipped: every native tool call goes through `createPermissionBridge`.
- Pushing is irreversible: it always waits for a human approval (`git.publish`, bound to branch + diff hash).
- Nothing ever pushes to, merges into, or checks out `main`. Pushes go to `zephyr/<runId>` branches.
- Subscription auth stays the default; no code path may set ANTHROPIC_* for Claude Code in that mode.
- Mock / offline behaviour is unchanged when `CLAUDECODE_MODE` is not `live`.

## Review Focus

1. Claude Code writes outside a board task's write scope → denied by the lease, not merged. (Task 1 test)
2. A board where every task merged but the push approval is pending → `zephyr run --wait` exits 3, not a 30-min timeout. (Task 3 test)
3. `gh` missing → `publish: "branch"` still pushes; `publish: "pr"` reports a blocked `pr` stage after the push. (Task 1 test)
4. A `coding_task` on an API without live Claude Code / live git → a clear error naming the env vars, not a crash. (Task 4 test)
5. The run is cancelled mid-turn → Claude Code is cancelled and its hook token revoked; the worktree is left for the board/graph to close. (Task 2 test)

---

### Task 1: Primitives — optional PR, task-bound leases, attach mode

**Files:**
- Modify: `apps/api/src/core/verify/publish.ts` (`PublishInput.openPr?: boolean`, default true; `publishCommands` omits `gh` when false)
- Modify: `apps/api/src/services/publish.service.ts` (`PublishOptions.openPr?`, `PublishOptions.workspaceRunId?`: worktree, branch and diff come from it; approvals and events stay on `runId`)
- Modify: `apps/api/src/core/tools/permissionBridge.ts` (`PermissionBridgeOptions.taskId?`: used when a request carries none)
- Modify: `apps/api/src/providers/claudecode/live.ts` (`ClaudeCodeRuntimeDeps.attach?`)
- Test: `apps/api/scripts/claudecode-coding.check.ts` (new; `check:claudecode-coding` in package.json)

**Interfaces — Produces:**
- `attach?: (runId: string) => { path: string; branch: string; workspaceRunId: string; taskId?: string; leases?: PermissionBridgeSeam } | undefined` — when it returns a value, `startTask` does not open a workspace; checkpoints and diffs use `workspaceRunId`.

- [ ] Tests: `publishCommands(..., openPr false)` has no `gh` entry; bridge with `taskId` + a lease table denies a Write outside the lease and allows one inside; runtime with `attach` on the mock peer writes into the attached dir and checkpoints `workspaceRunId`, never calling `open`.
- [ ] Implement; run `pnpm -C apps/api check:claudecode-coding` and `check:claudecode` and `check:verify` (no regressions).

### Task 2: `runClaudeCodeInWorktree` + board executor

**Files:**
- Create: `apps/api/src/services/claudeCodeRunner.ts`
- Modify: `apps/api/src/services/board.runtime.ts` (when `config.providers.claudecode.mode === 'live'`: `executor` + `candidates: [{agent, claudecode, standard}, {human, reviewer}]`)
- Modify: `apps/api/src/services/tasks.service.ts` (`TaskExecutionContext.workspaceRunId: string`, set from the variant's workspace run id)

**Interfaces — Produces:**
- `runClaudeCodeInWorktree(runtime: ClaudeCodeRuntime & { attachments: Attachments }, input: { runId; stepId; workspace: { runId; path; branch }; goal; taskId?; leases?; signal; timeoutMs?; pollMs?; onPoll?(): Promise<void> }): Promise<{ status: 'done' | 'failed'; text: string; detail?: string; toolCalls: number }>` — always cancels the task (teardown) before returning; throws only what `onPoll` throws.
- `claudeCodeExecutor(opts?: { runtime?; pollMs?; timeoutMs? }): TaskExecutor` — goal = `boardTaskPrompt(task)` (title first line, acceptance, write scope, "do not commit or push"); each poll observes `git status` files on the tracker and calls `ctx.step()`; one `observeTurn()` at the end.
- `sharedClaudeCode(): ClaudeCodeRuntime & { attachments }` — the process-wide live runtime with an attach map.

- [ ] Tests (mock peer): executor writes the file → `done`, tracker `filesChanged >= 1`; `error` scenario → `failed` with detail; abort mid-`slow` turn → `failed`/cancelled and the hook token is revoked.
- [ ] Implement; run the check + `check:board`.

### Task 3: Board publish

**Files:**
- Modify: `apps/api/src/services/tasks.service.ts` (`CreateBoardInput.publish?: 'none' | 'branch' | 'pr'` stored on the board and in `run.input`; `BoardServiceDeps.publish?`; after every task merged, one `publish` step on the board run, then `deps.publish(...)`; summary records pushed branch / PR / blocked reason; inbox maps approvals on the board run itself to `boardRunId`)
- Modify: `apps/api/src/services/board.runtime.ts` (`publish` → `publishRunLive(boardRunId, { stepId, title, openPr, base: 'main' })`)
- Modify: `apps/api/src/api/tasks.routes.ts` (`createBoardBody.publish`)
- Modify: `packages/cli/src/run.ts`, `packages/cli/src/main.ts` (`--publish <branch|pr>`)

- [ ] Tests: a board with a fake `publish` dep calls it exactly once after all tasks merge, with `openPr` matching the option; with `publish` unset it is never called; an approval on the board run appears in `inbox()` with `boardRunId`.
- [ ] Implement; run the check, `check:board`, `check:cli`.

### Task 4: Graph `coding_task` node

**Files:**
- Modify: `packages/shared/src/schemas/graph.ts` (type + `codingTaskNodeSchema`: `goal`, `base?`, `publish: 'none'|'branch'|'pr'` default `'none'`, `title?`, `maxDurationMs?` 60_000–3_600_000)
- Modify: `packages/shared/src/executors.ts` (`coding_task: 'agent'`, icon)
- Modify: `apps/api/src/core/playbooks/types.ts` (`CodingTaskSpec`, `CodingTaskResult`, `runCodingTask?`)
- Modify: `apps/api/src/core/graph/interpreter.ts` (`runCodingTaskNode`: refuses `local_only`/`secret` labels; clear error when the seam is absent)
- Modify: `apps/api/src/core/orchestrator.ts` (`OrchestratorDeps.codingTask?` → `ctx.runCodingTask`)
- Create: `apps/api/src/services/codingTask.service.ts` (`runCodingTaskLive`: needs live claudecode + git; opens workspace `<runId>_<nodeId>` at `base`; runs Claude Code; no changes → fail; `publish: none` → commit locally and keep the branch; else `publishRunLive` with `workspaceRunId`; always closes the worktree, keeping the branch)
- Modify: `apps/api/src/services/runtime.ts` (wire `codingTask`)
- Modify: `apps/api/src/core/graph/synthesisPrompt.ts` (a `coding_task` rung: repo code changes go here, not to `agent_task`; `publish: "branch"` only when the user asks to push)
- Modify: `apps/web/src/components/graph/nodeDefaults.ts` (label + default config)

- [ ] Tests: schema accepts a minimal `coding_task` and rejects a bad `publish`; interpreter with a fake `runCodingTask` passes resolved goal/publish/stepId and returns its output; without the seam the step fails naming `CLAUDECODE_MODE`/`GIT_MODE`; `runCodingTaskLive` end to end on a temp git repo + mock peer, `publish: none` → branch has a commit with the file, worktree removed.
- [ ] Implement; run the check, `check:graph`, `check:code-node`, `pnpm -C apps/api typecheck`, `pnpm -C apps/web typecheck`.

### Task 5: Live verification

- [ ] Restart the API; rerun the user's prompt with `zephyr run "<prompt>" --template add-feature --publish branch --wait`; confirm the task diffs are real code, `main` / `origin/main` unchanged, and the push waits in "Needs you".
