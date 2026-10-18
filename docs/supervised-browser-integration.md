# Supervised browsing: frontend and backend integration plan

Status: implementation delivered, 2026-10-05. The backend selectors, scoped credentials, live/mock adapters, authenticated viewers and shared Action workspace below exist in the repository. [Verification and remaining hosted limits](./supervised-browser-verification.md) distinguish executed checks from protocol fixtures and unavailable external services. Browserbase remains selected; the root `.env` was not edited.

Read [agentos-design.md](./agentos-design.md) first. Its policy and privacy invariants remain authoritative. Revised after reported headless-browser failures: this plan keeps a validated cloud browser on the demo path, user-owned credentials, Browserless as the replacement candidate, and deprecated but retained Browserbase compatibility. Local Chrome remains a privacy/development option, not the demo default.

## Outcome and scope

A user starts a Hermes research task, watches its browser, pauses it, takes over for a manual step, and continues in the same authenticated session. Users can supply their own supported model credentials or use local Ollama. Browserbase remains available through environment configuration and existing explicit tools; it is not removed or renamed.

Minimize overhead by extending the existing TypeScript control plane, Playwright adapter, browser ownership wrapper, model gateway, approval flow, SSE events, and BrowserPanel. Do not introduce a second autonomous agent, a new service framework, or a plugin marketplace.

The Browserless cloud adapter and revocable live viewer are implemented. Switch the demo only after hosted target-site and handoff rehearsals pass. Keep Browserbase as the compatibility backend until then. Local headed Chrome and an embedded JPEG/input bridge are also implemented and tested with synthetic pages as a privacy/development path; they do not replace the required cloud demo rehearsal.

### Demo readiness correction and evidence

The user reports that locally automated headless Chrome was blocked or broke on Google, ASOS, and DuckDuckGo in an earlier test. No corresponding saved test report was found in the searched repository documentation/scripts on 2026-10-05. Treat this as user-reported test evidence, not independently reproduced results or a diagnosis of the cause. The original local adapter launched headless Chrome without a viewer. It now supports configurable headed launch and a real embedded viewer, verified on synthetic pages; target-site access remains unverified.

This evidence supersedes the earlier local-default recommendation for the demo. Automation compatibility and viewer readiness matter more than a zero-service-cost default. Using Playwright as the client for a cloud browser is still appropriate; the deployment location, browser configuration, session behavior, and site access are what need testing. Cloud hosting does not guarantee that a site will accept automation.

Required replacement spike: open Google, ASOS, and DuckDuckGo; perform the actual read/search/click steps; record success or the precise blocked state; embed a read-only viewer; transfer to human control; complete a synthetic manual step; revoke control; resume the same page/session; and close/reconnect correctly. Repeat the full rehearsed flow at least three times, including a handoff wait representative of the demo. Save dated evidence with adapter/configuration, account tier, session duration, observed errors, and pass/fail for each requirement, without credentials or viewer URLs. Do not infer success from a loaded homepage alone.

Browserless is a documented capability fit, not yet a verified replacement. Its free tier's two-minute absolute session limit may not cover a multi-step demonstration with human waiting. Choose a user-owned account/tier that covers the measured rehearsal duration plus recovery margin; do not assume model BYOK funds that browser time. If no candidate passes, retain the last verified Browserbase flow or explicitly label a mock rehearsal. Do not replace a failing cloud flow with untested local Chrome or label simulation live.

For discovery, prefer a configured search API where possible, with bounded public queries and truthful activity events. This reduces dependence on automated search-engine UI but does not solve ASOS or other target-site access. Local-only tasks still cannot use cloud browsers: use a tested local capability or pause as unavailable, never relax privacy for demo convenience.

## Implemented integration and external limits

| Area                   | Implemented modules                                                                                 | Behavior and limits                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent                  | `providers/hermes/live.ts`, existing ACP/model/MCP gateways                                         | Same Hermes subprocess/context. Unmapped native permissions remain denied; only trusted broker tools execute.                                                                      |
| Models/Jev/search keys | `services/credentials.ts`, `api/credentials.routes.ts`, model backends, direct Anthropic adapter    | Process-memory BYOK, trusted run pins, rotation/removal, source isolation and retry checks. Local single-user authentication.                                                      |
| Browser selection      | `config.ts`, `providers/registry.ts`, `core/tools/browserDescriptors.ts`                            | `BROWSER_BACKEND` chooses new sessions; explicit IDs and existing session providers stay pinned. Browserbase remains deprecated and usable.                                        |
| Live viewers           | `providers/{browserbase,browserless,localbrowser}/live.ts`, `api/browser.routes.ts`                 | Browserless provider Live URL; Browserbase/local JPEG and validated input bridge; no Browserbase debugger capability leak.                                                         |
| Ownership              | `providers/withBrowserOwnership.ts`, `services/approvals.service.ts`                                | Drain, revisions, grant revocation, fresh verification, cancellation guards and recovery. Done settles the existing approval only after verification.                              |
| Action workspace       | `components/actions/ActionWorkspace.tsx`, `BrowserPanel.tsx`, `ApprovalPanel.tsx`, `lib/actions.ts` | Browser, document, cell, message and generic actions share a timeline, approval authority and evidence identity.                                                                   |
| Change evidence        | `services/actionEvidence.ts`, `api/actionEvidence.routes.ts`, `core/tools/broker.ts`                | Bounded transient previews; exact fingerprints/version checks; metadata-only SSE; proposed, provider-reported and readback-verified results.                                       |
| Local artifacts        | `core/tools/documents.ts`                                                                           | Actual reviewed Markdown and JSON cell-grid updates with independent readback; these are not Word/Excel application automation.                                                    |
| Composio/MCP           | `providers/composio/register.ts`, `core/mcp/connections.ts`                                         | Runtime trusted schemas/accounts/scopes, exact reviews and bounded receipts. Office mocks are explicit fixtures; live Office/call capabilities depend on connected provider tools. |
| Search                 | `core/tools/search.ts`                                                                              | Browser search or optional Tavily, bounded public-only queries/results, truthfully labeled mocks; Tavily hosted credentials absent during verification.                            |

