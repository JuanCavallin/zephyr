# Supervised browser verification

**Latest readiness review:** [2026-10-17 agent/benchmark/live-supervision audit](./agent-readiness-audit-2026-10-17.md). It identifies current privacy, benchmark-provenance and quality-scoring gaps; the October 5 checks below are historical verification, not proof that a live benchmark is ready today.

Verified on **2026-10-05**, Windows, Node 22, with installed Chrome. Browser-specific implementation and evidence below; broader Action workspace, model, search and Composio results can be recorded separately.

## Configuration and implementation

`BROWSER_BACKEND=browserbase` remains the default. The existing root `.env` was not changed. Browserbase remains a deprecated compatibility adapter, selectable independently of Browserless and the local privacy adapter. `.env.example` documents each mode and timeout. Model credentials default to user BYOK; browser credentials default to operator credentials so the existing Browserbase setup remains selectable. An explicitly selected user browser credential source fails closed when a key is missing, removed or replaced.

| Backend      | Live implementation                                                                                                    | Mock implementation                                                                                  | Current verification                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Browserbase  | Existing Stagehand browser/element implementation; AgentOS JPEG/input bridge; no native debugger URL exposed           | Deterministic sessions, numbered element tables, actions and handoff lifecycle; no real viewer/input | Mock and ownership tests passed; hosted creation blocked by account quota                            |
| Browserless  | Existing Playwright engine over remote CDP; provider-enforced watch/control Live URL; all grants revoked before resume | Same deterministic lifecycle and truthful capability labels                                          | Actual live adapter with an injected deterministic CDP transport passed; hosted service not verified |
| Local Chrome | Installed Chrome, configurable headed mode, AgentOS JPEG/input bridge; local privacy option                            | Same deterministic lifecycle and truthful capability labels                                          | Real headed Chrome and HTTP bridge passed on a loopback synthetic page                               |

Backend selection changes the browser transport, not Hermes's agent loop or Jev's typed decision contract. Explicit tool IDs remain bound to their actual provider. An inherited handoff session resolves its recorded backend and run ownership rather than the current environment preference. Cloud browser descriptors exclude `local_only` and `secret` data. Private/nonpublic browser target decisions use the local deterministic decider. Model decision caches include run, provider, session and privacy scope.

The browser supervision routes require the local HttpOnly control cookie, allowed Origin and run association. This is a local single-user deployment capability; it is not a hosted multi-tenant authentication system. Viewer responses and JPEG frames are `no-store`. Page location metadata omits credentials, query strings and fragments. Inline documents and local file paths are not exposed in location labels. Password, OTP and credential-like field values are excluded from numbered snapshots, as are hidden/ARIA-hidden controls. Viewer URLs are short-lived capabilities returned on demand; they are absent from persisted browser session events and idempotency records. Frames and manual input are not recorded or broadcast in SSE.

## Control and approval lifecycle

1. Agent ownership permits automation and a watch-only viewer. Mock sessions disclose `simulated: true`, offer no live URL and refuse real manual input.
2. Take control pauses the broader run, blocks new browser automation, drains the session's existing operation, increments its revision and grants human ownership. Input is checked both on entry and after queueing against the current owner, phase and revision.
3. Handoff Done freezes input in `verifying`, drains prior input, revokes provider control, invalidates the old target table and checks a fresh page. Optional `url_matches` checks the configured HTTP(S) origin and path prefix; it does not prove a remote write or login succeeded.
4. Only after successful preparation does the approval service persist and emit approval and settle its waiter. A verified handoff remains reserved until the approved graph continuation transfers ownership back to the agent. A concurrent take-control request cannot reopen a grant during this interval.
5. Revocation or page verification failure keeps the approval pending and the browser frozen. GET viewer returns metadata without minting another grant. The user can retry verification or explicitly recover manual control. Normal run Resume and browser Release refuse pending approvals/human ownership.
6. Release without a pending approval revokes and verifies first, then resumes the paused run. Cancellation marks ownership closed before drain; a late successful verification cannot revive a closing browser. Credential invalidation closes the affected provider transport and invalidates the session's ownership lookup.

This sequencing is exercised through the actual approval HTTP endpoint, including the assertion that no Browserless fixture grant exists when the approval-resolved event is emitted or when the Done response returns. The fixture does not represent a connected hosted iframe client.

## Commands and evidence

Commands below were run from `apps/api` unless a root command is shown. A checked item records successful execution, not merely implemented code.

