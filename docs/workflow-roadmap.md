# Workflow execution and supervision roadmap

Updated: 2026-09-23. Active follow-up to the archived graph workflow plan.
The [design specification](agentos-design.md) remains authoritative for privacy,
permissions, exact-action approval, and the harness-agnostic architecture.

## Agreed execution rules

1. **Known recipe:** use direct `tool` nodes. Arguments can be literal values or
   references to upstream results; runtime data does not require runtime tool choice.
2. **One bounded tool choice:** use `dispatch`. Jev chooses among real candidates;
   an optional generative call supplies arguments. No agent loop.
3. **One generative transformation:** use `decide` (the existing name for a
   `text.model` call), not a Hermes task.
4. **Adaptive observe/reason/act loop:** use a bounded `agent_task`, even when all
   tools are known or only one tool is repeatedly needed. Specify the objective,
   completion criteria, relevant candidates, duration, and failed-call budget.
5. **No real runtime uncertainty:** accept a graph without `dispatch` or
   `agent_task`. Delegation counts are descriptive, not a validity or quality score.

Keep fixed steps around adaptive subtasks. A failed direct call does not implicitly
escalate to Hermes. Any fallback must be represented explicitly and reauthorized.
Tool eligibility/selection is not permission: every exact action still passes the
AgentOS gate. Native Hermes tools must not bypass the model/MCP gateway and broker.

## First batch: planning and admission (P0)

Status: implemented; automated verification passed below. Live-provider/UI acceptance
remains a manual check, not a claimed result of the offline tests.

Scope: graph synthesis and its tests. No execution, permission, browser, or UI
redesign in this batch. The existing node schema and service API remain compatible.

- Replace the forced-delegation prompt with the five rules above.
- Allow known-tool adaptive research through registered, brokered tools; distinguish
  it from a fixed lookup and from interactive browser state.
- Preserve browser session-reference guidance and irreversible-action boundaries.
- Stop rejecting a valid graph solely because it has no runtime delegation.
  Continue rejecting malformed graphs and empty synthesized workflows.
- Keep delegation field names for existing clients, but document their descriptive
  meaning and avoid calling direct execution zero-cost or model-free.
- Isolate the synthesis engine from production wiring so deterministic test doubles
  exercise the actual validation/repair loop without network or database access.
- Include regression tests in `pnpm check:graph`, which already runs in CI.

Acceptance checks (tick only after the commands pass):

- [x] `pnpm --filter @htn/api check:graph-synthesis` (16 checks): direct-only and upstream-ref
      graphs accepted on attempt one; one-shot model, dispatch, and known-tool agent
      shapes remain accepted; chat can remove the last agent task; invalid structures
      and empty plans still repair or fail; prompt safety/session guidance retained.
- [x] `pnpm typecheck`.
- [x] `pnpm test` (includes model gateway, MCP gateway, broker and browser checks;
      all 32 web tests passed).
- [x] `pnpm build` (successful; bundle-size warning remains).
- [x] Isolated mock HTTP check (in-memory store, ephemeral localhost server):
      create a direct-only graph, seed a conversation, use the deterministic mock
      `OPTIMIZE:` edit, and verify HTTP 200, unchanged graph identity/positions,
      no inserted dispatch/agent task, and no launched runs. No live provider called.

These tests establish deterministic admission behavior and prompt content. They do
not prove that a live model chooses the intended node type for every natural-language
request, or that a live Hermes/browser integration completes successfully.

## Second batch: bounded node inputs and session references (P0)

Status: implemented. This is the graph-runtime foundation, not shared Hermes memory
or a complete fix for Browserbase page continuity. Scope: Person 1's graph execution
and additive shared graph contracts. Policy, gateway, provider, and UI code stay unchanged.

- Resolve node references only against completed ancestors connected by edges.
  Completion timing no longer exposes an unrelated parallel branch's output.
- Add optional `agent_task.config.contextInputs`: named, whole references to selected
  ancestor fields or run inputs. Values retain their JSON types. An explicit `{}`
  supplies no implicit context; omission supplies only direct predecessor outputs.
- Reject self/unknown/unconnected context bindings when saving the graph. Fail before
  invoking Hermes if a required selected field is absent or its branch was skipped.
- Reject a supplied `sessionId` that resolves to missing, null, blank, or a non-string
  before tool execution. A handoff with neither an inherited ID nor a usable URL fails
  instead of opening a blank page. Model-inferred dispatch arguments cannot repair a
  missing session binding or overwrite a valid graph-bound session.