Live Composio schema discovery and one profile metadata read passed. Browserless's real adapter passed injected CDP protocol checks, and real headed Chrome passed synthetic HTTP handoffs. Browserbase hosted creation returned HTTP 402 (exhausted minutes); Browserless credentials were absent. No Google/ASOS/DuckDuckGo cloud success, live Office edit, call media or hosted viewer rehearsal is claimed.

The current browser tool executor's search/read path returns bounded page evidence without invoking Stagehand natural-language extraction. Stagehand's optional `act`/natural-language extraction path uses a globally configured Anthropic key. Do not use that path for the new default browser execution.

## Architecture and responsibility boundaries

```text
Dashboard: task / browser panel / credentials / approvals
      | HTTP lifecycle commands + existing SSE state events
AgentOS: canonical run state + session ownership + exact-action broker
      |                                    |
Hermes ACP subprocess                 browser adapter
      |                               /      |       \
AgentOS model gateway             local   Browserless  Browserbase
      |                           Chrome   optional    deprecated
user's Gemini/Anthropic key or Ollama

Jev: sanitized state -> typed operation/target selection
Local viewer: pixels -> authenticated dashboard; human input -> owner-checked bridge
Search provider: public query -> bounded results -> browser page navigation
```

- Person 1 / lane A owns run lifecycle, credential context plumbing, Hermes permission callback, HTTP/SSE integration, and canonical control transitions.
- Person 2 / lane B owns credential/model eligibility, local-only enforcement, Jev fallback, exact-action policy, and approval semantics.
- Person 3B / lane C owns browser adapters, viewer transport, tool descriptors, resource mapping, and search executor. Person 3A reviews catalog additions.
- Person 4 owns frontend interaction, accessibility, and truthful state presentation.

These are cross-track dependencies. Implement against additive protocols and deterministic stubs until the corresponding owner supplies the integration. Respect the existing phase gates and lane queue; this document does not authorize starting blocked board issues or assign new decision IDs.

## Environment selection and Browserbase deprecation

These settings are implemented in `config.ts` and `.env.example`. The example keeps provider modes mock for a keyless checkout; the live configuration below is an operator's explicit choice. Existing variables remain valid.

```dotenv
# Preferred general browser; default browserbase for compatibility until replacement passes rehearsal.
BROWSER_BACKEND=browserbase
LOCALBROWSER_MODE=disabled
LOCALBROWSER_CHANNEL=chrome
LOCALBROWSER_HEADLESS=false
# The embedded JPEG/input viewer uses the adapter's same page; no viewer mode setting is needed.

# Retained deprecated backend. Keep enabled for the existing verified flow until replacement passes.
BROWSERBASE_MODE=live
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=

# Replacement candidate: validate cloud site access and handoff before selecting.
BROWSERLESS_MODE=disabled
BROWSERLESS_BASE_URL=https://production-sfo.browserless.io
BROWSERLESS_API_KEY=
BROWSERLESS_SESSION_TIMEOUT_MS=120000
BROWSER_VIEWER_TIMEOUT_MS=60000

# Never spend operator model/browser/search credentials implicitly in user-owned mode.
CREDENTIAL_SOURCE=user
# Keep the existing operator browser account; change to user to require the user's browser key.
BROWSER_CREDENTIAL_SOURCE=operator
# Existing supported modes and model IDs remain in their current variables.
JEV_MODE=live
AI_GATEWAY_API_KEY=

# Optional discovery API; browser search remains available without this service.
WEB_SEARCH_BACKEND=browser
WEB_SEARCH_MODE=live
TAVILY_API_KEY=
```

To switch the preferred backend after a successful hosted rehearsal:

| Backend                   | Settings                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Local privacy/development | `BROWSER_BACKEND=localbrowser`, `LOCALBROWSER_MODE=live`                                  |
| Browserless               | `BROWSER_BACKEND=browserless`, `BROWSERLESS_MODE=live`, endpoint and provider credentials |
| Deprecated Browserbase    | `BROWSER_BACKEND=browserbase`, `BROWSERBASE_MODE=live`, existing key/project settings     |
| Keyless rehearsal         | `MOCK_ALL=true`; every view and result explicitly labeled mock                            |

Configuration is frozen at startup: changing `.env` requires restarting the API. Never migrate a running session to another backend. A session stays pinned to its original provider, run, page target, and credential scope until closure.

`browser.local` remains permanently bound to localbrowser. The general `browser` binding follows `BROWSER_BACKEND`. Selecting a cloud backend never overrides local-only eligibility. Selecting a disabled backend produces an actionable unavailable state; do not auto-switch to a different cloud provider.

Preserve the keyless boot/mock demo. Existing live-to-mock configuration fallback may remain for rehearsal compatibility, but a request for a real user run must check effective mode and report unavailable instead of silently satisfying it with simulation.

Existing `browserbase.*` IDs continue to execute Browserbase explicitly; `localbrowser.*` stays local. Add `browserless.*` through the existing descriptor factory. Do not alias `browserbase.*` to another backend: its destination, credentials, approvals, and provenance would become incorrect. Preferred-backend selection influences new task candidates and new graph defaults; saved graphs retain their explicit vendor choice. Policy may still expose an eligible local tool alongside the preferred backend.

Show Browserbase as “Deprecated · compatibility backend” in Connections and provider selection, with a migration hint. Deprecation does not mean removal, execution failure, or a false claim that existing support is broken. Keep its factory, dependencies, tests, and environment variables. Existing Browserbase graphs must remain usable when explicitly enabled.

## Credentials and who pays