- [x] `pnpm exec tsc --noEmit` — API typecheck passed after the final browser ownership changes.
- [x] `pnpm exec tsx scripts/browser-tools.check.ts` — trusted descriptors, bounded target resolution, sensitive-destination guards, session cleanup and pooled public research passed.
- [x] `pnpm exec tsx scripts/browser-integration.check.ts` — all three mocks; stale snapshots; other-run denial; ownership revisions; takeover drain; failed revocation remains frozen; cancellation during verification prevents approval/resume; actual Browserless live adapter CDP connection/watch/control/revoke/cleanup protocol against injected deterministic transport passed.
- [x] `pnpm exec tsx scripts/browser-http.check.ts --local` — all three mock HTTP lifecycles plus injected live Browserless and **real headed installed Chrome** passed. Assertions cover cookie/Origin authentication, backend/run association, no-store headers, JPEG stream, manual input, broad pause, normal resume refusal, revision/idempotency handling, pending-approval release refusal, failed revocation, expected-URL failure, frozen metadata, manual recovery, handoff revision refusal, Done ordering, same-session readback, credential deletion and cleanup.
- [x] The real local HTTP test also verified hidden/ARIA-sensitive input handling, password/OTP value exclusion and login-query redaction on its synthetic page. An initial hidden-input/CSS edge case failed the assertion and was corrected before the passing rerun.
- [x] `pnpm exec tsx scripts/browser-local-check.ts` — earlier real headed Chrome adapter rehearsal passed for JPEG capture, indexed agent input, human input, revocation, stale input rejection and same-session readback on a synthetic inline page.
- [x] Prettier was run on the owned browser adapters, routes, ownership helper, executor, privacy helper and browser test scripts.
- [ ] Browserbase hosted live rehearsal — **blocked** at session creation: HTTP 402, free-plan browser minutes exhausted. The earlier harmless live check loaded existing environment credentials without printing them. No session/page/site success is claimed.
- [ ] Browserless hosted live rehearsal — **blocked** because a Browserless credential was not available. Injected CDP tests are protocol/implementation tests, not provider-account or hosted viewer validation.
- [ ] Google, ASOS and DuckDuckGo acceptance with these completed adapters — unverified in this pass. The user's earlier local headless failures remain relevant; synthetic local success does not replace that evidence.
- [ ] Actual hosted iframe attachment, refresh/reconnect, manual login/CAPTCHA and continuation — requires provider availability and a real viewer client. It is not implied by direct HTTP/CDP input tests.

The offline `check:browser-http` command excludes the machine-dependent Chrome launch. The manual `check:browser-local-http` command includes it. The manual `check:browser-live` harness accepts an explicit `VERIFY_BROWSER_BACKEND` and optional synthetic-only selection and does not change `.env` or the preferred runtime backend. It reports challenges and failed creation honestly; provider quota/auth errors are not a successful rehearsal.

## Browserless documentation review and reconnect boundary

The implementation was reviewed against official documentation on 2026-10-05:

