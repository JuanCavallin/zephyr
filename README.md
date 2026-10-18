# Zephyr

**A control plane for AI agents.** Built in 36 hours at **Hack the North 2026**, where it
finished **top 12 for Warp's Best Developer Tool** track. (The codebase and the design
spec call the architecture **AgentOS**; Zephyr is the product.) We're actively continuing
to build this beyond the hackathon — see [What's next](#whats-next).

Agents today are a black box holding your credentials: every step goes to the most
expensive model, the agent can see every tool you own, your data goes wherever it decides,
and you find out about the email after it was sent. Zephyr is the opposite bet: an agent
you can supervise, that gets cheaper and more private _because_ of that supervision, not
in spite of it.

Zephyr sits between any agent harness and the world. A tiny, non-generative decision model
(**Jev**) picks the model route, the handful of tools, and the moment to stop. Deterministic
policy — not the agent, and not Jev — has the final say over what is private, what is
authorized, and what needs a human first.

|                        |                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Cheaper and faster** | Each step is routed on privacy × difficulty to a local, cheap-cloud, or frontier model. Compare any run to a single-call baseline. |
| **Private**            | Sensitive spans become `[[PII_n]]` before any cloud call. An egress ledger records every destination and the class of data sent.   |
| **Supervised**         | Actions are classified by **reversibility**. Irreversible ones pause on the exact payload: approve, reject, or revise.             |
| **Observable**         | A live, replayable trace of every decision, model call, tool call and approval. Pause, resume, cancel.                             |

**Start here:** [demo script](docs/DEMO.md) · [keys for the demo laptop](docs/DEMO-KEYS.md) · [sponsor tracks](docs/SPONSORS.md) ·
[Devpost copy](docs/DEVPOST.md) · [design spec](docs/agentos-design.md) ·
[workflow roadmap](docs/workflow-roadmap.md) · [measured metrics](docs/metrics.md)

## Quick start

```bash
pnpm install && pnpm dev
```

Open http://localhost:5173. Pick a composer mode and type a goal, or go to **Runs** and launch
the **Demo run**.

There is no `.env` step. With no API keys at all, every provider falls back to a mock and
the full demo runs end to end — deliberately, not as a placeholder. To go live, copy
`.env.example` to `.env` and fill in only the keys you have; see
[provider setup](docs/provider-setup.md). Requires Node ≥ 22 and pnpm 10.

| Command                 | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `pnpm dev`              | api on :8787 and web on :5173                                     |
| `pnpm typecheck`        | all three packages                                                |
| `pnpm test`             | the 12 `check:*` invariant suites + web unit tests (what CI runs) |
| `pnpm build`            | production build of the web app                                   |
| `pnpm smoke`            | end-to-end test against a running api                             |
| `pnpm smoke:live`       | same, against live providers (costs real money)                   |
| `pnpm check:providers`  | live Ollama + provider wiring check                               |
| `pnpm test:jev`         | one live Jev decision through the Vercel AI Gateway               |
| `pnpm test:jev:routing` | Jev's privacy × intelligence routing on sample tasks              |
| `pnpm bench:browser`    | browser benchmark on live sites; needs Chrome (docs/metrics.md)   |
| `pnpm format`           | prettier (respects `.prettierignore`)                             |

## How a run works

```mermaid
flowchart LR
  U["You: a goal"] --> O[Orchestrator]
  O --> R[Redact PII locally]
  R --> J{{"Jev: route, tools, done?"}}
  J --> H["Agent harness (Hermes over ACP)"]
  H -- model calls --> MG["/v1 model gateway"]
  H -- tool calls --> TG["/mcp tool gateway"]
  MG --> M["Ollama / Gemini / Anthropic"]
  TG --> B[Exact-action broker]
  B -- reversible --> T["Browserbase, local Chrome, Composio, MCP servers"]
  B -- irreversible --> A[Human approval]
  A --> T
  O --> L[("Egress ledger + event log (SQLite)")]
  L --> UI[Live trace over SSE]
```

1. `POST /api/runs {kind, input}` returns immediately; execution streams over
   `GET /api/runs/:id/stream` (SSE with `Last-Event-ID` replay, persisted to SQLite).
2. Input is scanned locally; sensitive spans are pinned local and replaced with placeholders.
3. **Jev** makes one task-level tool grant and picks a route on two axes (`private`/`cloud` ×
   `low`/`high`). The grant is passed as a hard bound to Hermes and the model gateway; each
   exact action is still authorized independently. Below its confidence threshold or past
   its time budget, a deterministic rule decides instead. Every decision event records its `source`.
4. The harness runs behind Zephyr's own **model gateway** (`/v1`, OpenAI-compatible) and
   **MCP gateway** (`/mcp`), so it cannot reach a model or tool it was not handed.
5. The **broker** authorizes the _exact_ proposed action. Irreversible actions, and outbound
   text that GPTZero scores as likely AI-written, stop for a human. A revised payload is
   re-authorized and may only narrow the action.
6. Jev judges completion from canonical session state: `done`, `continue`, or `blocked`
   (which pauses the run for you rather than failing it).

**Self-improving workflows.** `POST /api/graphs/:id/optimize` (the editor's **Suggest an
improvement**) critiques a workflow's own run history — failing checks, per-node cost and
latency outliers, tool-selection divergence, and the gap to its single-call baseline — and
feeds that to the same synthesiser that drafts workflows from chat. The result always lands as
a **new forked graph** to review: the source is never modified, nothing runs, fewer than three
runs is flagged low-confidence, and any success check the proposal tries to add is stripped
(a proposal may not grade itself).

Playbook kinds (`apps/api/src/core/playbooks/registry.ts`): **`agent`** — the main composer,
one supervised task from a plain goal · **`demo`** — scripted tour of every subsystem, works
with zero keys · **`graph`** — run a workflow authored on the canvas · **`baseline`** — a
single LLM call, the control for the Compare page.

## Measured

Method, per-site data and the commands to rerun all of these are in
[docs/metrics.md](docs/metrics.md). The browser figures are medians over 13 live sites,
measured on 2026-10-09 with local Chrome.

| What                                                              | Result                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Jev's browser request vs the page's raw DOM                       | **98.5% fewer tokens** (81.7% fewer than a full accessibility tree) |
| Page snapshot: one in-page script vs per-element Playwright calls | **3.6 s → 19 ms**, 191x faster (lowest 92x)                         |
| Pre-action target check: 1 call vs 4                              | 19.8 ms → 1.2 ms, 15x faster                                        |
| Tools handed to the harness per task                              | at most **8**, from a 1,000+ tool catalog                           |
| Exact-action broker                                               | **14** error codes, every one fails closed                          |
| Test assertions run in CI                                         | **942** across 29 test files                                        |

## The app

| Route          | What it is                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`            | Composer, three modes: **Run as agent task** (one supervised `agent` run), **Build a workflow** (chat-to-graph: drafts a graph to review, runs nothing), **Preview** (labelled, synthetic) |
| `/runs`        | History, live status, launch a playbook directly                                                                                                                                           |
| `/runs/:id`    | Live trace: decisions, model calls, tool lifecycle, approvals, egress, pause/resume/cancel                                                                                                 |
| `/compare`     | Run vs baseline: tokens, cost, latency                                                                                                                                                     |
| `/graphs`      | Workflow editor: canvas, per-node tuning, a chat panel that edits the open graph, **Run graph**, **Run + compare to baseline**                                                             |
| `/connections` | Provider mode + health, Composio, generic MCP servers, reviewed tool inventory                                                                                                             |

## Providers

Playbooks ask for a **capability**, never a vendor; `providers/registry.ts` binds them.
Every provider has a mock twin, and a keyless checkout boots the mock demo. Legacy
operator configuration can downgrade unavailable providers to mock; the UI shows the
effective mode and health separately. User-funded live model/browser calls require the
user's scoped key and never fall back to the operator's credentials. `live` + unhealthy
is not ready.

| Provider          | Role                                                                         | Goes live with                                                            |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Jev (TypeSafe AI) | Every routing / tool / browser-target / completion decision                  | `AI_GATEWAY_API_KEY` (Vercel AI Gateway). [Read this first.](docs/jev.md) |
| Hermes (Nous)     | Agent harness, subprocess over ACP                                           | `uv` + a `hermes-agent` checkout at `HERMES_CWD`                          |
| Browserbase       | Deprecated compatibility cloud browser; remains the selected default         | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`                           |
| Browserless       | Optional remote CDP browser with revocable watch/control viewer              | `BROWSERLESS_API_KEY`, `BROWSERLESS_BASE_URL`, `BROWSERLESS_MODE=live`    |
| Local Chrome      | The private browser route: local-only data never reaches the cloud           | Chrome installed, `LOCALBROWSER_MODE=live`                                |
| Composio          | 1000+ app tools with delegated OAuth; Gmail send is reviewed as irreversible | `COMPOSIO_API_KEY`, `COMPOSIO_AUTH_CONFIG_ID`                             |
| Generic MCP       | Any HTTP Streamable MCP server; unknown tools stay unavailable (fail-closed) | add it on `/connections`                                                  |
| Gemini            | Direct Google cloud route for tool-capable agent turns                       | `GEMINI_API_KEY`                                                          |
| Ollama            | Local/private model route                                                    | Ollama running                                                            |
| Anthropic         | Bound `text.model` plus direct tool-capable cloud routes for agent turns     | `ANTHROPIC_API_KEY`                                                       |
| GPTZero           | Escalate-only check on outbound text written in your name                    | `GPTZERO_API_KEY`                                                         |

Flip one `<PROVIDER>_MODE=live` at a time and confirm it at `GET /api/providers`.

`BROWSER_BACKEND=browserbase|browserless|localbrowser` chooses new browser sessions after
an API restart; existing sessions and explicit provider tool IDs keep their backend.
Browserbase and local Chrome use an authenticated JPEG/input bridge; Browserless uses
its provider's live viewer. Local Chrome remains the privacy/development path rather
than the replacement demo default.

The shared Action workspace shows browser handoffs and document/cell/message/tool
proposals in one place, with approve/revise/reject and separate proposed/actual receipts.
Connections supports process-memory user keys (`CREDENTIAL_SOURCE=user`); browser
funding defaults to the existing operator account (`BROWSER_CREDENTIAL_SOURCE=operator`).
Cloud browsing/search and Composio/OAuth connections remain separate from model billing.
See the [integration plan](docs/supervised-browser-integration.md) and
[verification report](docs/supervised-browser-verification.md) for implemented modules,
rehearsal commands and hosted provider limits.

**Jev cannot generate text.** It returns a choice, a score, or a probability with calibrated
confidence. If you are writing a prompt for Jev you are using it wrong — it takes `criteria`.
And never skip `authorize_action` because "Jev is safe": being unable to invent an action
says nothing about whether the action it picked is authorized.

## Layout

```
packages/shared     types + zod schemas — imported by BOTH web and api
apps/api/src/
  api/              HTTP only. Knows req/res, knows no providers.
  core/             Pure domain + orchestration. No express, no fetch, no store import.
    playbooks/      what a run does
    tools/          reviewed registry, exact-action broker, approvals, browser tools
    decisions/      Jev-backed decisions with deterministic fallbacks
    modelGateway/   the /v1 surface the harness talks to
    mcp/            the /mcp surface the harness talks to + upstream MCP connections
  services/         Use-cases. Wires core + store + providers.
  providers/        The only place fetch/SDKs are allowed.
  store/            The only place data is held (memory or SQLite).
apps/web/src/       React + Vite SPA
hermes-tester/      disposable connectivity tester, not part of the product
docs/               spec, demo + sponsor + Devpost guides, contracts; docs/archive = history
```

**Dependency rule:** `api → services → core`, plus `services → providers` and
`services → store`. `core` imports nothing outward — it receives what it needs as arguments.
`packages/shared/src/domain.ts` is a published API: additive edits only. Vendor types must
not escape provider files.

### Adding a playbook

1. `packages/shared/src/schemas/playbooks/<kind>.ts` — the zod input schema
2. one line in `packages/shared/src/schemas/playbooks/index.ts`
3. `apps/api/src/core/playbooks/<kind>.playbook.ts`
4. one line in `apps/api/src/core/playbooks/registry.ts`

Nothing else changes: not the store, the routes, the streaming, or the UI chrome.

## Demo-day switches

| Env                     | Effect                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `MOCK_ALL=true`         | Forces every provider to mock. **Rehearse with this on at least once — venue-wifi insurance.**    |
| `MOCK_FAILURE_RATE=0.2` | Mocks fail randomly, so error states are exercised                                                |
| `PERSIST_TO_DISK=true`  | SQLite persistence in `.data/`, so history survives API restarts and finished runs replay offline |
| `SQLITE_PATH=...`       | SQLite path resolved from `apps/api` (default `../../.data/agentos.sqlite`)                       |

## Things that will bite you

- **Never add `compression()` to the Express app.** gzip buffering silently breaks SSE and
  the symptom looks like a hung backend.
- **Express 5 rejects bare `*` routes** (path-to-regexp v8). Use `/*splat`.
- **A step's `output` is streamed and stored.** Never return a raw document from a step —
  return metadata and keep the document in a local variable. `pnpm smoke` asserts this.
- **`req.query` is getter-only in Express 5.** Validated data lands on `req.valid`.
- **`HERMES_CWD` is an absolute path.** A `.env` copied from a teammate points at their disk;
  the API warns and runs Hermes as mock.
- **One live Hermes run at a time.** The model gateway correlates calls to the single active
  session and fails closed when that is ambiguous.
- **Do not restart the API with an approval pending.** Event history is durable; the approval
  waiter is in-process, so the orphaned run fails safely.

## Known limits

No application auth (local hackathon demo) · generic MCP supports HTTP Streamable, not
stdio · editing a node of a _running_ workflow is not implemented · the production web
build expects the API on the same origin under `/api` (no static hosting is wired up).
Deliberately skipped: Docker, TS project references, ESLint, a state-management library.

## What's next

Hack the North was the start, not the finish. The post-hackathon backend plan, its
decisions, and the board are in [docs/backend-extension-plan.md](docs/backend-extension-plan.md),
[skilleddocs/](skilleddocs/) and [docs/TEAM-WORKFLOW.md](docs/TEAM-WORKFLOW.md). In progress:

- More harness adapters (the adapter boundary already exists) so the same policy layer
  supervises any agent, not just Hermes.
- Editing a node of a _running_ workflow, under the same re-authorization rules as revised
  approvals.
- Per-user auth and policy packs — budgets, approval thresholds, data residency — for teams.
- Caching resolved browser targets so repeat runs need no model call at all.
- Using the egress ledger and approval history to learn which steps never needed the
  frontier model in the first place.

## Team

Built by four people over one hackathon weekend, now maintained past it:

- **Juan Andres Cavallin** — [@JuanCavallin](https://github.com/JuanCavallin)
- **Daniel Zhao** — [@danielzhao07](https://github.com/danielzhao07)
- **Sheharyar Meghani** — [@Sheharyar45](https://github.com/Sheharyar45)
- **Krish Punjabi** — [@KrishP147](https://github.com/KrishP147)

## License

[MIT](LICENSE)