Browser execution, generative inference, Jev evaluation, and search are separate resources. A user's Anthropic/Gemini key pays for model inference only. Cloud browsing needs its own provider credential; Jev needs a Vercel AI Gateway credential; Tavily needs its own credential. Local Chrome has no browser-service charge. Ollama uses local hardware.

Introduce a small internal credential resolver rather than changing Hermes to contact models directly:

```ts
interface CredentialResolver {
  resolve(input: {
    principalId: string;
    runId: string;
    providerId: string;
    purpose: 'model' | 'decision' | 'browser' | 'search';
  }): Promise<ResolvedCredential | null>;
}
```

`ResolvedCredential` is internal only: opaque reference, secret, optional provider account/project metadata, and credential version. It must never be a shared DTO, tool argument, prompt field, artifact, SSE payload, or metric label.

1. Trusted request authentication assigns the principal; never trust a submitted `principalId` or local gateway bearer token as proof of a multi-user identity.
2. Local single-user MVP stores credentials in memory and clears them on server restart. Show that lifetime before submission. Never use localStorage, URL parameters, or plaintext SQLite for raw keys.
3. Model backends resolve credentials from trusted run context immediately before calls. Keep the existing route/policy filter and gateway tokens; gateway authentication and upstream provider keys are distinct.
4. `CREDENTIAL_SOURCE=user` requires the user's credential. `operator` uses configured environment keys for an explicitly operator-funded deployment. Default to `user` for the new live flow; mock boot still works. No silent fallback between sources.
5. Provider factories must not cache one user's secret globally. Cache browser/model clients by credential reference/version and principal, or construct inexpensive clients per call.
6. Removing or rotating a key invalidates affected clients. Close its cloud sessions and prevent further inference; pending external writes must not replay automatically.
7. Credentials needed by a run are pinned by reference. Route escalation must select only models for which that principal has eligible credentials and budget.

A hosted multi-user product requires real authentication and an encrypted secret store before accepting user keys. A local API must bind to loopback, validate origin, and require authenticated setup/control requests. Do not deploy the single-user shortcut publicly.

Initial BYOK supports the repo's Gemini and Anthropic routes plus Ollama. Other providers require explicit adapters and eligibility metadata; an “OpenAI-compatible” URL is not automatically a safe or supported route. Custom endpoints must pass destination policy and cannot be supplied by page content.

When Jev credentials are missing, use the existing deterministic fallback only within its supported target-matching scope. Label decisions `deterministic`; ambiguous targets pause for clarification. Never claim a generic model is Jev or use missing Jev credentials to bypass authorization.

## Browser adapter and minimal backend changes

Reuse `BrowserAdapter.openSession/snapshot/perform/extract/closeSession`, `setOwnership`, and `releaseRun`. Preserve server-side element handles and freshness, visibility, enabled-state, and occlusion checks. Jev receives the bounded numbered table, never screen frames or raw page DOM. Hermes generates typed text; Jev does not generate it.

Add optional viewer methods or a small internal viewer capability alongside the existing interface. Add shared fields only; do not replace published `domain.ts` contracts or change existing return shapes destructively.

Implemented viewer metadata: `kind: stream | iframe | none`, `canWatch`, `canControl`, `expiresAt`, viewport dimensions, and session control revision. Existing `interactive` compatibility semantics remain; absence means unsupported, not implicitly enabled. Signed URLs are returned on demand and never persisted in `BrowserSessionRecord.liveViewUrl` or events.

### Implemented local launch

`LOCALBROWSER_HEADLESS` and `LOCALBROWSER_CHANNEL` configure installed Chrome. The adapter uses an isolated context and the actual active page for automation, frames and manual input. A visible native window is available in headed mode; the dashboard embeds the page through its authenticated frame/input bridge.

Native Chrome is directly controllable outside the dashboard, so exclusive human input cannot be enforced while its window is visible. Describe this as a cooperative local mode and use it for development/initial delivery. It is not sufficient for the strict exclusive-control acceptance criteria of the embedded mode. Pause must still block agent dispatch and wait for in-flight commands.

### Implemented embedded viewer

The adapter captures bounded JPEG screenshots on demand and dispatches validated input through the same Playwright page. The dashboard polls one frame at a time; the HTTP route rejects concurrent requests for a session. This reuses HTTP/local cookies and adds no WebSocket/VNC service. Frames show the adapter's actual active page, including tracked popup changes.

- Send JPEG frames through authenticated `GET /runs/:id/browser/:sessionId/frame`; lifecycle metadata remains on SSE. Responses are `no-store` and capped at 2 MB.
- Poll only while the viewer is attached/active, with one frame request in flight. There is no queued frame buffer or recorded video.
- The fixed remote viewport maps click, wheel, text, plain-text paste and keyboard input through the displayed scale/letterboxing. Input outside its bounds is rejected. Uploads, clipboard file/image transfer and drag remain unsupported.
- Separate watch and control grants on the server. A watch connection cannot send input, JavaScript, navigation, or raw CDP commands. A control connection accepts a small validated input schema only during human ownership.
- Authenticate HTTP requests with the local HttpOnly cookie, verify run ownership/Origin, and bound input/frame sizes. Input also carries the current ownership revision; no API key is exposed in a frame URL.
- Bind control grants to principal, session, and control revision. Reject stale input and close control channels before returning ownership to the agent.
- Streams show page contents. Keep frames local in local mode, out of model context, logs, recordings, and artifacts. Do not claim local browser mode prevents normal network requests to the websites the user visits.
- New tabs/popups must be detected and associated with the same run. Track the active page target explicitly and refresh its snapshot/viewer together. Never accidentally stream one tab while executing another.

### Browserless replacement candidate

Connect `playwright-core` over CDP with provider credentials, reuse element-table collection and target validation, and implement viewer creation/revocation using Browserless's live URL commands. Extract shared browser helpers only where required by both adapters; avoid rewriting Browserbase's Stagehand path during this migration.

