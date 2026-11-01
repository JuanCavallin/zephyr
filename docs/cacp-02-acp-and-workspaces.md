# Step 2 — ACP extraction and workspaces

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §1 "Choice of integration surface", "Workspace". Owner: Person 1.

## Goal

A harness-agnostic ACP client that Hermes (and next, Claude Code) are thin configs over,
plus a git workspace provider giving every run an isolated worktree with per-turn
checkpoints.

## Files

- Create `apps/api/src/providers/_acp/client.ts` — transport (JSON-RPC over stdio),
  session lifecycle, drain loop, `session/request_permission` handling, cancellation.
- Create `apps/api/src/providers/_acp/config.ts` — `AcpHarnessConfig`:
  `{ binary, args, env(ctx), gatewayEnv(url, token), mcpServers, pinnedVersion }`.
- Modify `apps/api/src/providers/hermes/live.ts` — reduce to a config + the Hermes-specific
  bits; behaviour unchanged.
- Create `apps/api/src/providers/git/` — `index.ts` (registered as capability `workspace`),
  `live.ts` (real git), `mock.ts`.
- Create `apps/api/src/services/workspaces.service.ts`.
- Create `apps/api/src/providers/_acp/mockPeer.ts` — scripted ACP peer used by every
  contract test (spec §9 "contract-test against a mock ACP peer").

## Interfaces produced

```ts
interface WorkspaceProvider {
  create(runId: string, base: string): Promise<{ path: string; branch: string }>; // .data/workspaces/<runId>, zephyr/<runId>
  checkpoint(runId: string, turn: number): Promise<{ ref: string; treeHash: string }>;
  rewind(runId: string, ref: string): Promise<void>;
  diff(runId: string, since?: string): Promise<{ stat: string; hash: string; patch: string }>;
  dispose(runId: string, keepBranch: boolean): Promise<void>;
}
```

## Tasks

- [ ] **Characterize first.** Before touching `hermes/live.ts`, record what the existing
      Hermes check script covers; the refactor must keep it green unchanged.
- [ ] Extract client/transport into `_acp/client.ts`; make Hermes a config. Test: existing
      Hermes check passes, and the mock peer drives a full session (start, text chunks,
      permission request, cancel).
- [ ] Mock peer scenarios: normal completion, permission request allowed, permission denied,
      peer crash mid-turn, malformed JSON-RPC line. Assert each ends in a typed terminal
      state, never a hang (timeouts enforced by the client).
- [ ] Implement git provider: worktree under `.data/workspaces/<runId>` on branch
      `zephyr/<runId>`. Test against a temp repo fixture: create, edit, diff, dispose.
- [ ] Checkpoint = `git stash create` (or commit on a shadow ref); rewind restores tree
      exactly. Test: write file, checkpoint, write more, rewind → bytes equal checkpoint.
- [ ] Scrubbed env helper: given process env, return only gateway URL + scoped token + a
      minimal PATH/HOME allowlist. Test that ambient `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
      `AI_GATEWAY_API_KEY` are absent.
- [ ] Cleanup on terminal status unless the branch is kept; test that a crashed run's
      worktree is reaped on next startup.
- [ ] `pnpm check:acp` = mock peer suite + git provider suite.

## Windows notes

Worktree paths must stay short (long-path limits), use `path.win32`-safe joins, and kill
the harness **process tree** on cancel (`taskkill /T /F`), not just the parent. Add a test
that a child process spawned by the mock peer is gone after cancel.

## Done when

Hermes behaves identically on the new client; a mock-peer run creates a worktree, writes a
file, checkpoints each turn, rewinds, and disposes cleanly on both macOS/Linux and Windows.
