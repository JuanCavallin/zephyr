# Agent, benchmark and live supervision readiness — 2026-10-17

The implementation foundation exists, but a passing mock demo is not sufficient evidence for a safe, accurate live benchmark. This audit found concrete runtime and measurement gaps. Fix the baseline privacy bypass before sensitive runs, and fix provenance/quality scoring before relying on benchmark savings.

## Resolution status (later on 2026-10-17)

The P0/P1 findings below are fixed in code with offline regression coverage. No paid model call, live ACP task, hosted browser session or live Composio action was run to verify them at the time. A live repeat-run benchmark was produced later that evening; see [End-to-end benchmark](#end-to-end-benchmark-hot-graph-vs-cold-standalone-agent).

| Finding                               | Change                                                                                                                                                                                                                                                                                                                                                        | Regression                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P0 pinned baseline bypasses privacy   | Gateway filters routes by privacy eligibility before any selection, including the pin, and rechecks the selected route against current session state before dispatch. With no eligible pinned-tier route, B1 ends with "Baseline unavailable"; it never falls back to Jev routing. Private harness and model text is withheld from persisted gateway context. | `check:model-gateway`: pinned `private`/`secret`/`local_only` sessions make zero backend calls |
| P1 `--approve` on a first live action | CLI auto-approves only via `canAutoApproveMockBenchmark`: server reports `MOCK_ALL` with every provider mocked, no non-mock egress, and the pending action's own proposed evidence is `mock` with the matching fingerprint.                                                                                                                                   | `check:benchmark` (empty ledger, live evidence, exact mock evidence)                           |
| P1 mock tools in live-only reports    | Samples read trusted `tool.lifecycle` evidence; any `executionMode: mock` marks the sample mocked. Runs without lifecycle history have unknown provenance and are excluded.                                                                                                                                                                                   | `check:benchmark` (live model + mock search)                                                   |
| P1 unequal quality scoring            | Assertions take `scope: outcome \| pipeline`; unscoped ones count as outcomes only on judge/decide/agent_task nodes. Baselines answer under `outcomes`, keyed by assertion id (no last-segment collisions; duplicate ids rejected). Pipeline checks are shown separately and not graded against baselines.                                                    | `check:benchmark`                                                                              |
| P1 uncertain browser targets          | Click/type/submit resolve the target during a side-effect-free review step. Low-confidence or changed targets require approval of that exact snapshot/index/label; an unresolvable target or three stale reviews becomes a manual handoff. Empty and challenge pages become a handoff instead of a verified read.                                             | `check:browser-tools`                                                                          |
| P1/P2 completion overstates success   | The graph still continues past a blocked/unverified verdict. Benchmark success additionally requires a verified `done` on every graph agent node, or on the B1 agent run. A run with no outcome assertions is never a benchmark success.                                                                                                                      | `check:benchmark`                                                                              |
| Pairing / pricing                     | Server-built experiment fingerprint (task, graph, inputs, outcome assertions, non-secret config, tool versions). Pairs need the same pairId **and** fingerprint. Cost savings exclude pairs with unpriced calls. Benchmarks page exports JSON.                                                                                                                | `check:benchmark`                                                                              |
| Smaller items                         | Browserless added to the separate-session browser filters; `smoke:live` establishes the local control cookie; `check:composio-results` added to `check:all`.                                                                                                                                                                                                  | —                                                                                              |

**Behaviour change to confirm:** a low-confidence Jev browser target now waits for human approval before it is clicked. Jev's pick is not replaced or re-asked, but the earlier "follow Jev at any confidence" behaviour executed it immediately.

Still open from this audit: the Graph Editor comparison still hardcodes demo variables; the CLI still defaults to `graph,baseline` (pass `--arms graph,baseline,baseline_agent`); `graph_demo` remains a system demo, not a fair quality fixture (`agentos.benchmark_fixture`, a synthetic public order dataset, is registered for building one); all hosted/live limits in the last two sections are unchanged.

**Addendum, evening of 2026-10-17: see [Live-run findings](#live-run-findings-addendum) and [What can be claimed](#what-can-be-claimed-resume-and-essays).** The setup table below describes the machine the original audit ran on. On the machine used for the addendum the Hermes checkout and `uv` were absent and Hermes ran as mock.

Scope: current source/configuration inspection, passive local-service checks, offline checks and synthetic in-memory reproductions. No paid model completion, live ACP task, hosted browser session or external app action was launched. Credentials were inspected only for presence and non-secret configuration. Runtime code and `.env` were not changed.

## Progress delivered

| Capability          | Current implementation                                                                                                                                                                                   | Verification boundary                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Agent runtime       | Hermes subprocess over ACP, scoped model/MCP gateways, trusted tool registry/broker, per-action authorization, pause/resume/cancel, SSE trace                                                            | Checkout and dependencies present; offline single-run/credential checks pass. A real task was not launched today.                |
| Browser supervision | Environment-selected Browserbase/Browserless/local adapters; agent-created and pooled browser sessions publish to SSE; shared watch/take-control/Done UI; ownership revisions, drain, revoke and cleanup | Offline browser tool/integration/HTTP checks pass. Hosted session/viewer/site compatibility still requires rehearsal.            |
| Tool supervision    | Shared Action workspace, exact payload/account review, approve/revise/reject, transient previews and distinct proposed/provider-reported/readback evidence                                               | Local artifact and mock tool checks pass. Composio API receipts are not a live Office screen or call media stream.               |
| Change verification | Actual versioned local Markdown and JSON cell-grid writes, bounded diffs and independent local readback                                                                                                  | These are local artifacts, not Word/Excel application sessions. Cloud Office readback adapters are absent.                       |
| Benchmarking        | Paired graph/B0/B1 launches, repeat-run CLI, JSON export, outcome assertions, token/cost/active-time rollups, comparison and aggregate pages                                                             | Measurement code runs, but the validity/safety findings below prevent treating all current results as credible live comparisons. |

Current browser-session propagation is in [runtime.ts](../apps/api/src/services/runtime.ts:86); sessions are visible during agent execution in [Workspace.tsx](../apps/web/src/pages/Workspace.tsx:877). A graph browser node is no longer required just to reveal an agent-opened browser.

## Current local setup

Resolved from the current root configuration on October 17; key presence does not prove validity, model availability or quota.

| Setting                                     | Observed state                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `MOCK_ALL`                                  | `false`                                                                                                 |
| Hermes, Jev, Browserbase, Anthropic, Gemini | Configured live; relevant keys/Browserbase project present                                              |
| Preferred browser                           | `browserbase`                                                                                           |
| Composio                                    | Mock, although a project key is present; current OAuth/tool availability was not queried                |
| `web.search`                                | Mock, backend `browser`; explicit `browserbase.search/read` are separate tools                          |
| Browserless                                 | Mock; key absent                                                                                        |
| Local browser / Ollama                      | Mock; no Ollama listener found                                                                          |
| Model/browser credential source             | Both explicitly `operator`; stored user keys are not selected until the corresponding source is changed |
| Persistence                                 | `PERSIST_TO_DISK=true`                                                                                  |
| Pricing overrides                           | `MODEL_PRICES_JSON` absent                                                                              |
| Hermes installation                         | Checkout exists; `hermes-agent 0.21.3`, ACP entrypoint and ACP/MCP modules present; `uv` on PATH        |
| Agent limits                                | Five-minute duration, eight tool calls per gateway turn, two network retries                            |
| Running services                            | No listeners found on API `8787`, web `5173`, or Ollama `11434` during the scan                         |

BYOK is implemented, but this checkout is currently configured to use operator model and browser credentials. Gemini BYOK alone does not cover workflow authoring: `text.model` and the synthesis service are bound to Anthropic. User-funded model inference, cloud browser time, Composio project access and OAuth accounts remain separate resources.

## Fix before sensitive runs or credible live benchmarks

### P0 — pinned baseline bypasses model privacy eligibility

[ModelGatewayService](../apps/api/src/core/modelGateway/service.ts:278) chooses a cloud frontier route for a pinned session before applying `eligibleModelRoutes`, bypassing the ordinary `DecisionService.selectModel` path. There is no independent label check before backend dispatch. [B1 sets this pin](../apps/api/src/core/orchestrator.ts:981).

Six offline cases reproduced the boundary: for each of `private`, `secret` and `local_only`, the normal eligibility function returned zero cloud routes. Unpinned requests made zero backend calls and stopped. Pinned requests made one call to an injected cloud backend, which received the synthetic sensitive marker. No real network egress occurred.

Required change: apply hard privacy/credential/tool eligibility before every route selection, including pins, and recheck before dispatch. A missing eligible frontier route should make B1 unavailable, not silently switch to ordinary Jev routing. B0's deliberately unredacted direct cloud path also needs a clear public-only boundary before sensitive comparisons.

### P1 — benchmark auto-approval can approve a first live action

[The repeat-run CLI](../apps/api/scripts/benchmark.ts:109) treats zero historical live egress rows as proof that a run is mocked. Before the first provider execution, a real pending write can satisfy that condition. This does not prove the proposed action is simulated.

Do not use `--approve` for live rehearsals. Required change: bind automation of approvals to trusted explicit mock execution provenance for the pending action/run, or remove this shortcut. Absence of past traffic is not authorization.

### P1 — mixed real-model/mock-tool runs can enter live-only reports

[Mock search](../apps/api/src/core/tools/search.ts:172) returns simulated evidence without writing a mock egress row. [Benchmark classification](../packages/shared/src/benchmark.ts:132) checks only egress to decide whether a sample is mocked.

An in-memory reproduction used the actual mock search executor: `executionMode=mock`, `simulated=true`, zero search egress rows, `sample.mocked=false`; the default live-only report retained the sample. Some agent toolsets remove mock twins when live equivalents exist, but explicit graph calls and other mixed configurations remain reachable.

Required change: propagate trusted tool/model execution provenance into run/benchmark classification and exclude any simulated dependency from live results. A live model does not make its mock search evidence real.

### P1 — default quality scoring is not equivalent across arms

[The demo graph](../apps/api/src/core/graph/demo.graph.ts:208) asserts its internal redaction-span count. Baseline task construction omits pipeline-only fields from requested answers, but [baseline scoring](../packages/shared/src/benchmark.ts:55) still evaluates all graph assertions. Baselines can therefore fail by construction. Assertion paths are also flattened to their final field, allowing collisions between different nodes.

Required change: distinguish outcome assertions from pipeline assertions, score identical task outcomes across arms and preserve unique answer identities. Use a public, read-only fixture with a known answer; `graph_demo` is currently a system demonstration, not a fair default quality benchmark.

### P1 — uncertain browser targets still execute

[The browser executor](../apps/api/src/core/tools/browser.ts:338) explicitly follows Jev's target selection at any confidence. Earlier broker authorization cannot escalate an uncertain target chosen afterward. This conflicts with the repository's low-confidence escalation requirement.

Required change: ambiguous targets should stop/escalate to human selection or handoff instead of clicking or typing speculatively. Separately, [direct browser research](../apps/api/src/core/tools/browser.ts:435) accepts empty/challenge text as successful extraction and marks execution verified; it lacks `web.search`'s challenge detection. Add blocked-page detection and task-level evidence verification.

### P1/P2 — completion semantics can overstate task success

[The current controller](../apps/api/src/core/orchestrator.ts:1347) records Jev's completion verdict but continues the graph even when that verdict is blocked/unverified. This is intentional in the current single-run checks and differs from the design document's verified-done/continue/blocked lifecycle. With no assertions, benchmark success falls back to the run's `succeeded` status.

Decide and enforce one completion contract: a returned harness result must not imply that the requested outcome was achieved. Preserve partial results, but surface blocked/unverified completion and prevent it from counting as benchmark success without equivalent outcome verification.

## Other measurement gaps

- [Pairing](../packages/shared/src/benchmark.ts:245) uses graph ID plus pair ID/time without enforcing the same graph version, task, inputs, model/tool configuration or assertions. Freeze these values and record an experiment fingerprint.
- Baseline prompts reconstruct original conversation/description/inline sources, not every manually edited node instruction. Keep a canonical task statement shared by all arms.
- The Graph Editor's comparison launch hardcodes demo variables; custom inputs are available in the CLI. [GraphEditor.tsx](../apps/web/src/pages/GraphEditor.tsx:179).
- The CLI defaults to graph versus B0, which has no tools. Include `baseline_agent` explicitly for the real agent-versus-agent comparison.
- [Paired savings](../packages/shared/src/benchmark.ts:284) includes samples with unpriced model calls. Fully price both arms or withhold exact savings percentages. Gemini/Jev costs may be incomplete without provider-reported cost or configured rates. Browser/Composio service fees are not comprehensive billing totals.
- Arms launch concurrently and share rate/session limits and target resources. Prefer read-only tasks; mutation experiments need equivalent isolated fixture copies.
- JSON export is in CLI `--out`; no UI export control was found. Compare links to each run for live viewing/approvals rather than embedding the control panel itself.

## Remaining live-view and operational limits

- Browserbase's saved HTTP 402/quota failure is from **October 5**; it was not re-tested today. Live health checks configuration and cannot establish successful browser creation or current site access.
- Browserless has no configured key and no hosted rehearsal. Its configured default two-minute session timeout is shorter than a default ten-minute handoff. Align provider/account limits, viewer expiry and measured task duration before switching.
- Lost Browserless automation transport does not restore the same live page. Dashboard viewer refresh while the transport remains open is a different capability.
- The live browser fallback inside `web.search` opens/closes a disposable session without browser-session announcements. It produces an activity/result card, not a retained watchable browser. Explicit browser opens and pooled `browserbase.search/read` are the watchable path.
- Graph handoff blocks its branch/browser resource; independent graph branches may continue. User-requested Take control pauses the broader run. Document that distinction or add an explicit broader handoff pause contract.
- `url_matches` is checked when the user clicks Done; there is no automatic URL-triggered continuation watcher.
- Browserless is missing from the gateway/MCP separate-session filtering helpers, although final broker resource binding still blocks incompatible calls. This can produce avoidable failed tool selections.
- Normal private app-read-to-summary workflows require an eligible local model because current cloud routes are public-only. Ollama is not running/configured live. The pinned-baseline exception above must be fixed first; it is not an acceptable workaround.
- [The legacy live smoke script](../scripts/live-check.mjs:33) does not establish/send the local control cookie, so its run-creation POST conflicts with the authenticated API. Update the harness before using `pnpm smoke:live` as proof.
- Composio shows exact proposals/account identity and provider receipts. Independent cloud Office readback, rendered Office screens and call audio/video are not implemented. Native local document/grid artifacts do have verified local readback.

## Checks performed today

All of these passed offline:

- `pnpm typecheck`.
- `pnpm check:agent-single-run`, `pnpm check:credentials`.
- `pnpm check:authoring-mock` — three authored workflows and a separately reviewed local draft.
- `pnpm check:action-workspace`.
- Browser tool, integration and HTTP checks; no hosted browser call or new local Chrome rehearsal.
- `pnpm --filter @htn/api check:benchmark` — 24 checks.
- `pnpm --filter @htn/web test` — 44 tests.

The privacy and mock-provenance reproductions above are additional audit observations, not claims that the existing test suite catches those failures. A full paid live run, hosted viewer/target-site rehearsal and current aggregate benchmark results were not verified. The previous seven-scenario UI/hosted-limit report remains dated October 5.

## Path to a trustworthy demonstration

1. Fix pinned-route privacy, approval automation, mock provenance, equivalent outcome scoring and blocked/uncertain completion behavior. Add regression coverage for the reproduced cases.
2. Choose a public read-only task with a known answer. Freeze task, variables, graph/config versions and shared outcome assertions. Configure the intended real browser/search/tool modes; require real local inference for private workflows.
3. Start `pnpm dev`, check Connections for effective modes/health, then submit through **Run as agent task**. Open the run's browser card to watch/control it; use the action cards for tool payloads and approvals. Verify one complete harmless real run before measuring repetitions.
4. Confirm live model IDs, keys, browser quota, source-page access and actual tool connection. Validate watch, takeover, manual input, Done and same-session continuation against the provider being demonstrated.
5. After the fixes, run graph/B0/B1 repeatedly on equivalent inputs, approve live actions manually, inspect actual selected models/provenance, and export samples plus report. Do not report savings until both arms pass the same outcome check and the relevant costs are known.

Example after the preceding fixes and fixture preparation; replace `YOUR_READ_ONLY_GRAPH_ID` with the saved graph ID:

```powershell
pnpm --filter @htn/api benchmark -- --graph YOUR_READ_ONLY_GRAPH_ID --arms graph,baseline,baseline_agent --repeats 5 --out benchmark-results.json
```

Use the graph comparison controls for a single paired run, the run links for live intervention, and `/benchmarks` for aggregate measurements. Keep mock rehearsal results separate from live benchmark evidence.

## Live-run findings (addendum)

Observed while running the workflow builder and graph runner by hand against live Jev, Anthropic,
Gemini and Composio, with the local browser. Hermes and Browserbase were not usable (below). These
are single manual runs, not benchmarks.

### Fixed

| Finding | Evidence | Change |
| --- | --- | --- |
| Graph synthesis failed on truncated JSON | Both attempts reported `3072 out`, exactly the `direct` cap, with 1.4k and 2.9k chars of output, and parse errors at the last characters (position 1418 of 1460, 2923 of 2946). Reasoning tokens consumed the budget. | [synthesizer.ts](../apps/api/src/core/graph/synthesizer.ts): caps raised to 8192 (`direct`) and 12288 (adaptive); a truncated reply now gets a "cut off, return a shorter document" repair hint instead of "not valid JSON". Afterwards synthesis was accepted at 3613 and 5105 output tokens. Not re-run enough times to give a success rate. |
| Browser tool nodes used the wrong argument names | `localbrowser.type` failed validation: missing `text`, unexpected `value`. The synthesizer sees only a tool's name and description, and the browser descriptions did not list their args. | [browserDescriptors.ts](../apps/api/src/core/tools/browserDescriptors.ts): each description now ends with `Args: name*, ...` derived from the tool's own input schema. A later run executed the type step. `tsc` clean; no new automated test covers either change. |

### Open

- **A mock agent result counts as a success.** With Hermes in mock, an `agent_task` returns a placeholder note, the step is marked `succeeded` ([orchestrator.ts:1469](../apps/api/src/core/orchestrator.ts#L1469)), and the next node consumes it. The downstream report correctly said "no usable data", but the run itself still showed success.
- **Blocked completion is invisible at run level.** Jev judged the agent task `blocked` (confidence 0.54, below the 0.70 floor) and the graph continued by design. The card shows it; the run status does not.
- **A bad `HERMES_CWD` downgrades to mock with one boot line.** `HERMES_MODE=live` plus a missing path, or a missing `uv`, silently runs mock. On this machine `HERMES_CWD` pointed at `Local_Dev\HTN-2026\hermes-agent`, which does not exist; no checkout exists on this machine.
- **The synthesizer ignored an explicit "no agent" instruction twice** and kept an `agent_task`. Its prompt also steers toward `browserbase.*` regardless of which providers are live.
- **`SynthesisError` returns an unhandled 500** ([conversations.routes.ts:88](../apps/api/src/api/conversations.routes.ts#L88)).
- **Report nodes can overstate.** A report listed a form as filled from a single `TYPE_TEXT` action (Jev p=0.56 on one field); another report was cut mid-sentence by a low `maxTokens`. Neither is checked against outcome assertions.
- **Composio registered only `mail.send`** on this setup. `sheets.append` and `calendar.create` need their toolkits connected.
- **Browser sessions can leak.** The default cap is two; a graph that opens a session and never closes it can starve a parallel branch.
- **Browserbase quota is exhausted**; the local browser is the working live backend on this machine.

## End-to-end benchmark: hot graph vs cold standalone agent

Run on the evening of 2026-10-17: 75 measured runs (5 tasks × 3 arms × 5 rounds) plus 5 uncounted
warm-up graph runs. Every run was live: no mocked provider, no unpriced model call. Raw samples and
the generated report are in [agent-benchmark-2026-10-17.json](metrics/agent-benchmark-2026-10-17.json)
and [agent-benchmark-2026-10-17.md](metrics/agent-benchmark-2026-10-17.md).

### Setup

- **Arms.** Graph: the orchestrated workflow, deterministic tool nodes plus Jev for choices.
  **B1, the standalone agent:** one Hermes agent on Claude Opus 5 with every eligible tool and no
  Jev routing. This is the headline comparison. B0: one Claude Opus 5 call with no tools.
- **Hot vs cold.** Each graph ran once before measuring (not counted), so measured graph runs reuse
  what earlier runs froze or remembered: dispatch choices and browser targets. Baselines have no
  graph to reuse. This is deliberate, because a graph is meant to make repeat runs cheap. One
  caveat makes the comparison more favourable to B1, not less: ad-hoc runs share one target-memory
  scope per run kind, so B1 also reused browser targets remembered by earlier B1 runs (6 of 25 B1
  runs were warm).
- **Tasks.** [benchmarkSuite.ts](../apps/api/scripts/benchmarkSuite.ts): five tasks with
  ground-truth answers read off the live pages on 2026-10-17, and no step that needs approval.
  - Bookstore: four pages, three questions.
  - Quotes pagination: a Jev-picked click.
  - A pizza form, typed but not submitted.
  - An order dataset read through a dispatch node.
  - A case note redacted before Jev sees it.

  Sites are scraping sandboxes (books/quotes.toscrape.com, httpbin.org).
- **Grading.** A run succeeds only if every outcome assertion passes and, for B1, Jev verified the
  agent's completion. Savings are medians of per-pair `1 - graph / baseline` over pairs where both
  runs succeeded, with 95% bootstrap intervals.
- **Running.** An isolated API on port 8911 with its own SQLite file; live Jev, Anthropic and
  Hermes; headless local Chrome. Each round ran the three arms one at a time in shuffled order. A
  run that asked for approval was cancelled and counted as a failure (`--on-approval cancel`).

```powershell
pnpm --filter @htn/api benchmark -- --suite --arms graph,baseline,baseline_agent --repeats 5 --warmup 1 --sequential --on-approval cancel --report bench.md --out bench.json
# rebuild the report from stored rounds at any point:
pnpm --filter @htn/api benchmark -- --suite --report-only --arms graph,baseline,baseline_agent --report bench.md
```

### Results, all tasks pooled

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (hot) | 25 | **100%** | 1,458 | 1,331 / 109 | 2 | 2 | 1.2 s | 9.4 s | 0.0074¢ |
| B1 · one agent, all tools | 25 | 40% | 92,405 | 92,017 / 435 | 5 | 1 | 22.6 s | 40.8 s | 53.5¢ |
| B0 · one call, no tools | 25 | 64% | 1,279 | 336 / 986 | 1 | 0 | 14.0 s | 18.3 s | 3.8¢ |

Paired savings, counted only where both runs succeeded:

| Versus | Pairs both passed | Token saving | Active-time saving | Cost saving | Graph-only wins | Baseline-only wins |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **B1 (standalone agent)** | 10 / 25 | **98%** (CI 97–99%) | **88%** (CI 76–98%) | ~100% (CI 100–100%) | 15 | 0 |
| B0 (one call, no tools) | 16 / 25 | −33% (CI −132 to −20%) | 67% (CI 49–95%) | ~100% (CI 100–100%) | 9 | 0 |

Total spend across the 25 runs per arm: graph $0.0019 (47K tokens, 84 s active), B1 $5.35
(2.34M tokens, 616 s), B0 $0.62 (31K tokens, 325 s). "~100%" cost saving means the graph's cost
rounds to zero next to the baseline's: its only model is Jev, at well under 0.01¢ per call.

### Results per task

| Task | Graph | B1 | B0 | Graph vs B1, where both passed |
| --- | --- | --- | --- | --- |
| Bookstore | 5/5 · 4,224 tok · 9.4 s | 5/5 · 159,350 tok · 38.8 s · 29.9¢ | 5/5 · 1,542 tok · 14.8 s | 5 pairs: tokens −97%, time −76% |
| Quotes pagination | 5/5 · 1,731 tok · 5.0 s | 0/5 (approval gate) | 5/5 · 1,447 tok · 14.6 s | no pair |
| Pizza form | 5/5 · 1,458 tok · 1.2 s | 0/5 (approval gate) | 0/5 | no pair |
| Order dataset | 5/5 · 1,098 tok · 0.3 s | 5/5 · 73,201 tok · 20.9 s · 25.3¢ | 1/5 | 5 pairs: tokens −99%, time −98% |
| Case note | 5/5 · 909 tok · 0.2 s | 0/5 (privacy stop) | 5/5 · 733 tok · 5.8 s | no pair |

All figures are medians over five runs.

**Hot vs cold graph runs** (the warm-up run is the cold one):

| Task | Cold run | Hot runs |
| --- | --- | --- |
| Quotes | 4,060 tokens, 3 Jev calls | 1,731 tokens, 2 Jev calls (−57%) |
| Pizza form | 2,775 tokens, 4 Jev calls, 1.7 s | 1,458 tokens, 2 Jev calls, 1.2 s (−47%) |

The browser target picks were replayed from memory. The order dataset's dispatch choice was
already frozen when the graph was saved, so even its first run was warm. The bookstore and the
case note have nothing to reuse.

### Why the baselines failed

- **B1, quotes and form (10 runs): stopped by AgentOS's own approval gate.** An agent's tool call
  also goes through Jev's semantic action policy
  ([decisions/service.ts](../apps/api/src/core/decisions/service.ts)). For B1's `Next →` click and
  its first `type`, Jev recommended `auto` at 0.65 confidence, and the low-confidence escalation
  turned that into `ask_user`. The graph's identical steps are fixed tool nodes, which are
  authorized by the deterministic local policy (`verify`, allowed). An `agent_task` node inside a
  graph would hit the same gate as B1.
- **B1, case note (5 runs): stopped by the privacy fix (P0 above).** The note carries a SIN, a phone
  number and an email, so the session was labelled private and no cloud model may see it: "Only a
  local model may continue a task like this." The graph succeeds because the redact node pins the
  PII locally and Jev only sees placeholders.
- **B0, form and dataset:** it cannot fill a form or read a dataset it was never given. It got
  one of the two dataset answers right in four runs, and both in one.
- **B0 passing the bookstore and quotes tasks is real, not a harness error.** Both sites are
  well-known scraping sandboxes, so Opus answered from training data without opening a page.

### What these numbers do and do not show

- They show that, on these five tasks, a hot graph completed every run while the standalone agent
  completed 40%. Where both succeeded, the graph used 98% fewer tokens and 88% less active time,
  at a cost that rounds to zero.
- They do not show savings on arbitrary tasks, on synthesised graphs or on a graph's first run.
  The graphs were hand-written for this suite in the product's intended style: fixed tool nodes
  for fetching and Jev only for choices. Authoring time is not measured.
- Token counts compare different models with different tokenizers (Jev vs Claude). Cost is the
  comparable figure across models.
- B1 lost 10 runs to an approval policy that the graph's tool nodes do not go through. That is how
  the platform behaves today, not a property of agents in general. A B1 with that gate relaxed
  would likely pass more often and would still spend about 92–160K tokens per run.
- Five rounds per task is small. The intervals are bootstrap intervals over the paired runs, and
  only bookstore and the order dataset contribute B1 pairs.

### Issues found by the benchmark (open)

- **A stopped agent run was judged "done, verified".** All five privacy-stopped B1 case-note runs
  recorded `completion: {status: "done", verified: true}` with the stop message as the answer. The
  benchmark still failed them on outcome assertions, but completion verification should not pass
  a run that AgentOS itself stopped.
- **Agent tool calls and graph tool nodes are gated differently.** The same click on a public page
  needs approval when an agent proposes it at Jev confidence 0.65, and none as a graph tool node.
  Decide whether that asymmetry is intended.
- **Ad-hoc runs share browser target memory across runs** (one scope per run kind). That is useful,
  but it means "cold" baselines are not fully cold.

### Measurement fixes made to produce these numbers

All are in commit `288b41a`, each with a regression check where one was practical.

| Problem | Effect on results | Fix |
| --- | --- | --- |
| The experiment fingerprint hashed the server-owned `compiled` cache and timestamps | A warm graph run became a new experiment and could never pair with its baselines | Hash only the authored graph ([baselineTask.ts](../apps/api/src/core/playbooks/baselineTask.ts)) |
| Baselines invented a `target` variable when a graph had none | Inputs hash differed, so no pairs | Use the graph run's variables exactly ([runs.service.ts](../apps/api/src/services/runs.service.ts)) |
| In-process calls on live adapters (`releaseRun`, `setOwnership`, `cancelTask`) were logged as `mock://` | Every live run was flagged mocked and dropped from live reports | Logged as `local://` on live adapters; releasing an unused mock backend no longer flags a run ([withEgress.ts](../apps/api/src/providers/withEgress.ts), [benchmark.ts](../packages/shared/src/benchmark.ts)) |
| Jev browser target picks were missing from the ledger | Graph tokens and cost undercounted, in the graph's favour | The decider returns usage and the browser executor records it, without double-counting Jev calls ([browser.ts](../apps/api/src/core/tools/browser.ts)) |
| The pre-action check called `elementFromPoint` on off-screen controls | Any click below the fold read as occluded and fell back to a human handoff | Scroll the target into view first ([browserPage.ts](../apps/api/src/providers/browserPage.ts)) |

## What can be claimed (resume and essays)

Rule used here: a claim is listed as safe only if a number or behaviour was reproduced from a file in
this repo or observed in a log. Items that exist only as design intent are listed separately. Fill in
your own role and share of the work; this file does not know who built what.

### Safe to state, with the number

| Claim | Source | Wording that stays accurate |
| --- | --- | --- |
| The browser request Jev receives stays about 1.5K tokens regardless of page size | [browser-benchmark-2026-10-09.json](metrics/browser-benchmark-2026-10-09.json), recomputed: median 1,517, range 1,234 to 2,045 tokens across 13 live sites | "per browser step, measured on 13 live sites" |
| That is 81.7% fewer tokens than a full accessibility-tree snapshot (median; 60.9% to 98.1%) | same file, recomputed | Use this as the headline. It is the fair comparison. |
| Page snapshotting about 191x faster (median; lowest 92x); pre-action target check about 15x | same file, recomputed | "local Chrome, snapshot step only; the 'before' is a re-implementation of the earlier per-element approach" |
| Diagnosed and fixed a token-budget truncation in the workflow synthesizer from the token logs | Logs in the addendum above | "found that reasoning tokens exhausted the output cap; raised the budget and gave the retry a specific repair hint" |
| Found and closed a model-privacy bypass: a pinned model route skipped the data-label eligibility check | Audit P0, with a six-case offline reproduction and `check:model-gateway` regression | Say it was found by audit and closed with offline tests. No live egress occurred. |
| Exact-action approval on irreversible tools (for example `GMAIL_SEND_EMAIL`), failing closed on 14 broker error codes | [metrics.md](metrics.md) "Read from the code" table | A design property read from code, not a measured outcome |
| On five sandbox tasks, a hot graph completed 25 of 25 runs; a standalone Opus 5 agent with every tool completed 10 of 25 | [End-to-end benchmark](#end-to-end-benchmark-hot-graph-vs-cold-standalone-agent), [raw samples](metrics/agent-benchmark-2026-10-17.json) | "on five hand-written sandbox tasks, 5 runs each; the agent's failures were the platform's approval and privacy gates" |
| Where both succeeded, the hot graph used 98% fewer tokens (CI 97–99%) and 88% less active time (CI 76–98%) than the standalone agent | same, 10 paired runs | Always with "hot graph runs, hand-written graphs, 10 pairs on two tasks". Cost: $0.0019 for all 25 graph runs vs $5.35 for the agent's 25. |
| Repeat runs of the same graph got cheaper: 57% fewer tokens on pagination, 47% on a form, from remembered browser targets | warm-up vs measured runs, same section | "measured on two tasks; tasks with nothing to reuse do not change" |
| 942 test assertions across 29 files | [metrics.md](metrics.md) with the `grep` command given there | Re-run the command before quoting the number. It was not re-run for this audit. |

### Do not claim

- **An end-to-end saving without its conditions.** The [benchmark above](#end-to-end-benchmark-hot-graph-vs-cold-standalone-agent) measures hot graph runs against a cold standalone agent on five hand-written sandbox tasks. Quote it with those conditions, and only for pairs where both arms succeeded. It does not show savings on arbitrary tasks, on synthesised graphs, or on a graph's first run.
- **"98.5% fewer tokens" as a headline.** It is against raw DOM, which no real browser agent sends to a model. It is accurate but easy to read as a strawman.
- **Accuracy.** Jev sees at most 60 elements per page; on Wikipedia that is 60 of 2,235. The benchmark measures prompt size and does not report how often the right target is in the table.
- **"Agents that get cheaper" in general** ([DEVPOST.md](DEVPOST.md)). Only two tasks had anything to reuse (−57% and −47% tokens from the first run to later runs). Say "repeat runs of a graph", with those numbers.
- **A reliable Hermes agent.** Hermes ran live as the B1 baseline and completed 10 of 25 runs with verified answers. The other 15 stopped at AgentOS's approval and privacy gates, so the evidence is "it works end to end when nothing needs a person", not "it is reliable".
- **Tool narrowing as a token saving** ("at most 8 of 1,000+ tools"). It is a code constant, not a measurement.
- **Live Composio or hosted-browser reliability.** Not rehearsed; Browserbase quota is exhausted.

### Essay angles that hold up

1. **"Make the decision model small, not the context large."** Jev cannot generate text; it picks an index from a table the system builds. The measured consequence is a roughly constant 1.5K-token request instead of a page-sized one. This is the strongest technical story and it is backed by data.
2. **Why a fast model still needs a gate.** The privacy bypass came from a pin that skipped eligibility. "A tool that cannot generate an action still cannot be trusted to have chosen an authorized one" is supported by the audit reproduction.
3. **Honest measurement.** The audit found its own benchmark could overstate savings (mock tools counted as live, baselines failing by construction, unpriced calls in savings) and recorded the fixes. A candid account of that is more credible than a headline number.
4. **Debugging with token logs.** The truncation bug looked like a malformed-JSON bug; `tokensOut` equal to the cap showed it was not. Short, concrete and true.
5. **Failure that looks like success.** A mock agent returned a placeholder, the run went green, and only the report model's wording revealed it. It motivates the open items above.

### Resume bullets (templates; adjust the verbs to what you actually did)

- Reduced the per-step browser-agent decision input to about 1.5K tokens (median), 82% below a full accessibility-tree snapshot across 13 live sites, by giving a classifier model an indexed element table instead of the page.
- Diagnosed workflow-generation failures from token logs (output pinned at the 3,072-token cap), fixed the budget and retry hint, and derived tool-argument docs from the schema so generated graphs pass validation.
- Audited an agent platform's benchmarking and privacy controls; reproduced and closed a model-routing privacy bypass and measurement-validity gaps with offline regression checks.
- Built a paired, assertion-graded benchmark (75 live runs) in which reusable agent workflows used 98% fewer tokens and 88% less time than a frontier-model agent with every tool, where both succeeded, and completed 25/25 runs to the agent's 10/25.

Quote the end-to-end percentages only with their conditions: hot graph runs, five hand-written sandbox tasks, savings over the 10 pairs where both arms succeeded.