Issue server-enforced read-only links while the agent owns the session. For takeover, close any previous interactive grants and mint an interactive link only after ownership transfer. On resume, revoke interactive links and confirm revocation before agent I/O resumes. If revocation cannot be proven, remain paused or close the session. Link expiration/disconnect never proves the human task succeeded. Keep session duration and viewer-link duration separate, and reserve time for completion verification.

Check actual account feature support, session limits, link embedding, popup behavior, and revocation during a live spike before declaring the adapter ready. Browserless's free cloud plan has a short session limit; do not treat free self-hosting as including premium hybrid viewing.

Browserless reconnect boundary: viewer refresh/remint works while the automation connection remains open. Loss of the Playwright CDP transport closes/fails that session; it does not recreate a page with the old in-memory state. Persistent browser profile data is not equivalent to the same live page. See the verification report's official documentation links.

## Ownership state machine

Use the existing canonical run and browser ownership state as authority. Add a browser control phase/revision if needed, rather than maintaining competing frontend state machines.

| State            | Agent page I/O                                                               | Viewer input                      | Primary action                  |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| Agent running    | Authorized calls allowed                                                     | Rejected                          | Pause / Take control            |
| Pausing          | No new dispatch; drain current call                                          | Rejected                          | Show “Finishing current action” |
| Paused           | Blocked                                                                      | Rejected                          | Continue / Take control         |
| Human control    | Blocked, including inspection/extraction                                     | Allowed for current control grant | Done — continue                 |
| Verifying        | Only a narrowly scoped local verification operation after control revocation | Rejected                          | Show “Checking page”            |
| Closed / expired | Blocked                                                                      | Rejected                          | Restart explicitly              |

Takeover sequence: authorize the proposed transfer -> acquire existing session lock -> block new agent I/O -> settle current action -> set human owner/revision -> issue control grant -> publish state. Do not blindly interrupt and retry a click or submit that may already have taken effect.

Resume sequence: user confirms -> revoke human grant and reject queued stale input -> enter verification phase -> inspect only the configured success condition without sending credentials to a model -> invalidate snapshots/target caches -> reauthorize continuation -> assign agent ownership -> continue the same Hermes ACP context. Failed verification returns to paused/human control with a precise message.

Run pause and browser takeover are related but distinct. During a manual browser step, freeze model/tool advancement for the affected agent context, not only the browser executor. A single-context run pauses entirely. Other independent contexts can continue only if resource locks and run semantics already support that behavior.

Cancellation revokes grants, stops streams, cancels the harness, releases browser sessions, and publishes closure. Cleanup is idempotent. Network disconnect leaves the session paused for a bounded interval; it never transfers ownership back automatically.

Preserve exact-action approval for external sends, purchases, destructive actions, and credential changes. A handoff confirmation is not blanket approval for the agent's next submit action. Human input under an explicit control grant is an audited manual action, not a model tool execution; do not store its keystrokes. Every agent tool execution still passes `authorize_action` with the exact proposed action and fails closed.

## API and event integration

The implemented HTTP routes below reuse the existing lifecycle and approval handlers. Paths are relative to `/api`; authenticated responses are `no-store`.

| Endpoint                                                                               | Behavior                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Existing `GET /runs/:id/browser/:sessionId/live-view`                                  | Compatibility response; resolve actual session provider; return no-store viewer metadata            |
| `POST /runs/:id/browser/:sessionId/viewer`                                             | Authorize and mint watch/control grant; control requires human ownership                            |
| `POST /runs/:id/browser/:sessionId/take-control`                                       | Atomic pause/drain/ownership transfer; may attach existing handoff approval                         |
| `POST /approvals/:id/decide`                                                           | Handoff Done authority: revoke, verify, persist, emit, then settle; failures leave approval pending |
| `POST /runs/:id/browser/:sessionId/release-control`                                    | Continue a manual takeover with no pending approval; never bypass a handoff gate                    |
| `GET /runs/:id/browser/:sessionId/frame`, `POST .../input`                             | Bounded local/Browserbase JPEG and human input, owner/phase/revision checked                        |
| `POST /credentials/session`, `GET /credentials`, `PUT/DELETE /credentials/:providerId` | Local capability setup and process-memory keys; responses contain status only                       |
| `GET /runs/:id/actions/:actionId/evidence`, `GET /runs/:id/previews/:previewRef`       | Run-bound evidence metadata and transient human previews; expired previews return unavailable       |

All dashboard mutations, including graph authoring and provider/MCP setup, use the same local cookie/origin boundary. Model/MCP harness endpoints retain their separate gateway authentication. This does not turn the MVP into a hosted multi-user service.

Do not implement separate resume paths that can bypass approval resolution. Require expected control revision on mutations and idempotency keys for takeover/continue; duplicate requests return the same transition result. Return structured errors such as unsupported viewer, stale revision, session expired, wrong run, credentials missing, and pending exact-action approval.

Add metadata-only SSE events for control phase, viewer availability, credential-required, and closure if existing events cannot carry them additively. Include run/session IDs, revision, provider, truthful execution mode, and safe reason codes. Never include viewer bearer URLs, cookies, page form values, raw secrets, or raw screen frames. On reconnect, load canonical state before applying newer events.

Return `Cache-Control: no-store` for viewer/credential responses. Validate run/session/principal association on every request, WebSocket upgrade, frame subscription, and input message. Do not expose provider CDP URLs or secrets to the frontend. Human-view URLs are short-lived bearer capabilities and must be kept out of logs.

## Frontend interaction and visual design

BrowserPanel is the shared browser surface within a docked Action workspace. Expansion widens the docked region to the viewport; it is not a modal or a separate browser popup. The narrow-screen layout keeps decisions readable and preserves task context. No mandatory new tab/popup is needed for handoff.

Layout:

