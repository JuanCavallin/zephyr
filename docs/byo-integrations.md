# Bring-your-own integrations — design spec

Status: approved design, 2026-11-05. Branch `feat/byo-integrations`.
Scope: let the user connect their own **model keys, app connectors, MCP servers, ACP
harnesses and GitHub account**, managed from one **Integrations** tab. Deployment model:
**local, single user** (Zephyr on the user's machine, loopback + local-control cookie, no
login). Out of scope: multi-user hosting, and everything in `docs/orchestration-plan.md`
(runner tiers, local connector, subscription policy) — that is built in a separate repo.

## 1. What exists today (and is kept)

| Area        | Today                                                                                                 | Gap this spec closes                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Model keys  | `services/credentials.ts` `CredentialStore`, `/api/credentials*`, `CredentialsPanel` — pinned per run | In-memory only, unencrypted, fixed 6-provider list                      |
| MCP servers | `core/mcp/connections.ts`, `/api/mcp-connections*`, SQLite `mcp_connections`, ToolBroker-authorized   | HTTP only; secrets only as env-var names; no effect override; no import |
| Connectors  | Composio `connectUrl` / `refresh`, `ComposioCard`                                                     | No app picker, no per-account list/disconnect, manual refresh           |
| Harnesses   | Generic `providers/_acp/client.ts` + `AcpHarnessConfig`; Hermes and Claude Code adapters              | Fixed `HarnessId`/`ProviderId` enums; runs always bind Hermes; no UI    |
| GitHub      | none (`git` provider does local worktrees; `publish.service.ts`)                                      | Everything                                                              |
| UI          | `/connections` — stacked sections                                                                     | No information architecture, no harness section                         |

Existing routes stay backward compatible: `docs/frontend-handoff.md` consumers keep working.

## 2. Architecture

Shared encrypted vault + per-kind services + one aggregating read model (approach A).

```
            ┌──────────── /integrations (web) ────────────┐
            │ rail · list · detail   (GET /api/integrations)│
            └──────────────────────┬───────────────────────┘
   ┌──────────────┬────────────────┼───────────────┬────────────────┐
CredentialStore  McpConnectionMgr  HarnessRegistry  ComposioService  GitHubService
   └──────────────┴──────── SecretVault (AES-256-GCM, store-backed) ─┴────────────────┘
                     every agent-callable tool → ToolBroker → authorize_action
```

### 2.1 SecretVault — `apps/api/src/services/vault.ts`

- AES-256-GCM via `node:crypto`; 12-byte random IV per write; auth tag stored.
- Key: `ZEPHYR_VAULT_KEY` (base64, 32 bytes) if set, else generated once into
  `.data/vault.key` with owner-only permissions. A missing/corrupt key file with existing
  ciphertext is a **hard error for that secret** (status `error: vault key changed`), never a
  silent reset.
- Table `secrets { ref TEXT PK, kind TEXT, ciphertext BLOB, iv BLOB, tag BLOB, version INT,
created_at, updated_at }`. Follows the existing store choice: SQLite when
  `PERSIST_TO_DISK`, memory otherwise — a keyless, non-persisted clone still boots.
- API: `put(ref, kind, plaintext) → {ref, version}`, `get(ref) → plaintext`, `remove(ref)`,
  `describe(ref) → {configured, last4, updatedAt, version}`. Only `describe` output ever
  leaves the server. Plaintext is never logged or written to traces/events.
- Secret refs are strings `vault:<kind>/<id>`. Anywhere a config accepts a secret it accepts
  `{ secretRef }` or `{ envVar }` (existing behaviour) — never an inline value at rest.

### 2.2 Model keys — `CredentialStore` (extended)

- Map becomes a read-through cache over the vault; per-run pinning/versioning unchanged.
- Provider list adds `openai`, `composio`, `gptzero`, and
  **custom OpenAI-compatible endpoints** `{id, name, baseUrl, secretRef?, models[]}` (base URL
  may be `http://host:port`, e.g. LAN Ollama/vLLM).
- `POST /api/credentials/:providerId/verify` — one cheap live call (model list / whoami);
  returns the real result. No mock fallback.
- `POST /api/credentials/import/env` — body `{ text }` (the client reads the file locally);
  returns matches `[{providerId, envVar, last4}]` for **preview only**. A second call
  `POST /api/credentials/import/env/commit { text, providerIds[] }` stores the selected ones.
  Unrecognised lines are ignored and counted, never echoed back.

### 2.3 MCP servers — `McpConnectionManager` (extended)

