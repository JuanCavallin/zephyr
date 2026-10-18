# Agent, benchmark and live supervision readiness — 2026-10-17

The implementation foundation exists, but a passing mock demo is not sufficient evidence for a safe, accurate live benchmark. This audit found concrete runtime and measurement gaps. Fix the baseline privacy bypass before sensitive runs, and fix provenance/quality scoring before relying on benchmark savings.

## Resolution status (later on 2026-10-17)

The P0/P1 findings below are fixed in code with offline regression coverage. No paid model call, live ACP task, hosted browser session or live Composio action was run to verify them, and no benchmark result has been produced since.

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
| 942 test assertions across 29 files | [metrics.md](metrics.md) with the `grep` command given there | Re-run the command before quoting the number. It was not re-run for this audit. |

### Do not claim

- **Any end-to-end token, cost or latency saving.** The audit states no benchmark result has been produced since the fixes, and `graph_demo` is not a fair quality fixture. Only per-step input size is measured.
- **"98.5% fewer tokens" as a headline.** It is against raw DOM, which no real browser agent sends to a model. It is accurate but easy to read as a strawman.
- **Accuracy.** Jev sees at most 60 elements per page; on Wikipedia that is 60 of 2,235. The benchmark measures prompt size and does not report how often the right target is in the table.
- **"Agents that get cheaper"** ([DEVPOST.md](DEVPOST.md)). No number backs it.
- **A working Hermes agent end to end.** Hermes ran as mock on the machine used here, so no agent result from it has been observed. The adapter code is complete and was verified against a real install by its author, per its header, but that was not reproduced here.
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

Do not put a cost-saving percentage on a resume until the repeat-run benchmark in the previous section has produced one.