1. Header: “Browser”, provider/location badge, execution mode, ownership state, expand/close controls.
2. Main area: readable browser viewport; URL/title metadata sanitized to avoid leaking query credentials.
3. Control bar: Pause, Take control, Continue, Cancel with clear state-dependent availability.
4. Context area: current task, manual-step instructions, and collapsible agent action/decision trail. Keep Jev confidence and numbered targets in the details view rather than crowding the viewport.

User-facing labels should be concrete: “Agent is browsing”, “Paused”, “Your turn”, “Checking page”, “Browser disconnected”. Show local/cloud location independently from inference location: local browser plus cloud model is possible. Do not label that combination fully local/private. Browserless and Browserbase badges always disclose cloud execution.

Watch mode: visible live stream, server-enforced input rejection, Pause/Take control available. No deceptive disabled overlay covering an actually controllable cloud URL.

Handoff mode opens the panel, displays the instruction and presents “Done — continue”. The selected branch/browser is blocked while the user works; user-requested takeover pauses the broader run. The panel focuses its semantic aside and restores focus when closed. Expired/disconnected states and refresh/recovery controls are implemented; there is no ticking session-expiry countdown. Unrelated SSE updates preserve selected action/viewer state.

Paused mode: distinguish Pause from Take control; pausing alone does not grant input. Closing the panel does not resume, cancel, or close the browser. Cancel is clearly distinct from hiding the panel.

Credential setup: choose model provider, paste its key, optionally connect cloud browser/search/Gateway accounts, or choose Ollama. Explain who is billed and whether the key lasts until restart. Mask values, offer removal, and show connection status without returning saved secrets. Validation that makes a billable request must be explicit. Avoid assuming a paid subscription includes API access.

Empty/error states must say what can be done: Chrome missing -> install/select Chrome; native mode -> use the Chrome window; mock -> simulated run, no live browser; disconnected -> reconnect; expired -> explicitly restart; blocked by policy -> show safe reason and permitted next step. Never claim a live browser exists when only a decision trail is available.

Controls use keyboard-accessible buttons, visible focus, semantic labels, readable contrast and text alongside color. Ownership changes use a restrained live region rather than frame announcements. The docked region uses focus/restore instead of a modal trap. Keyboard input reaches the browser only while the browser control region is focused and an active human grant permits input; verification/loading/stale states disable it.

Remove the existing blanket handoff text claiming nothing entered is read/logged/sent. The real promise is narrower: manual keystrokes are not logged or passed to a model by the viewer; subsequent authorized page inspection can read page contents, and cloud-browser providers host the session. Redact password/token values in element tables and evidence before model calls; exclude secrets rather than relying on explanatory copy.

## Search and research behavior

Keep browser-backed search for the zero-extra-provider path. Add optional Tavily discovery behind the same exact-action broker when configured. Return bounded titles, URLs, snippets, timestamps where available, and provenance; let Hermes open selected sources in the supervised browser. API discovery appears in the activity trail, not as fabricated browser animation.

Allow public queries only for remote search. Never send local-only/private source material by constructing a “public” query from it. Apply label propagation to derived queries. Search results and page instructions are untrusted input and cannot change permissions, choose credentials, or grant tools.

Expose search and page reading separately from external browser writes so policy can give research a narrow grant. Apply request/result budgets, timeouts, and destination validation. Do not promise every website is automatable; login walls and blocked pages result in handoff or a truthful blocked outcome.

## Delivery sequence and ownership handoffs

| Increment | Deliverable                                                                                  | Owner/dependency               |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| 1         | Validated backend selector; retain/deprecate Browserbase; actual session-provider resolution | Lane C, shared contract review |
| 2         | Browserless site-access/viewer/handoff spike; switch only after rehearsal passes             | Lane C + A + frontend          |
| 3         | User credential resolver and gateway integration; no operator fallback                       | Lane A + B, frontend setup     |
| 4         | Shared Action workspace and cloud watch/control ownership                                    | Lane C + A, frontend viewer    |
| 5         | Deferred local headed/embedded viewer; separate site validation                              | Lane C, policy review          |
| 6         | Search API discovery and end-to-end supervised research                                      | Lane C + B, frontend activity  |

Use deterministic test doubles for cross-track dependencies. Do not mark exclusive embedded control complete when only a native window exists. Do not enable a live BYOK UI until run/principal isolation and redaction work. No credentials, outbound sends, or data deletion are performed as part of this planning document.

## Verification and acceptance

Add meaningful checks to existing browser-tool, model-gateway, MCP-gateway, graph, and web test suites. Test control races and cross-user leakage, not just interface snapshots.

