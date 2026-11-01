# Step 5 — Token levers L1–L3

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §2 L1, L2, L3, §6. Owners: Person 3 (L1, L3), Person 2 (L2). Needs steps 3 and 4.

## Goal

The cheapest-per-effort levers that cut tokens without touching the cache prefix:
shaped test/build/lint output, a Jev-ranked context pack, and a minimal, stable tool set.
Each lever is a per-run policy switch so the benchmark (step 9) can attribute savings.

## Files

- Create `apps/api/src/core/tools/shaped/` — `runTests.ts`, `build.ts`, `lint.ts`,
  `parsers/{junit,tap,rawFallback}.ts`, `outputStore.ts` (handles).
- Expose them as MCP tools `zephyr.run_tests`, `zephyr.build`, `zephyr.lint`,
  `zephyr.test_output` via the existing `api/mcp.routes.ts` / `core/mcp`.
- Modify `shellClassifier.ts` (step 3): raw test/build commands → deny with a reason
  pointing at the shaped tool.
- Create `apps/api/src/core/context/` — `repoIndex.ts` (path, exports, symbols, first doc
  comment; deterministic, cached by tree hash), `candidates.ts`, `pack.ts`.
- Modify `apps/api/src/core/decisions/service.ts` — add `scoreFiles` question.
- Modify harness configs (`claudecode/live.ts`) — `--strict-mcp-config`, native-tool
  disable list per task class.
- Add policy fields: `levers: { shapedTools, contextPack, schemaMin }` (default on).

## Interfaces produced

```ts
type Digest = { total: number; passed: number; failed: number;
  failures: { id: string; assertion: string; trace: string }[];
  handle: string; rawTokens: number; digestTokens: number };

buildContextPack(task: string, repo: RepoIndex, opts: { maxCandidates: 40; topK: number }):
  Promise<{ files: { path: string; score: number; source: 'jev' | 'fallback' }[]; prompt: string }>
```

## Tasks

### L1 shaped tools
- [ ] Parsers with fixtures: JUnit XML, TAP, and raw fallback (keep lines near
      `FAIL`/`Error`/`expected`). Test: a 10k-line raw log → digest under a token cap that
      still contains every failing test id.
- [ ] `outputStore`: `zephyr.test_output(handle, testId)` returns the full failure; bad or
      expired handle → clear error, not empty success.
- [ ] Executors run in the worktree with the scrubbed env, timeout and output cap; test
      timeout and runaway-output behavior.
- [ ] Classifier deny reason for raw commands; test that the denial is a logged broker
      decision and that the shaped tool itself is auto-allowed (`verify`).

### L2 context pack
- [ ] Deterministic candidates: identifiers from task text, recent commits on related
      paths, imports, covering tests; hard cap 40. Test on a fixture repo.
- [ ] One Jev `score` question per file in a **single request** (state = task + one-line
      summary per file). Fallback = deterministic rank. Test both paths; every pick emits
      a decision event with `source`.
- [ ] Prompt assembly: compact map + full text of top 2–3 under a token cap.
- [ ] Cache context-pack decisions by (task hash, tree hash). Test cache hit skips Jev.

### L3 schema minimization
- [ ] Strict MCP config and per-task-class native-tool disable list; the tool set is chosen
      **once at session start** and never changed mid-session. Test: tool list identical on
      every gateway request in a run (inspect via the step 4 replay harness).

### Verification
- [ ] `pnpm check:levers`: digest/parsers, classifier denial, context pack fallback and Jev
      path (stubbed), stable-tool-set assertion.
- [ ] Manual: run one real task with and without the levers; record input tokens for both
      (feeds step 9).

## Done when

A real task shows "test output digested: N → M tokens" in the trace, the context pack
replaces early exploration turns, and tool definitions are byte-stable across turns.