- Contract (`packages/shared/src/mcp.ts`) gains `transport: 'streamable_http' | 'stdio'`.
  - `stdio`: `{ command, args[], cwd?, env: Record<string, {secretRef}|{envVar}|{value}> }`
    (`value` only for non-secret strings). Spawned with no shell, scrubbed env via
    `buildHarnessEnv`, process-tree kill on disable/remove/shutdown.
  - `streamable_http`: existing `headerEnv` kept; new `headerSecrets: Record<header, secretRef>`.
- Per-tool effect override `PATCH /api/mcp-connections/:id/tools/:toolName { effect }`,
  persisted; an override can only be set by the local user, never by a model.
- Import: `POST /api/mcp-connections/import/scan` auto-discovers known config files
  (Claude Desktop `claude_desktop_config.json`, Claude Code `.mcp.json` + `~/.claude.json`,
  Cursor `.cursor/mcp.json`, VS Code `mcp.json`) and `POST .../import/parse { text, format? }`
  parses an uploaded/pasted file. Both return a **preview** `[{name, transport, command|url,
envVars[], conflict?}]`; `POST .../import/commit { items[] }` creates them. Literal secret
  values found in a file go to the vault on commit and are masked in the preview.
- All imported tools keep existing safety: verb classification, untrusted description
  replacement, unknown verbs unavailable, ToolBroker authorization.

### 2.4 Harnesses — `HarnessRegistry` (new) — `apps/api/src/services/harnesses/`

- `HarnessDefinition { id, name, preset?: PresetId, transport: Stdio | Network, auth?, env,
toolMap?, pinnedVersion? }`
  - `Stdio { kind: 'stdio', command, args[] }`
  - `Network { kind: 'network', url }` — `tcp://host:port`, `ws://` or `wss://`. Non-loopback
    hosts require `wss://` or a bearer `secretRef`; plaintext to a remote host is allowed
    only with an explicit `allowInsecure: true` and shows amber in the UI.
- Presets (`presets.ts`): Claude Code (`claude-agent-acp`), Codex (`codex-acp`), Gemini CLI
  (`gemini --experimental-acp`), goose (`goose acp`), Hermes (`uv run hermes-acp`). Each
  preset's exact command and flags are pinned in `presets.ts` and verified by a live check
  script before the preset ships as "supported"; unverified presets show "experimental".
- `detect()` — PATH lookup per preset (no execution). `test(id)` — start, ACP `initialize`,
  record `{protocolVersion, agentInfo, capabilities}`, stop; 10 s limit, process-tree kill.
- `AcpClient` gains a stream-transport seam: today it owns a child process' stdio; the
  network transport supplies the same readable/writable ndjson streams from a socket.
  Cancel/idle/terminal-state semantics are unchanged.
- `HarnessId` (`packages/shared/src/coding.ts`) becomes a validated `string` (registry
  membership checked at the API boundary). `ProviderId` stays an enum; harnesses are not
  providers.
- **Selection:** `settings.defaultHarness` (persisted), overridable per graph `agent_task`
  node (`harness?: string`) and per board `Assignee.harness`. The orchestrator resolves the
  run's harness from the registry instead of `BINDINGS['agent.runtime'] = 'hermes'`; unset
  → Hermes (current behaviour).
- Permission bridge unchanged. Native tools are mapped by `nativeDescriptors.ts` plus an
  optional per-definition `toolMap`; **unmapped native tools are denied**. Test reports the
  harness' advertised-but-unmapped tools as "will be denied".
- Import/export: `GET /api/harnesses/:id/export` (secret refs stripped) and
  `POST /api/harnesses/import { json }` → preview → commit, same pattern as MCP.

Routes: `GET /api/harnesses`, `POST /api/harnesses`, `PATCH/DELETE /api/harnesses/:id`,
`POST /api/harnesses/detect`, `POST /api/harnesses/:id/test`, `PUT /api/settings/default-harness`.

### 2.5 GitHub — `GitHubService` (new) — `apps/api/src/services/github/`

- **Token source, in order:** (1) `gh auth token` read at call time, never stored;
  (2) Zephyr OAuth token in the vault. Status reports which.
- **OAuth popup (web flow):** requires `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET`
  in `.env`; absent → the "Sign in with GitHub" button is hidden (keyless clone still boots).
  - `POST /api/integrations/github/oauth/start` → `{authorizeUrl}` with a single-use `state`
    (+ PKCE verifier) bound to the local-control session, 10-minute expiry.
  - Browser `window.open(authorizeUrl)` → GitHub consent screen → redirect to
    `http://127.0.0.1:<PORT>/api/integrations/github/callback?code&state`.
  - Callback: accept loopback only, verify `state`, exchange code, store token in the vault,
    render a tiny page that `postMessage`s `{type:'github-connected'}` to `WEB_ORIGIN` and
    closes. Popup blocked/closed early → UI offers retry.
  - Scopes: `repo`, `read:user` (`read:org` optional).
