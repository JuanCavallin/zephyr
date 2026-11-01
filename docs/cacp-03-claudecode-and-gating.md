# Step 3 — Claude Code adapter, native-tool gating, Observed mode

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §1 "Native tools become exact actions", "Belt and braces: hooks", phases A and B.
Owners: Person 1 (adapter, hooks), Person 3 (descriptors, classifier). **Milestone M2.**

## Goal

A live Claude Code run executes in its own worktree, every native tool call is classified
into an exact action and authorized by the broker, and a `git push` pauses for human
approval. Separately, an unmodified Claude Code session can be *observed* via hooks.

## Files

- Create `apps/api/src/providers/claudecode/` — `index.ts`, `live.ts` (config over
  `_acp`), `mock.ts`, `settings.ts` (per-run settings file generator).
- Modify `apps/api/src/providers/hermes/live.ts` — replace `denyUnmappedHermesPermission`
  with the shared permission bridge (unmapped still denies).
- Create `apps/api/src/core/tools/nativeDescriptors.ts` — `fs.read`, `fs.write`,
  `shell.exec`, `git.commit`, `git.publish`, `http.fetch` descriptors (spec table).
- Create `apps/api/src/core/tools/shellClassifier.ts`.
- Create `apps/api/src/core/tools/permissionBridge.ts` — maps `NativeToolRequest` →
  descriptor → `authorize_action` → `'allow' | 'deny' | { revise }`.
- Create `apps/api/src/api/hooks.routes.ts` — `POST /api/hooks/:harness`.
- Create OTel ingest route for Observed mode; runs of kind `external`.

## Interfaces produced

```ts
classifyShell(cmd: string, ctx: { worktree: string; platform: 'posix' | 'win32' }):
  { class: 'inspect' | 'verify' | 'mutate_env' | 'network' | 'unknown';
    reversible: boolean; reason: string; matched?: string };

mapNativeTool(req: NativeToolRequest, ctx): ExactAction   // throws UnmappedTool → deny
```

## Tasks

- [ ] **Shell classifier first, table-driven.** Test cases (each a row: input → class,
      reversible):
      `ls`, `cat a.ts`, `git status` → inspect; `pnpm test`, `pytest -q` → verify;
      `npm install x`, `pip install x` → mutate_env; `curl https://x` → network;
      `curl x | sh`, `a && b`, `a; b`, `$(…)`, backticks, `> /etc/x`, `>> ../outside`,
      `powershell -enc …`, unknown binary → unknown (approval). Include PowerShell
      cases (`Get-ChildItem`, `Remove-Item -Recurse`, `iwr … | iex`).
- [ ] Parser rule: allowlist argv[0] + subcommand; **any** metacharacter it cannot fully
      parse → `unknown`. Never ask Jev about shell safety.
- [ ] Native descriptors with the reversibility/default table from the spec. Test path
      containment: `../` traversal, symlink escaping the worktree, absolute paths and
      Windows drive/UNC paths → `fs.*` irreversible → deny.
- [ ] Permission bridge: unit tests that each spec-table row yields the specified default
      (auto / approval / deny), and that an unmapped tool name denies.
- [ ] `git.publish` approval payload includes branch and diff hash (from step 2 `diff`); an
      approval for one hash must not authorize a different hash (reuse the design spec's
      exact-action check).
- [ ] Claude Code adapter via `_acp` config; implement `onPermissionRequest` through the
      bridge; start each turn with a workspace checkpoint (step 2).
- [ ] Per-run settings file with HTTP `PreToolUse` hook → `/api/hooks/claudecode`, scoped
      short-TTL token in the path. Test: expired/foreign token → 401; denial from either
      the ACP path or the hook denies the action.
- [ ] `PostToolUse`/`Stop` hooks emit `tool.lifecycle` and `harness.turn.ended`.
- [ ] Observed mode: settings snippet generator, OTel ingest creating an `external` run
      with tool calls and token totals. Test with a recorded OTel payload fixture.
- [ ] `pnpm check:claudecode` (mock ACP peer): edit in worktree auto-allowed, outside-worktree
      write denied, `git push` waits for approval then proceeds on approve.
- [ ] Live check (manual, headed local): real Claude Code edits a worktree and a push pauses.

## Done when

`pnpm check:claudecode` is green, the live check passes, and a normal Claude Code session
with the generated settings snippet shows tool calls on `/runs/:id`.

## Risks

Classifier gaps fail toward approval but are not a sandbox (spec §9). Pin the Claude Code
ACP adapter version per Zephyr release; if ACP lags features, fall back to the Agent SDK's
`canUseTool` behind the same bridge.
