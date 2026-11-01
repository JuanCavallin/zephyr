# Step 4 — Cache-safe model gateway

Part of [coding-agent-control-plane-steps.md](coding-agent-control-plane-steps.md).
Spec: §2 L4, §9 "Gateway fidelity", "Cache regressions". Owner: Person 1. Can run in
parallel with step 2.

## Goal

Claude Code points `ANTHROPIC_BASE_URL` at Zephyr and cannot tell the difference: the
`/v1/messages` surface is faithful (streaming, thinking, tool use, `count_tokens`,
errors), never breaks prompt caching, and accounts every token including cache reads and
writes. `/v1/responses` (Codex) is added later in the same shape.

## Files

- Modify `apps/api/src/core/modelGateway/service.ts` — add an Anthropic Messages passthrough
  with hooks for routing, budget and accounting; keep existing OpenAI-compatible surface.
- Create `apps/api/src/core/modelGateway/messages.ts` — request/response/stream handling.
- Create `apps/api/src/core/modelGateway/cacheLedger.ts`.
- Modify `apps/api/src/api/modelGateway.routes.ts` — `POST /v1/messages`,
  `POST /v1/messages/count_tokens`, auth by scoped run token.
- Create `apps/api/src/core/modelGateway/replay/` — recorded-traffic fixtures + replayer.

## Tasks

- [ ] **Record first.** Capture real Claude Code ↔ Anthropic traffic (a short session with
      tool use and thinking) as fixtures. Scrub keys. This is the oracle for fidelity.
- [ ] Passthrough streaming: SSE events (`message_start`, `content_block_delta`,
      thinking deltas, `tool_use` blocks, `message_delta`, `message_stop`) forwarded
      byte-for-byte in order. Replay test: gateway output equals recorded upstream output.
- [ ] Errors: upstream 4xx/5xx/overloaded and mid-stream disconnects surface as the same
      status and error body shape Anthropic returns. Test each from a fake upstream.
- [ ] Cache safety (the central invariant): forward `cache_control` untouched; request
      body prefix bytes identical to the client's. Test: send two consecutive turns through
      the gateway and assert the upstream received an unmodified prefix.
- [ ] Deterministic redaction placeholders `[[PII_n]]` stable per session. Test: same
      secret across turns → same placeholder; different run → independent numbering.
- [ ] Rewrite hook exists but is **off outside compaction points** (used later by L5);
      test that an ordinary turn is never modified.
- [ ] `cacheLedger`: record `input`, `output`, `cache_creation_input_tokens`,
      `cache_read_input_tokens` separately per call and per run; expose hit rate. Test with
      fixtures containing cache fields and without them.
- [ ] Budget: per-run token/cost cap; over budget → `blocked` event and a well-formed
      refusal the harness surfaces, never a silent continue.
- [ ] Per-turn tool budget (default 8) applies to harness traffic via the existing logic.
- [ ] `/v1/messages/count_tokens` passthrough.
- [ ] Auth: scoped per-run token validated on every call; unknown token → 401; token for a
      finished run → 403.
- [ ] `pnpm check:gateway` = replay + cache-prefix + ledger + budget tests, offline.

## Done when

A live Claude Code session pointed at the gateway completes a real task, the ledger shows
non-zero `cache_read_input_tokens` after turn 2, and the replay suite is green.

## Later (same step shape, phase E)

`/v1/responses` for Codex with its own recorded fixtures; share the ledger and budget
code, not the wire handling.