- [ ] Candidate cloud browser passes the actual Google/ASOS/DuckDuckGo steps and three complete viewer/handoff/resume rehearsals; failures and account limits are recorded truthfully.
- [ ] Demo session lifetime covers measured execution plus human waiting and recovery margin; local Chrome is not a mandatory demo dependency.
- [x] `BROWSER_BACKEND` and explicit provider IDs remain independent — browser integration/HTTP fixtures passed for all three backends.
- [ ] Existing hosted Browserbase graph completes handoff/resume — mock lifecycle passed; live creation blocked by HTTP 402.
- [x] Keyless mock boot and smoke passed; tool/viewer modes and simulated results are explicit. User-funded live model/browser calls require scoped keys with no operator fallback. Legacy startup mode resolution remains visible in provider status.
- [x] Local-only browser/search/model/Jev policy checks passed without remote dispatch.
- [x] Watch input, foreign-run and stale revision denial passed; hosted Browserless watch enforcement tested through injected CDP, not a hosted client.
- [x] Takeover drain and rejection of new agent I/O passed.
- [x] Revocation, stale queued input, snapshot invalidation and same-session continuation passed on mock/injected-CDP and real synthetic local flows. Hermes ACP context is preserved by the existing adapter; no hosted full-loop rehearsal is claimed.
- [x] Failed revocation/verification and cancellation remain frozen/closed; late verification cannot revive a stopped action.
- [x] Graph handoff and user takeover reuse the canonical wrapper/approval lifecycle. Graph handoff blocks its branch/resource; user Take control pauses the whole run.
- [x] Each later send/submit requires its own exact-action decision — smoke and forced-approval regression passed.
- [x] Credential source/principal/run isolation passed against two synthetic principals; public multi-user authentication remains outside this local MVP.
- [x] Key removal/rotation blocks future dispatch and invalidates browser transport without operator fallback.
- [x] Secret/OTP redaction, metadata-only events, private previews and no-store frames passed targeted checks.
- [x] Single-flight bounded frame responses and idempotent release/cancellation passed lifecycle checks.
- [x] Active-page popup/target tracking and all-page grant cleanup passed injected/local tests; hosted popup rendering awaits rehearsal.
- [x] Seven UI scenarios and desktop/mobile visual review passed; hosted iframe attachment remains separately unverified.
- [x] `pnpm typecheck`, `pnpm test`, and `pnpm build` passed.
- [x] `pnpm smoke` passed against a running mock API; real local synthetic HTTP handoff passed.
- [ ] Hosted cloud handoff, manual login/CAPTCHA and target-site rehearsals remain blocked/unverified as recorded above.

For this documentation-only change, validate Markdown formatting and local file references. Do not report runtime checks as performed merely because this checklist exists.

## Provider documentation and operational limits

Reviewed 2026-10-05; recheck before live adapter implementation. These are documented capabilities, not measured reliability claims.