- **Features** (each toggled independently in the GitHub detail pane):
  1. **Publish runs as PRs** — after a coding run, `git.publish` (already bound to
     branch + diff hash and approval-gated) pushes the branch and opens a PR via REST.
  2. **Repos for runs** — repo picker (`GET /api/integrations/github/repos`), selected repos
     cloned into `.data/repos/<owner>/<repo>`; runs/boards may target them instead of
     `GIT_REPO_ROOT`.
  3. **Agent tools** — registers GitHub's official MCP server as an MCP connection whose
     `Authorization` header is the vault ref; tools flow through ToolBroker like any MCP.
  4. **Issues ↔ board sync** — selected repos' open issues import as board tasks (linked by
     `issue.html_url`); task state changes post back (comment + close on done, link PR).
     Pull is manual + on-demand refresh; no webhooks (local single user).
- Disconnect removes the vault token (gh CLI login is left untouched and labelled as such).

### 2.6 Connectors — Composio (extended)

- `GET /api/providers/composio/toolkits` — app picker source.
- `GET /api/providers/composio/accounts`, `DELETE .../accounts/:id` — per-account list/disconnect.
- Connect opens the redirect URL in a popup; the UI polls `accounts` every 2 s for 2 min
  until the account is `ACTIVE` (no manual refresh).
- Composio API key moves to the vault (`CredentialStore` provider `composio`), env still
  honoured. Single `COMPOSIO_USER_ID` remains (single-user deployment).

### 2.7 Aggregation — `IntegrationsService`

`GET /api/integrations` → `{ summary: {connected, needsAttention, available},
items: IntegrationItem[] }` where `IntegrationItem = { kind: 'key'|'harness'|'mcp'|'connector'
|'github', id, name, status: 'connected'|'needs_attention'|'available'|'error'|'disabled',
detail: string, reason?: string, fix?: string, updatedAt? }`. Read-only, composed from the
per-kind services; it owns no state.

## 3. Frontend — the Integrations tab

Route `/integrations[/:kind[/:id]]`; `/connections` redirects. Nav item "Connections" →
**Integrations**. The sidebar "Harness connection" button deep-links to
`/integrations/harnesses`. Follows `apps/web/DESIGN.md` strictly.

### 3.1 Layout — rail + list + detail

```
Integrations                                  3 connected · 1 needs you
┌──────────────┬─────────────────────────┬──────────────────────────┐
│ Model keys 2 │ ● Claude Code   default │ Claude Code              │
│▌Harnesses 2  │▌● Codex         v0.4    │ ● Connected              │
│ MCP servers 3│ ▲ Gemini CLI needs auth │ binary   claude-agent-acp│
│ Connectors 1 │ ┊ goose     not on PATH │ ACP      v0.99.1         │
│ GitHub     ● │ ┊ Hermes    not set up  │ auth     subscription    │
│              │ + Custom   ⇪ Import     │ last test  12s ago       │
│              │                         │ [Test]  [Make default]   │
└──────────────┴─────────────────────────┴──────────────────────────┘
```

- **Rail** (`rail` surface): five categories with live counts; selected category uses the
  `nav-current` treatment.
- **List** (`panel`): one row per item; the selected row is **the one accent element** on
  screen. Status glyphs: connected = `edge-done` dot; needs you = `amber` triangle; error =
  `danger`; available/not set up = **dashed** row (`node-planned-*`), since dashed means
  "planned, not real yet". Header holds `+ Add` and `Import`.
- **Detail** (`raised-panel`): title + status chip, 2-column facts table (unknowns render
  `—`), actions; the primary action is the only accent button in the pane, Remove is a
  `danger` secondary with inline confirm (no `window.confirm`).
- **Header summary** `3 connected · 1 needs you`; "needs you" jumps to the first amber item.
- No shadows, no colour literals (theme test), single typeface, existing semantic classes
  (`surface-section`, `status-chip--*`, `primary-button`, `field`, …) reused; new classes go
  in a new `integrations.css` imported from `index.css`.
- Narrow viewports: rail becomes a segmented control above the list; detail becomes a
  full-width sheet with a back button.

### 3.2 Per-category detail

- **Model keys** — password field, `…last4 · updated 2d ago`, **Verify**, "Used by" list;
  `+ Custom endpoint` (name, base URL incl. host:port, key, models). Import: `.env` preview
  with masked values and per-row checkboxes.
- **Harnesses** — detected presets solid, undetected dashed with install hint; detail shows
  binary/URL, ACP version, auth, last handshake, capabilities, **Test**, **Make default**.
  Add custom: name, transport toggle `Local command | Network (host:port)`, command+args or
  URL, env rows (value / vault secret / env var), bearer secret for network. After Test,
  advertised-but-unmapped tools listed as "will be denied". Import/Export JSON.