- Preserve existing graph-owned session cleanup on completion and failure. Harden
  reference resolution against inherited prototype properties.
- Teach synthesis these rules and give the demo agent explicit summary input.

Example (inside an agent task's config; `summary` must be an ancestor):

```json
{
  "goal": "Check the supplied evidence and report uncertainty.",
  "contextInputs": {
    "evidence": "{{summary.text}}",
    "question": "{{input.question}}"
  }
}
```

This controls the implicit context payload, not the task's goal or other explicitly
referenced config fields. It is **not** a tool capability ceiling, a privacy-label
override, a shared transcript, or authorization to reuse a browser. Select sanitized
artifacts; existing privacy and exact-action gates still apply.

Compatibility: no database migration or required new field. Existing graphs still
parse, but agents that relied on ambient grandparent results need explicit bindings.
References to unrelated nodes need real dependency edges. A required binding from a
conditional branch must be moved onto that branch or bound to an always-produced
artifact; it no longer quietly becomes empty context. Saved demo graphs are not
overwritten by seeding, so only a fresh demo receives the example binding automatically.
There is no dedicated context-input inspector control yet; use graph JSON/API or chat.

Acceptance checks (tick only after the commands pass):

- [x] `pnpm --filter @htn/api check:graph` (schema, 16 synthesis checks, and 19 new
      context/reference checks): unrelated/raw ancestor exclusion; explicit/empty/
      transitive/required context; skipped branches; missing session guards; dispatch
      inference pinning; successful session reuse and failure cleanup; prototype safety.
- [x] `pnpm typecheck`.
- [x] `pnpm test` (all invariant suites and 32 web tests passed).
- [x] `pnpm build` (successful; existing bundle-size warning remains).
- [x] `scripts/smoke.mjs` against an isolated ephemeral localhost API with all providers
      mocked and an in-memory store: demo and graph execution, approvals, rejection,
      CRUD validation, node attribution, and analytics all passed. No live provider or
      existing database used.

Still pending: trusted gateway session binding, capability ceilings, privacy-label
lineage, transcript continuation, run-owned resources across Hermes tasks, page
reattachment, resource locks, and live supervision. The tests above prove interpreter
behavior with doubles/mock providers, not live browser continuity.

## Next: scoped gateways, shared context, and resource ownership (P0)

Implementation steps (each verified step is committed separately):

- [x] Scoped gateway transport: per-context, audience-specific process-local credentials;
      model/MCP requests resolve the authenticated session and capture its turn, with
      stale/terminal bindings rejected. Global keys and loopback placeholders cannot
      select execution context. Live Hermes uses an isolated subprocess/profile per
      context and a named custom provider honoring its scoped key environment.
      Typecheck and model-gateway, MCP-gateway, and broker checks passed. Real ACP
      compatibility remains an integration check, not a claim of these offline tests.
- [x] Enforced capability ceilings and fresh/continue scopes with labeled inputs.
      `toolCeiling` is optional; `[]` prohibits tools and a continuation cannot widen
      its existing ceiling. `contextScope: {id, mode: "fresh" | "continue"}` names a
      run-local transcript. The schema requires one fresh owner and an ordered chain;
      omitted scopes are independent. Labels merge monotonically; context entries
      retain input provenance/version without persisting raw input values. Run/node
      labels also propagate through derived graph outputs. Typecheck, graph checks
      (including the new scope suite), and gateway/broker checks verify these contracts.
- [x] Run-owned resources, serialized writers, and bounded sanitized MCP results.
      Browser sessions are run-owned at the provider boundary, browser calls serialize
      per session, and human handoff blocks agent I/O until resume. Teardown releases
      leftovers; only explicitly prepared, bounded public model output crosses MCP.
      Typecheck passed. Provider-live handoff and UI embedding remain manual/P1 checks.

Owners: Person 1 (runtime/session lifecycle), Person 2 (context/privacy/policy),
3A (tool gateway), 3B (browser). Agree additive contracts before changing these tracks.

1. **Separate three identities:** workflow run, agent context scope, and resource
   reference. Keep node type as the single source of execution strategy; do not add
   a conflicting second execution-mode field. Define explicit artifact inputs and
   outputs instead of handing each agent every completed node's context. The second
   batch implements selected data inputs; scope/resource identities and labeled artifact
   contracts still remain. Implement trusted gateway binding next, before session reuse.
2. **Bind gateway requests to the actual session/turn.** Replace the global
   single-active-Hermes lookup with trusted scoped routing for both model and MCP
   requests. A model-supplied scope ID must not authorize another session's tools.
   Continue failing closed on missing, stale, or ambiguous bindings.
3. **Make graph capabilities an enforced boundary.** Current `availableTools` is a
   candidate list, not a hard cap: discovery adds candidates. Define an optional
   explicit capability ceiling, distinguish omitted from empty, intersect discovery
   and Jev selection with it, and recheck it at execution. Retain exact-action checks.
4. **Add explicit fresh/continue agent context semantics.** Reuse a harness session
   across sequential nodes only when they name the same approved scope. Track scope
   version, provenance and labels; publish explicit context/artifact updates from
   intervening direct calls. Do not equate reusing a browser with reusing a transcript.
5. **Move shared resource lifetime to the run/scope owner.** Do not close a browser
   after an individual agent node if a later graph step still needs it. Release on
   terminal run/cancellation, with explicit expiration/recovery behavior.
6. **Enforce one writer per mutable resource/context.** Serialize actions sharing a
   browser page or mutable transcript, including human takeover. Independent agents
   get fresh scopes and resources; merge their labeled artifacts at a join. Only
   enable parallel Hermes tasks after trusted scoped routing is tested.
7. **Return useful, privacy-safe tool results.** The MCP path currently exposes a
   compact summary. Add typed sanitized results/artifact references where needed
   for an agent to act on search evidence; keep full documents and secrets out of SSE.

Acceptance: repeated calls in one scope continue; isolated scopes cannot read or
mutate each other; expired scope/resource references fail explicitly; parallel
independent tasks are correctly attributed; shared resources cannot have two writers;
unknown/unselected tools, local-only egress and unapproved external writes stay blocked.

## Browser continuity and research split (P0; implementation complete)

Owners: 3B with Person 1; Person 2 reviews privacy and side-effect handling.

1. [x] Inventory registry tools as research search/read versus interactive browser
       operations using trusted metadata (`interactionMode`). Both direct and Hermes calls
       use the same brokered implementations; no native harness search escape hatch.
2. [x] Keep research stateless: `search` and the new `read` operation open disposable
       sessions and return bounded, whitelisted evidence. Fixed lookups remain direct tool
       nodes; adaptive investigation can use Hermes with the same catalog tools.
3. [x] Bind interactive operations to an existing run-owned session. `inspect`, `click`,
       `type`, and `submit` require `sessionId`; no missing id can create a replacement page.
       `open` returns the id for refs such as `{{open.result.sessionId}}`; `extract` keeps its
       prior explicit-URL compatibility behavior. Browserbase page attachment remains within
       its existing provider session/context.
4. [x] Fail on unknown, cross-run, or wrong-backend session ids. Existing graphs using
       `{{open.result.sessionId}}` remain compatible. Credentials remain human-entered, not
       graph arguments.
5. [x] Enforce server-side agent/human ownership and serialize session calls. Handoff
       yields access before publishing a viewer link; resume returns ownership to the agent.
       Run teardown closes residual sessions. Tool/result authorization remains per action.

Acceptance: typecheck passed. Live Browserbase open -> login -> resume -> next-node
continuity, viewer expiry/recovery, and cancellation against a real provider remain
manual integration checks. Browser session ownership and backend checks are enforced
in-process; the side-pane viewer/takeover UI remains P1 below.

Manual integration sequence:

1. Create a graph with `browserbase.open` at a login page, a handoff bound to
   `{{open.result.sessionId}}`, then `browserbase.inspect` or `browserbase.extract`
   bound to that same id. Sign in during the handoff; confirm the resumed node sees
   the authenticated page rather than a newly opened tab.
2. Try `browserbase.inspect` without a session id and with an id from another run;
   both must fail without opening a page. Cancel a run with an open session and
   confirm the provider session is released.
3. Run `browserbase.search` and `browserbase.read`; confirm results are bounded
   evidence and those calls do not yield a session id for later interactive actions.

## Live supervision pane (P1, depends on browser/context contracts)

Owners: Person 4 with Person 1 and 3B. Keep the overall graph rendering redesign later.

1. Correlate real-time tool/model lifecycle events to run, node, scope, call and
   resource IDs. Show a Hermes node's expandable inner trace while retaining its
   logical graph identity. Preserve truthful live/mock/fixture/replay labels.
2. For research, show searches, tool status, evidence metadata/citations and artifacts;
   do not invent a browser view for a tool that has no visible page.
3. [x] For interactive browsing, obtain the existing session/page live-view URL from an
       authorized API endpoint and embed it in the side pane during explicit human handoff.
       Preserve viewer identity by resource, not by trace update; refresh expired signed URLs
       without reopening the task's browser. Passive view-only while the agent owns the page
       remains blocked on a provider read-only stream.
4. Add view-only and explicit takeover/resume controls backed by server ownership,
   with an external-view fallback where embedding is unavailable. Hiding pointer
   events alone is not an authorization mechanism.
5. Show agent scopes and shared browser resources as separate badges/lanes. A fresh
   agent can use an existing browser; continuing an agent need not imply a browser.

Acceptance: live activity appears before task completion, updates do not reload the
viewer, human takeover blocks agent mutation, and disconnected/unsupported views are
honestly explained.

## Run comparisons and persistence (P1, can proceed independently)

Owners: Person 4 (display/metrics), Person 1 (storage), Person 2 (baseline evaluation).

1. Trace both compare selections through API responses, stored runs/steps/egress,
   aggregation, and frontend refresh. Distinguish missing data, no selected run,
   in-progress, error, and genuine zero measurements.
2. Persist comparison identity: graph/version, equivalent input or privacy-safe input
   fingerprint, baseline/previous-run IDs, execution mode, configuration and success
   criteria. Add a migration only for fields confirmed missing; do not create a second
   inconsistent metrics store.
3. Recompute from measured events with consistent token, latency and cost units.
   Refresh the compare list and selected results as runs complete; preserve explicit
   pairing rather than comparing arbitrary latest runs.
4. Align the baseline to the same task/input and assertions, not a static unrelated
   demo. Count savings only when both satisfy the required checks. Label incomparable,
   failed and mock/live-mixed results rather than displaying misleading savings.

Acceptance: a run and its baseline populate both columns; comparing a prior run also
works; reload/restart preserves the pair; missing metrics are not rendered as zero;
zero-delegation workflows are measured normally, without a delegation penalty.

Progress: graph lineage now has a top-level `Run.graphId`, a SQLite index with an
idempotent backfill from existing JSON run bodies, and a graphId filter shared by the
API and memory store. Existing step, egress, result, and run-input records are already
durable, so no second metrics store is needed. The Compare page refreshes both sides
while either run is active, labels not-yet-measured values as waiting rather than zero,
and stops refreshing at terminal status. GraphEditor can launch against the latest
terminal run of that same graph; explicit run IDs remain in the compare URL. Typecheck
and build passed. SQLite backfill and live-run UI behavior remain manual checks.

Manual verification:

1. On a graph that has a completed run, choose “Run + compare to previous.” Confirm the
   URL contains the new and prior run IDs, both headers show the expected statuses, and
   a reload keeps the same pair.
2. Choose “Run + compare to baseline.” While either side is active, expect an updating
   note and waiting placeholders for measurements not produced yet. Confirm values
   refresh and settle after terminal status, including genuine zero values for mock or
   no-tool runs.
3. Start once with a pre-lineage SQLite database. Confirm it opens, existing graph and
   baseline runs appear under the same graph filter, and a subsequent restart preserves
   that lineage. No raw metrics are duplicated into a separate table.

## Unified graph presentation (P2, deliberately last)

Owner: Person 4. Share graph identity, layout and node styles between authoring and
execution; overlay status, measurements, scope/resource markers and expandable tool
traces. Do not replace logical nodes with unrelated runtime nodes or infer dependencies
from event arrival order. Preserve selection and layout across updates.

## Fewer Jev round trips

Built:

- The model is chosen once per agent task; public reversible reads and pre-review
  browser checks use the deterministic policy.
- Saved graphs freeze agent tool grants and tiers and fixed dispatch choices
  (`compiled`, `apps/api/src/core/graph/compile.ts`; `GRAPH_COMPILE=off` disables it).
- Browser actions are approved by consequence, not Jev's confidence
  (`core/tools/browserRisk.ts`): `submit` and clicks on buy/pay/send/delete-style labels
  always ask; everything else follows Jev's pick at any confidence.
- Cross-run target memory (`core/tools/targetMemory.ts`): per graph node, page template
  and normalized goal, identity only, public pages only, never permission. Approval
  cards let a person pick another element; that correction is remembered.
- Reuse reporting: Jev calls and warm/cold per run (`packages/shared/src/reuse.ts`),
  `GET /api/benchmarks?warmth=cold`, and the Graph Editor's Reuse panel with site-change
  and blocked-site alerts and suggestions to turn stable agent nodes into fixed steps
  (also fed to "Suggest an improvement").

Still open:

- **Keep the remaining run-time decisions live.** Judge verdicts, completion verdicts,
  dispatch goals with `{{refs}}` and browser picks on new pages judge evidence the run
  produces; do not freeze them. Revisit only with measurements showing which of these
  dominate latency, and prefer making each call cheaper over skipping it.

## Manual checks for the first batch

Start with `pnpm dev` and **Build a workflow** (not **Run as agent task**, which
intentionally always uses Hermes). Drafting never starts execution. Use synthetic
public inputs. Live synthesis needs a working configured text-model provider; mock
responses are fixtures and are not a test of natural-language routing quality.

1. Ask: "Summarize these supplied notes in three bullets. Notes: launch Tuesday;
   owner Alex; follow-up Friday. Do not research the web." Expect a one-shot `decide`
   step (optional input/redaction plumbing), with no forced dispatch or Hermes task.
2. With a reviewed web read tool connected, ask: "Read https://example.com once and
   summarize that page. No other research." Expect a direct tool plus a summary, not
   an invented provider choice. Check the API log accepts it without a fully-pinned
   rejection or an unnecessary repair call.
3. Ask for two known reads, with the second URL taken from the first result. Inspect
   the upstream reference and ordering; a reference alone should not create dispatch.
4. Ask: "Research this public claim, follow conflicting evidence, and stop after
   corroborating it or reporting uncertainty. Use the connected search/read tools;
   limit the task to two minutes and two failed tool calls." Expect a bounded
   `agent_task` with catalog tool names despite their being known. Do not expect this
   batch to add a new research provider or a shared browser/context feature.
5. Edit that plan: "Replace the investigation with one read of https://example.com
   and a summary. Remove the agent task." Expect the remaining workflow to save
   without adding a replacement dispatch/task. Existing node positions should persist.
6. In mock mode, run a direct-only graph and check that its execution contains no
   fabricated Hermes task. For any live run, first review provider modes and the plan;
   verify actual tool calls appear in the authorized trace. Do not test outbound sends
   or purchases merely to check routing.
7. Use the offline regression command for invalid JSON, empty plans, duplicates,
   dangling edges and cycles; natural-language prompts are not a reliable way to
   force a model to generate a particular invalid structure.

Still pending after the first batch: shared context/resources, browser continuation and
the live side pane, comparison fixes, and the unified graph view. No migration is
needed for the planning/admission changes.

## Manual checks for the second batch

Use a disposable graph and synthetic public data. Run
`pnpm --filter @htn/api check:graph-context` first: its deterministic doubles inspect
the exact agent input, broker calls, and browser open/close counts. A mock Hermes
answer alone cannot demonstrate which context it received.

1. In graph JSON/API, connect a `summary` node to an agent and set
   `contextInputs: { "evidence": "{{summary.text}}" }`. Save/reload and confirm the
   field persists, then run it. With no binding, only direct predecessors are passed;
   with `{}`, none are passed implicitly. The offline check verifies these payloads.
2. Change the binding to `{{summary.missing}}`: saving is allowed because result fields
   are runtime data, but running must fail with a required-context-input error before
   Hermes starts. A binding to an unconnected node must instead fail graph validation.
3. Build open -> handoff -> extract using a reviewed browser tool. Use
   `{{open.result.sessionId}}` for the handoff and `{{handoff.sessionId}}` for extraction,
   with edges between them. Check the same session ID reaches each step and is released
   at run end. Mock checks establish ID plumbing only; live page/login continuity still
   requires separate provider verification and is not fixed by this batch alone.
4. Change the handoff's ID to `{{open.sessionId}}` (missing `.result`) while keeping a
   valid URL. Run again: it must fail with the session-reference error, not open a
   replacement session. Also remove both ID and URL: handoff must fail, not open blank.
5. For a dispatch that infers arguments, bind its browser candidate's `sessionId`
   explicitly. Check that generated arguments cannot change it. The offline check
   forces an attempted replacement and also verifies that an unused candidate's bad
   reference does not prevent selecting a different valid tool.

Do not test live outbound sends or enable parallel Hermes nodes to validate this slice.
Live synthesis, browser embedding, takeover/resume, and cross-agent state retention
remain unverified and are acceptance work for later batches.