- [Browserless iframe embedding](https://docs.browserless.io/baas/monitor-sessions/embedding-live-url): watch-only and interactive browser views.
- [Browserless CDP extensions](https://docs.browserless.io/api-reference/cdp-extensions): live URL creation/closure, reconnect, and lifecycle events; viewer completion is not success verification.
- [Browserless pricing](https://www.browserless.io/pricing): free cloud tier lists 1,000 units/month, two concurrent browsers, and two-minute maximum sessions.
- [Browserless repository](https://github.com/browserless/browserless): premium hybrid automation and self-hosting license distinctions; do not assume cloud feature parity in the free container.
- [Cloudflare pricing](https://developers.cloudflare.com/browser-run/pricing/) and [Live View](https://developers.cloudflare.com/browser-run/features/live-view/): alternative cloud backend, free usage limits, and viewer guardrails; deferred to avoid another adapter in the initial implementation.
- [Browser Use local setup](https://docs.browser-use.com/open-source/quickstart): supports user model keys but introduces a separate browser agent loop; deferred while Hermes remains the harness.
- [Browser Use live preview](https://docs.browser-use.com/cloud/browser/live-preview): documented production UI-only view restriction is insufficient as the sole ownership boundary.
- [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search): optional structured web discovery; credentials and billing separate from model inference.

## Shared action workspace: Composio, MCP, and document changes

Extension agreed 2026-10-05. The same docked/expanded window should show browser work, connected-app tool calls, document change previews, execution receipts, and approval controls. This is a documentation-only proposal; no custom renderer or endpoint below exists yet.

The shared surface is an **Action workspace**. A browser stream is one renderer inside it, alongside a document diff, spreadsheet change table, message preview, or generic tool result. Preserve BrowserPanel as the browser renderer and extract its surrounding shell only when implementing this extension. Do not rebuild the browser viewer or introduce a second action executor.

Composio/MCP calls usually execute APIs rather than drive visible application windows. Show real lifecycle events and evidence of changes, not an animated cursor suggesting that Word or Excel was open. If actual desktop Office interaction is needed, it is a separate local tool adapter and screen stream behind the same broker; Composio integration alone does not supply that capability. A remote Office editor may prohibit iframe embedding or require a separate authentication/session flow. Start with a diff plus “Open document”, not a full Office editor embedded in AgentOS.

### Reuse map and concrete repository gaps

| Existing module                                           | Reuse                                                                                      | Small extension                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `core/tools/broker.ts`                                    | Exact-action authorization, proposed/executing/succeeded/failed lifecycle, revision checks | Link approved payload to preview fingerprint and resource version; attach metadata-only change receipts                   |
| `providers/composio/register.ts`                          | Discovered schemas, descriptors, connected-account binding, executor registration          | Allowlisted family-specific evidence adapters; stop equating a successful call with independently verified document state |
| `core/mcp/server.ts`, `core/mcp/connections.ts`           | Hermes interception and MCP connection/tool grants                                         | Keep every nested action inside the same exact-action gate; add safe result normalization where needed                    |
| `packages/shared/src/events.ts`                           | `tool.lifecycle`, approvals, sequence/replay, `RunView.toolLifecycle`                      | Add optional preview/change references rather than streaming full tool outputs                                            |
| `components/approvals/ApprovalPanel.tsx`                  | Approve, revise, reject and `api.decide`                                                   | Extract reusable approval controls; display family renderer with expandable exact proposed payload                        |
| `components/graph/BrowserPanel.tsx`                       | Browser viewer, handoff, responsive panel behavior                                         | Move shared header/container to Action workspace shell; keep browser-specific controls in renderer                        |
| `components/graph/GraphCanvas.tsx`, `pages/Workspace.tsx` | Selected node, session linkage, pending approvals                                          | Open the same workspace for the selected tool action/resource and for any pending approval                                |
| `core/locks.ts`                                           | Existing resource/transcript serialization                                                 | Lock mutations by principal/account/resource; avoid parallel edits to one document                                        |
| `ToolExecutionOutput` in `core/tools/executors.ts`        | Summary, labels, sanitized model output, verification flag                                 | Add optional internal evidence metadata through additive types; return document metadata, not document contents           |

Composio registration now returns a bounded execution receipt instead of arbitrary provider output. Its legacy `verified` flag is true only for read-classified calls, while `evidenceVerified` remains false. Successful writes are provider-reported until an independently authorized readback adapter verifies them. Raw provider output and document bodies do not enter lifecycle/SSE or model tool results through this receipt path.

### One action identity and one approval authority

Existing run, step, action, approval, provider, descriptor-version and connected-account identities remain authoritative. The reducer groups `tool.lifecycle` events by `action.id`, preserves ordered SSE arrival and deduplicates lifecycle IDs; the stream hook reloads terminal state after replay to handle connection races. It does not compare event sequence numbers itself. Revisions retain the original proposal and final reauthorized payload. The preview is an aid to understanding, never an alternate action source or authorization authority.

Distinguish these states in the UI:

| State                     | What the workspace displays                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| Proposed                  | Requested target and exact intended changes; no claim of execution     |
| Awaiting approval         | Frozen reviewed proposal, required user decision, preview availability |
| Approved / executing      | Decision receipt and real current tool lifecycle                       |
| Provider reported success | Provider receipt; independent readback may still be pending            |
| Verified changes          | Resulting version/state and evidence of actual change                  |
| Rejected                  | No execution of this proposed action; earlier committed steps remain   |
| Failed / outcome unknown  | Error or uncertainty; never imply that no side effect occurred         |

“Reject” prevents a pending action. It cannot undo changes already executed. Offer “Revert” only when a supported inverse exists; reverting is a new authorized action, may require approval, and must not overwrite newer user edits. A generic graph approval node gates subsequent execution; it does not automatically bind a particular document patch. Use tool-broker exact-action approval for document mutations and reuse graph approval nodes only where a frozen change-set reference is explicitly attached.

### Minimal preview and change evidence contract

Add a small renderer registry keyed by trusted tool family/schema version. A pure preview builder can inspect already authorized, label-eligible local context and proposed arguments. It cannot execute a provider tool, acquire new permissions, fetch a document, or trust provider descriptions to assign its renderer. Unknown tools use a generic exact-arguments view.

Implemented metadata-only record in `packages/shared/src/actionEvidence.ts` (additive to existing contracts):

```ts
interface ActionEvidence {
  actionId: string;
  runId: string;
  resourceRef: string; // opaque server-side binding, not an arbitrary fetch URL
  kind: 'document' | 'spreadsheet' | 'presentation' | 'message' | 'generic';
  phase: 'proposed' | 'executed';
  evidenceLevel: 'arguments_only' | 'provider_reported' | 'readback_verified';
  previewRef?: string;
  baseVersion?: string;
  resultingVersion?: string;
  fingerprint: string;
  summary: string;
  dataLabels: DataLabel[];
  executionMode?: 'live' | 'mock';
}
```

The bounded transient preview store retains up to 500 actions and eight proposal revisions per action; individual previews are capped at 64 KB. Exact raw actions stay internal while review is pending, then retire on completion/blocked/failure. Original and revised proposals keep the same resource identity with distinct fingerprints and preview references. Restart/eviction expires the preview instead of persisting document bodies. Local artifact files are per-run Markdown/JSON grids with content-hash versions. The run record/SSE contains metadata only. Browser control grants and document evidence references remain different capabilities.

An authorized human preview endpoint may deliver document snippets or rendered content to its viewer; that is distinct from tool result metadata and model context. Enforce principal/run/resource association, sensitivity policy, bounded payloads, no-store responses, and independent access rights. Local-only artifacts must remain local. Remote Composio or Office API calls are cloud egress even if their result is displayed locally.

### Office changes: prepare, review, commit, verify

1. Discover the exact supported toolkit/tool schema and connected account. Do not invent Word/Excel/PowerPoint tool slugs or assume all Microsoft Office operations exist. Generic MCP tools may need a different evidence adapter.
2. If before-state is needed, propose a separate read action through the broker. Its privacy labels and access gate still apply. Missing read scope must never trigger silent permission expansion just to make a diff.
3. Build a bounded local draft/patch from the authorized base state and exact write arguments. Display “Proposed changes”. If the tool only provides an instruction such as “rewrite this file” and cannot bind a deterministic result, prefer creating a local draft and a reviewed upload/update step. Otherwise disclose “Outcome preview unavailable” and show the exact instruction; do not fabricate a diff.
4. Freeze approval to action ID, arguments, destination, descriptor version, connected account, resource/version, and preview fingerprint. The server computes the fingerprint over the actual patch/payload and base version. A changed draft or resource requires revalidation and, when material, fresh approval.
5. Immediately before commit, check target identity and version/ETag. Use provider conditional-write support when available. A changed base is a conflict: recompute the preview and request a new decision. When conditional writes are unavailable, disclose the limitation; use the existing resource lock and do not claim protection against concurrent edits made outside AgentOS.
6. Execute the approved exact action once through the existing broker/executor. For multi-call changes, each call is authorized; do not claim atomicity unless the provider actually guarantees it. Approval of a bounded change set must not become an unrestricted bulk tool grant.
7. Perform a separately authorized readback if supported. Compare expected changes to resulting state/version; return metadata and attach verified evidence. Without readback, show provider-reported success. On timeout after a write, mark outcome unknown and investigate through a safe read rather than blindly retrying.

The shipped document renderer shows structured text changes; the spreadsheet renderer shows proposed/executed cell values, location and truncation state. Full Office page rendering, formula-specific analysis, affected-row summaries and slide thumbnails remain optional extensions requiring a concrete supported tool. Presentations/unknown payloads use the truthful generic renderer. No Office automation or rendering service was introduced.

For outbound messages or actions that initiate calls, show the exact recipient/destination, content/parameters, and account before approval. After execution, show returned IDs/status and verified result when available. Actual audio/video streams, call recordings, and transcription require separately supported provider capabilities and permissions; tool lifecycle alone cannot show live call media. Whether “call” means an API request or a phone call must be clear in the renderer label.

### Composio Platform and MCP boundaries

Keep the current Composio adapter path working; the shared workspace does not require an SDK migration. Composio's hosted MCP execution bypasses SDK tool-call modifiers/hooks, according to its sessions-via-MCP documentation. Do not point Hermes directly at that hosted endpoint and expect SDK hooks to enforce AgentOS approvals. Keep Hermes connected to AgentOS's MCP gateway, and make any outbound MCP client a broker-controlled executor. The existing direct adapter path is the lowest-overhead starting point.

For future session-based integration, use the application's trusted principal and user-scoped connected accounts. The current registered executor's configured `userId` is not a sufficient multi-user identity model. Preserve separate credentials: user model keys, app-level Composio project access, and user OAuth-connected accounts are different resources. Model BYOK does not make Composio usage free or automatically user-funded.

Use Composio's connection links for account authorization. Do not build an Office OAuth implementation as part of the preview UI. Account selection is server-bound, displayed to the reviewer, and checked again before execution. Never expose OAuth tokens or the Composio project key to the client/model.

MCP/meta tools that can perform multiple actions, run remote code, or invoke nested tools must not bypass selected-tool grants or exact-action approval. Unwrap and broker known nested actions, or deny opaque execution until it can be safely constrained. A screenshot or document renderer cannot grant permission. Render remote HTML as untrusted content with sanitization/sandboxing; never insert provider HTML directly into the dashboard.

Current canonical Composio entry points reviewed for this extension: [documentation index](https://docs.composio.dev/llms.txt), [sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp), and [authentication](https://docs.composio.dev/docs/authentication). Verify actual toolkit schemas and account capabilities during implementation; this plan does not assert a particular Office tool is available.

### Frontend composition and approval experience

The shared shell shows the tool/provider title, destination and trusted connected-account ID when available, plus mode, phase, close/expand controls, renderer, history and pending-decision controls. Account names are not inferred. Selected action stays stable during unrelated activity, and approvals auto-open without replacing an active review. The broker copies account identity from trusted descriptor metadata, includes it in the fingerprint/envelope and rechecks it immediately before dispatch. Composio metadata versions/executor references also pin that account independently of the native provider tool version.

Default views: “Changes” for mutations, “Result” for reads/completed actions, and “Browser” for browser sessions. “Details” exposes exact payload, provider/tool name, scope, and provenance. ApprovalPanel remains the single decision API integration; extract its controller/buttons rather than implement a second approve endpoint. Keep summaries concise but make the exact reviewable payload available without leaving the panel. Redact credential-only fields; never conceal recipients, target resources, or content that the user is authorizing.

At approval, use “Approve changes”, “Revise”, and “Reject”. A revised payload must rebuild/freeze its preview and go through the existing narrowing/reauthorization rules. If rendering fails, show the exact action with “Preview unavailable”; never reinterpret that failure as approval. Disable duplicate decisions while the request is pending and use canonical server status after reconnect. Explain whether rejection blocks the node/run according to current graph semantics.

After execution, proposed and actual results remain separate. Native local spreadsheet evidence displays expected/readback values, while unsupported cloud readback stays provider-reported. Partial/unknown failure labels preserve earlier completed actions. Safe resource-URL validation is tested as a helper; no source-document link is emitted without an actual trusted provider URL. Large payloads are bounded and omissions are disclosed; incomplete proposal previews cannot be approved.

Reuse existing Badge, Button, approval controls, activity reducers, and graph selection. Implement generic action card first, then one spreadsheet/document renderer, then optional thumbnail rendering. Support keyboard navigation, semantic before/after labels, non-color diff markers, narrow-screen stacking, and focus restoration. Browser-specific Take control controls appear only in the browser renderer; a document preview does not imply manual editing support.

### Implementation order and additional acceptance criteria

This extension can ship alongside backend validation using the existing Browserbase/generic tool lifecycle; it does not depend on local viewer work. First reuse lifecycle/approval data in a generic Action workspace, then add a label-aware preview retrieval path and one reviewed change renderer. Defer a general-purpose editor, live Office embedding, desktop stream, and comprehensive Office file rendering until a concrete tool capability requires them.

- [x] Browser and tool actions reuse one shell/action identity; generic MCP lifecycle and Composio mock UI checks passed.
- [x] Proposed, provider-reported, verified, rejected, partial and unknown outcomes have distinct renderers/labels — frontend tests passed.
- [x] Approve/revise/reject use the existing service and broker — UI/HTTP and actual local write checks passed.
- [x] Fingerprints, immutable target/account/destination, version conflicts, post-review availability/scopes and privacy/turn changes block dispatch — regression checks passed.
- [x] Rejection prevents the pending mutation while preserving previously committed changes — document UI/local file tests passed.
- [x] Missing scopes fail closed; no preview network read is implicit. Local commit/readback is inside its exact authorized executor.
- [ ] Live Office before-state/readback through separate broker tools requires a connected tool/schema and provider-specific conditional-write support; current cloud results remain provider-reported.
- [x] Labels and transient preview retrieval remain separate from SSE/model results; body exclusion checks passed.
- [x] Previews render escaped structured text/cells, never provider HTML; resource link scheme/credential checks passed.
- [x] Concurrent local writes conflict; remote write failures become unknown and never retry blindly — regression checks passed.
- [x] Actual synthetic Markdown and JSON-grid writes passed approval/revision, commit and independent filesystem readback. Office mock schemas are explicitly simulated examples.
- [x] API receipts never claim a live Office screen, verified Office edit or call media.
- [x] Browserbase selection/deprecation and local-only enforcement remain intact.

The implemented architecture uses one Hermes loop, one AgentOS gateway/broker and one shared Action workspace with focused renderers. Browserbase remains the environment-selected compatibility choice, Browserless awaits hosted rehearsal, and local Chrome serves the tested synthetic privacy/development path.