- **MCP servers** — add form with transport toggle `HTTP | Local command (stdio)`; header/env
  rows accept a pasted secret (→ vault) or env-var name. Detail: tool list with classified
  effect + override select, Refresh / Enable / Remove. Import: auto-detected config files
  ("Found 4 servers in Claude Desktop config") plus file picker/drag-drop/paste, then a
  review list with checkboxes and conflict flags.
- **Connectors** — toolkit picker → Connect (popup, auto-poll) → per-app accounts with
  Disconnect.
- **GitHub** — not connected: card with **Use gh CLI login** (when detected) and **Sign in
  with GitHub** (when OAuth configured). Connected: avatar,
  login, token source, scopes, and four feature toggles (Publish PRs · Repos for runs ·
  Agent tools · Issues sync), each expanding its own settings (repo pickers).

### 3.3 Import review (shared component)

`ImportReview` takes a parsed preview list and renders checkbox rows with name, kind,
transport, masked secrets and a conflict badge (`replace` / `skip`). Nothing is stored until
**Import N items**. Used by MCP, harness and `.env` imports.

## 4. Errors, safety, invariants

- Each item has exactly one truthful status with `reason` + `fix` for `needs_attention`
  (e.g. "token expired — sign in again", "binary not on PATH — `npm i -g …`").
- Verify/Test report real failures; **a failed live request never becomes a mock**.
- Harness Test and stdio MCP start: 10 s timeout, process-tree kill, stderr tail (secrets
  redacted) surfaced in the detail pane.
- Imports are atomic per committed batch; a failure stores nothing and reports which item.
- Plaintext secrets never reach the browser, logs, traces or run events.
- Creating stdio MCP servers / custom harnesses (arbitrary local commands) requires the
  local-control cookie; no shell; scrubbed env.
- Every agent-callable tool (GitHub MCP, stdio MCP, harness native tools) goes through
  `ToolBroker → authorize_action`; Jev or a harness picking an action never implies it is
  authorized.
- OAuth: single-use `state` + PKCE, loopback-only callback, `postMessage` targeted at
  `WEB_ORIGIN` only.
- Keyless clone boots and runs the full demo (`config.ts` invariant).

## 5. Testing

- **Unit:** vault round-trip, tamper (bad tag) and wrong-key detection; `.env` matcher;
  parsers for each MCP config format; harness preset → `AcpHarnessConfig` resolution;
  network-URL policy (loopback / wss / insecure flag); IntegrationsService status mapping.
- **API integration (memory store):** credentials verify/import, MCP stdio against a fixture
  server, MCP import scan/parse/commit, harness Test against `mockharness` launched as an
  ACP process (stdio and TCP), GitHub OAuth start/callback with a stubbed token endpoint.
- **Web (Playwright):** rail navigation + deep links, add MCP server, import review, harness
  Test result, GitHub popup with mocked callback `postMessage`, narrow-viewport sheet.
- **Live checks** (`apps/api/scripts/*.check.ts`, manual): GitHub OAuth round-trip, one per
  ACP preset before it is marked supported.
- Existing suites (typecheck, lint, theme test, api + web tests) stay green.

## 6. Phases (one implementation plan each, mergeable independently)

| Phase  | Delivers                                                                                                                                                                                              | Acceptance                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **P0** | Vault; vault-backed `CredentialStore` + new providers + custom endpoints + verify + `.env` import; `/api/integrations`; Integrations tab shell (rail/list/detail, Model keys category, redirect, nav) | Keys survive restart when persisted; no plaintext in any response; theme test passes                   |
| **P1** | MCP stdio transport, `headerSecrets`, effect override, config-file import; MCP category UI                                                                                                            | Claude Desktop config imports; stdio fixture tools appear and are broker-authorized                    |
| **P2** | HarnessRegistry, presets, detect/test, network transport, default + per-node/assignee selection, import/export; Harnesses category UI                                                                 | A graph run executes on a non-Hermes harness; unmapped native tool denied; TCP mockharness passes Test |
| **P3** | GitHubService: gh CLI + OAuth popup, repos, publish PRs, GitHub MCP agent tools; GitHub category UI                                                                                                   | Popup flow connects; a run publishes a PR after approval; GitHub tools broker-authorized               |
| **P4** | Issues ↔ board sync                                                                                                                                                                                   | Issues import as tasks; done task comments + closes issue                                              |
| **P5** | Composio toolkit picker, per-account list/disconnect, auto-poll; Connectors category UI                                                                                                               | Connect completes without manual refresh; disconnect removes account                                   |

`docs/frontend-handoff.md` is updated in each phase with the routes it adds.