- [CDP extensions](https://docs.browserless.io/api-reference/cdp-extensions): request a watch URL with `interactable: false`; grant control only under human ownership; require `closeLiveURL` to confirm the returned grant ID. Revocation covers grants on all pages in the session context, including an original page after a popup becomes active. Unknown mint outcomes close the session; invalid URLs revoke their known grant. Expiry/disconnect events do not complete an AgentOS approval.
- [Embedding Live URLs](https://docs.browserless.io/baas/monitor-sessions/embedding-live-url): native viewers use a short-lived viewer capability rather than the API key, enforce view-only mode server-side and can reload/reconnect while the underlying session remains available. The permitted provider origin is validated; Browserbase native debugger URLs are never used as a watch fallback.
- [Session management](https://docs.browserless.io/baas/session-management): standard full browser-process reconnect requires Puppeteer `disconnect()`. The implemented transport uses Playwright and closes/fails the session when its automation connection is lost. It does not promise seamless restoration of the same page after that disconnect.

This clarifies the earlier plan's general reconnect language. Dashboard reopening/reminting within a still-open session is supported. Restoring a lost automation connection with full in-memory page state would require an additional validated transport/session strategy. Browserless's persistent-state API can preserve browser profile data across restarts, but that is not equivalent to the same page, scroll position or in-memory application state. No automatic fallback silently opens a replacement session for a pending handoff.

## Remaining hosted rehearsal

Keep Browserbase selected while repairing its quota/account availability. Supply Browserless user/operator credentials through the existing credential path when ready, run a harmless hosted live rehearsal, and use a real dashboard viewer to verify watch, takeover, manual interaction, Done, old-grant rejection and same-session continuation. Repeat the target-site reads across independent sessions before changing the demo backend. Provider failures or bot challenges should keep the current reversible configuration and remain visible in the UI.

No provider key, project identifier, tokenized connection URL, signed viewer URL, login input or screenshot is stored in this report.

## Shared workspace and integration verification

The remaining frontend/backend integration is implemented in the existing TypeScript API, shared contracts and React dashboard. No second agent loop, new browser service or replacement UI state store was introduced. The shared Action workspace uses canonical lifecycle/action/approval identities; browser Done and tool approval cannot bypass the existing gate.

- [x] `pnpm typecheck` — all packages passed.
- [x] `pnpm test` — the full offline API check chain and 40 frontend unit tests passed. Browser HTTP and Action workspace checks are now included in `check:all`/CI.
- [x] `pnpm build` — production web build passed (336 modules). The existing bundle-size warning remains: the main JavaScript chunk exceeds 500 KB; it is not a failed build.
- [x] `pnpm smoke` — mock demo, per-mutation graph approvals, rejection, graph lifecycle and analytics passed. The final rerun also proved unauthenticated graph authoring returns 401 and foreign-origin dashboard mutations return 403.
- [x] `pnpm check:action-workspace` — actual synthetic local Markdown and JSON cell-grid writes passed exact approval/revision, independent filesystem readback, stale-version/concurrent-write conflicts and rejection with no file creation. Document bodies stayed out of lifecycle/approval persistence and model tool results.
- [x] Expanded broker regressions passed: forced approval on an otherwise permitted read produces one review/one dispatch; remote write failure produces unknown outcome without retry; removed scopes/availability, changed labels and stale turns block dispatch after review; revisions preserve resource identity and change the preview/fingerprint. Trusted connected-account identity is included in the action/fingerprint/review payload; changing it during review blocks dispatch even when the schema/version/executor otherwise match.
- [x] `pnpm --filter @htn/web test:actions-browser` — final mock API rehearsal at **2026-10-05T18:34:40.955Z**, seven scenarios and zero page errors. Covers revision/retarget rejection, stable action selection, terminal SSE replay, spreadsheet rejection while editing invalid JSON, expired previews, Composio mock document review including its actual trusted account ID, handoff Done, frozen verification/recovery fixtures and a 390px viewport. Account/deprecation screenshots were reviewed; local actions omit absent account IDs and no vault references are displayed.
- [x] `pnpm --filter @htn/api check:mcp-connections` — MCP discovery/classification/execution/disable gates passed after cancellation and untrusted error-message hardening. The broker records safe failure metadata rather than provider errors that could echo private content.

The frontend harness is saved at `apps/web/tests/actions.browser.mjs`. It requires a running mock API and web app. It uses intercepted fixtures for credential-form interactions and unavailable live viewer phases; these are explicit UI protocol checks. Native document/spreadsheet and mock Composio/handoff flows use actual API run/approval endpoints. Generated evidence lives in `.data/qa/action-workspace/verification.json` and desktop/mobile PNGs; `.data` is ignored and is not a persisted production credential/artifact store.

- [x] `pnpm check:authoring-mock` — registry-only chat authoring and execution passed for invoice, document/report and generic research prompts against both an existing mock API and an isolated loopback mock API. Each mutation received its own approval; a separate authored local document draft passed its preview/approval path. Preferred browser prefix rewrites passed for Browserbase, Browserless and localbrowser. This regression is included in `check:all`; it refuses to use an API reporting live providers.

Composio account binding now also contributes to AgentOS descriptor metadata versions and executor references. The native provider tool version remains unchanged for execution. An account refresh invalidates older grants/reviews instead of silently redirecting the proposed action; replaced executor references are removed. The UI displays the actual trusted connected-account ID when present, never a vault key reference or inferred account name.

## Credentials, search and live Composio evidence

User model/Jev/search credentials live in a process-memory vault with trusted principal/run references. The UI never redisplays saved secrets. Removing or rotating a key blocks later inference/dispatch and closes its cloud browser sessions. Models and browser funding have separate settings: `CREDENTIAL_SOURCE=user` and `BROWSER_CREDENTIAL_SOURCE=operator` preserve the requested demo browser account while requiring user model keys. Model BYOK does not pay for browser time, search, Composio project access or OAuth-connected accounts.

- [x] Credential checks passed two-principal/run/source isolation, retry-time removal/rotation, direct Anthropic and Gemini dispatch, trusted grants, pause/resume and local cookie/Origin control. SDK hidden retries are disabled where they would bypass per-dispatch checks. These are controlled protocol tests; no live billable generative completion is claimed.
- [x] Browser search and Tavily protocol tests passed bounded results, public-only query labels, scoped keys, simulated results and search/read lifecycle. Live Tavily service verification was not performed because its credential was absent.
- [x] At **2026-10-05T18:08:45.378Z**, Composio Platform live `GMAIL_GET_PROFILE` executed once through the production ToolBroker/DecisionService with a dynamically discovered trusted schema/version, connected account/scopes, an active exposure grant and exact authorization. The returned schema's `user_id: 'me'` default was used. Private labels selected deterministic local policy. The check retained only five metadata fields as a count and execution log ID `log_mYZ5dCf5IfQE`; no message body, send, document edit or call was performed.

The manual `pnpm check:composio-readonly` script discovers a connected read tool and uses its actual schema/defaults. It refuses to claim a pass without an execution log ID. It is excluded from offline CI and can contact the configured project when explicitly run.

Live cloud Office mutations currently use exact proposals and provider-reported receipts from discovered supported tools. Only the native local artifact executors have an independently verified before/after implementation in this delivery. A provider-specific Office readback adapter, conditional write support and connected account are required before labeling an Office edit readback-verified. Phone-call audio/video, live Office screens and rendered Office files are not implied by generic tool activity.
