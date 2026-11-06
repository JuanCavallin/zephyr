# BYO Integrations — P0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypted secret vault, model keys that survive restart, `.env` import, key verify, an aggregating `/api/integrations`, and the Integrations tab (rail + list + detail) replacing `/connections`.

**Architecture:** `SecretVault` (AES-256-GCM over a new `secrets` store table) backs the existing `CredentialStore` through an optional persistence port; per-run pinning is untouched. A read-only `IntegrationsService` composes status from existing services. The web tab is a new page whose categories reuse the existing Connections sections until later phases replace them.

**Tech Stack:** TypeScript, Express 5, `node:crypto`, `node:sqlite`, zod, React 19 + React Router 7, plain CSS on workspace tokens. Tests: `tsx` assert check scripts (api), `node --test` (web).

**Spec:** `docs/byo-integrations.md` (§2.1, §2.2, §2.7, §3, §4, §6 P0).

## Global Constraints

- A fresh clone with no `.env`, no keys and `PERSIST_TO_DISK` unset boots and runs the demo; vault then uses an ephemeral in-memory key and writes no files.
- Plaintext secrets never appear in any HTTP response, log line, trace or run event. Responses expose only `{configured, last4, version, updatedAt, error?}`.
- Vault key: `ZEPHYR_VAULT_KEY` (base64, exactly 32 bytes) else `.data/vault.key` (created once, mode `0o600`, next to the SQLite file) when persisted.
- A ciphertext that fails to decrypt is reported per secret as `error: 'Vault key changed; re-enter this key.'` — never silently dropped or reset.
- No colour literals outside the theme blocks; no shadows; the accent marks only the selected list row and the pane's primary action; unknown values render `—`; brand is "Zephyr".
- Mutating routes stay behind `requireLocalControl`.
- **Deviation from spec §2.2 (recorded):** `openai`, `composio`, `gptzero` keys and custom OpenAI-compatible endpoints are deferred — no route consumes them yet (composio moves to P5; openai/custom endpoints become their own task wiring a model route). P0 persists the six existing providers.
- **Rail in P0:** Model keys · Harnesses (read-only status) · MCP servers · Connectors · System. GitHub joins in P3.

## Review Focus

- Pasting a `.env` with CRLF line endings, `export ` prefixes, quoted values and comments → matched correctly, CRLF never leaks into the stored secret. (Task 3 test.)
- Restart after the vault key file is deleted → affected keys show the vault error, the API still boots, re-entering the key repairs it. (Task 2 test.)
- Saving a key while a run is pinned to the old one → the run still fails closed with "start a new run" (existing behaviour must survive the async save path). (Task 2 test.)
- Verify against an unreachable host or 401 → a real failure message, no secret in the error text. (Task 3 test.)
- Deep link `/connections` or `/integrations/mcp` opened cold → lands on the right category. (Task 5 test.)

---

### Task 1: SecretVault + `secrets` store table

**Files:**

- Create: `apps/api/src/services/vault.ts`
- Modify: `apps/api/src/store/types.ts` (Store interface), `apps/api/src/store/sqlite.ts` (table + methods), `apps/api/src/store/memory.ts` (Map, not snapshotted)
- Modify: `apps/api/src/config.ts` (`ZEPHYR_VAULT_KEY: optionalString`; export `config.vault = { key, keyPath, persist }`)
- Test: `apps/api/scripts/vault.check.ts`; add `check:vault` to `apps/api/package.json` and root `check:all`

**Interfaces — Produces:**

```ts
// store/types.ts
export interface StoredSecret { ref: string; kind: string; ciphertext: string; iv: string; tag: string;
  version: number; metadata?: Record<string, string>; createdAt: string; updatedAt: string } // base64 fields
putSecret(secret: StoredSecret): Promise<void>; listSecrets(kind?: string): Promise<StoredSecret[]>;
deleteSecret(ref: string): Promise<boolean>;
// services/vault.ts
export class VaultDecryptError extends Error { readonly code = 'VAULT_DECRYPT' }
export function loadVaultKey(o: { envKey?: string; keyPath: string; persist: boolean }): Promise<Buffer>;
export interface SecretEntry { ref: string; version: number; metadata?: Record<string,string>; updatedAt: string;
  plaintext?: string; error?: string }
export class SecretVault {
  constructor(store: Pick<Store,'putSecret'|'listSecrets'|'deleteSecret'>, key: Buffer | Promise<Buffer>);
  put(ref: string, kind: string, plaintext: string, metadata?: Record<string,string>): Promise<{ ref: string; version: number; updatedAt: string }>;
  entries(kind: string): Promise<SecretEntry[]>;   // decrypt failures -> entry.error, never throw
  remove(ref: string): Promise<boolean>;
}
export const vault: SecretVault; // singleton from config + store
```

- [ ] **Step 1: Write failing `vault.check.ts`** — with `createMemoryStore()`:
  - round trip: `put('vault:credential/u/anthropic','credential','sk-1',{projectId:'p'})` then `entries('credential')` → `[{plaintext:'sk-1', version:1, metadata:{projectId:'p'}}]`; second put → `version: 2`.
  - stored row never contains `'sk-1'` (`JSON.stringify(await store.listSecrets())`).
  - tamper: flip one base64 char of `tag` via `putSecret` → entry has `error` matching `/Vault key changed/`, no `plaintext`.
  - wrong key: new `SecretVault(store, randomBytes(32))` → same error.
  - `loadVaultKey({envKey: base64(31 bytes)})` rejects `/32 bytes/`; `persist:false` returns 32 random bytes and creates no file; `persist:true` with a temp path creates the file once and returns the same key on the second call.
  - sqlite: same round trip with `createSqliteStore(tmpfile)`.
- [ ] **Step 2: Run** `pnpm --filter @htn/api check:vault` → FAIL (module missing).
- [ ] **Step 3: Implement.** AES-256-GCM, 12-byte `randomBytes` IV per write, `ref` as AAD; key file written with `{ flag: 'wx', mode: 0o600 }` (race: on `EEXIST` read it). SQLite table `secrets(ref TEXT PRIMARY KEY, kind TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL)`. Singleton key path: `resolve(dirname(resolve(process.cwd(), config.sqlitePath)), 'vault.key')`; `persist = config.persistToDisk`.
- [ ] **Step 4: Run** `pnpm --filter @htn/api check:vault && pnpm --filter @htn/api check:sqlite-store && pnpm --filter @htn/api typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(vault): AES-GCM secret vault over a secrets store table`.

### Task 2: Persist user credentials through the vault

**Files:**

- Modify: `apps/api/src/services/credentials.ts`, `apps/api/src/api/credentials.routes.ts`, `apps/api/src/index.ts` (boot `await credentials.hydrate()` after `store.hydrate()`)
- Test: extend `apps/api/scripts/credentials.check.ts`

**Interfaces:**

- Consumes: `SecretVault.put/entries/remove` (Task 1).
- Produces:

```ts
export interface CredentialPersistence {
  load(): Promise<Array<{ principalId: string; providerId: CredentialProvider; version: number;
    secret?: string; metadata?: { projectId?: string }; updatedAt: string; error?: string }>>;
  save(principalId: string, providerId: CredentialProvider, secret: string, metadata?: { projectId?: string }): Promise<{ version: number; updatedAt: string }>;
  delete(principalId: string, providerId: CredentialProvider): Promise<void>;
}
export function vaultCredentialPersistence(v: SecretVault): CredentialPersistence; // ref = `vault:credential/${principal}/${provider}`
// CredentialStoreOptions gains persistence?: CredentialPersistence
// CredentialStore gains: hydrate(): Promise<void>; save(...same as put): Promise<CredentialStatus>; delete(principalId, providerId): Promise<CredentialStatus>;
//   readonly persisted: boolean
// CredentialStatus gains: last4?: string; updatedAt?: string; error?: string
```

- [ ] **Step 1: Extend `credentials.check.ts`:** a store with `persistence: vaultCredentialPersistence(new SecretVault(mem, key))`:
  - `await s.save('local-user','anthropic','sk-abcd1234')`; a **new** `CredentialStore` over the same vault + `await hydrate()` → `require({runId:'r', providerId:'anthropic', purpose:'model'})` returns `'sk-abcd1234'`; status `last4 === '1234'`, `configured: true`.
  - pinned run: resolve once, `await save(...'sk-new')`, resolve same run → rejects `/start a new run/`.
  - broken entry (vault with a different key, hydrate) → status `{configured:false, error: /Vault key changed/}`, `available()` false; `save` repairs it.
  - `delete` → new store after hydrate has `configured:false`.
  - `JSON.stringify(statuses())` contains neither `sk-` value.
- [ ] **Step 2: Run** `pnpm --filter @htn/api check:credentials` → FAIL.
- [ ] **Step 3: Implement.** `save`/`delete` persist first, then update the in-memory map and fire invalidation exactly like `put`/`remove` (reuse; the sync methods stay for memory-only callers). Version comes from the vault. Routes `PUT`/`DELETE` call `await credentials.save/delete`; a persistence failure returns 500 `CREDENTIAL_NOT_PERSISTED` and leaves memory unchanged. `GET /credentials` reports `lifetime: credentials.persisted ? 'persisted' : 'process'`. Singleton passes `vaultCredentialPersistence(vault)`.
- [ ] **Step 4: Run** `pnpm --filter @htn/api check:credentials && pnpm --filter @htn/api typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(credentials): persist user keys through the vault`.

### Task 3: `.env` import + verify routes

**Files:**

- Create: `apps/api/src/services/credentialImport.ts`, `apps/api/src/services/credentialVerify.ts`
- Modify: `apps/api/src/api/credentials.routes.ts`
- Test: `apps/api/scripts/integrations.check.ts` (new; `check:integrations` in both package.json files)

**Interfaces — Produces:**

```ts
export const ENV_CREDENTIALS: Record<string, CredentialProvider> = { ANTHROPIC_API_KEY:'anthropic',
  GEMINI_API_KEY:'gemini', AI_GATEWAY_API_KEY:'jev', JEV_API_KEY:'jev', BROWSERBASE_API_KEY:'browserbase',
  BROWSERLESS_API_KEY:'browserless', TAVILY_API_KEY:'tavily' };  // BROWSERBASE_PROJECT_ID -> metadata.projectId
export function parseEnvCredentials(text: string): { matches: Array<{ providerId: CredentialProvider; envVar: string;
  secret: string; metadata?: { projectId?: string } }>; ignored: number };  // AI_GATEWAY wins over JEV
export type VerifyResult = { ok: true; detail: string } | { ok: false; detail: string } | { ok: null; detail: string };
export function verifyCredential(providerId: CredentialProvider, secret: string, o?: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): Promise<VerifyResult>;
```

Routes (all behind local control): `POST /credentials/import/env {text ≤ 64 KiB}` → `{matches:[{providerId, envVar, last4, replaces:boolean}], ignored}`; `POST /credentials/import/env/commit {text, providerIds[]}` → `{providers: CredentialStatus[]}` (atomic: validate all, then save sequentially; on failure delete the ones saved in this batch and return 500); `POST /credentials/:providerId/verify` → `VerifyResult` (uses the principal's resolved key; `400 CREDENTIAL_MISSING` if none).

Verify endpoints: anthropic `GET {anthropic.baseUrl}/models` with `x-api-key` + `anthropic-version: 2023-06-01`; gemini `GET {gemini.baseUrl}/models` with `x-goog-api-key`; browserbase `GET https://api.browserbase.com/v1/projects` with `X-BB-API-Key`; others `{ok:null, detail:'No verification endpoint; checked on first use.'}`. 8 s timeout via `AbortSignal.timeout`. 2xx → ok; 401/403 → `'Key rejected (401).'`; other → `'Provider returned 5xx.'`; network → `'Could not reach <host>.'`. Never include the secret or response body.

- [ ] **Step 1: Write failing `integrations.check.ts`:**
  - `parseEnvCredentials('export ANTHROPIC_API_KEY="sk-a"\r\n# c\nJEV_API_KEY=j1\nAI_GATEWAY_API_KEY=\'g1\'\nBROWSERBASE_API_KEY=bb\nBROWSERBASE_PROJECT_ID=proj\nOTHER=x\n')` → anthropic `sk-a` (no `\r`), jev `g1` via `AI_GATEWAY_API_KEY`, browserbase metadata `{projectId:'proj'}`, `ignored === 1`; blank values skipped.
  - `verifyCredential('anthropic','sk', {fetch: stub200})` → `ok:true`; stub401 → `ok:false`, detail `/rejected/`, not containing `sk`; throwing fetch → `/Could not reach/`; `'tavily'` → `ok:null`.
  - Routes via `express()` + `credentialsRouter` with a test store (follow the existing pattern in `credentials.check.ts`): preview response has `last4` and no secret substring; commit with `['anthropic']` only stores anthropic.
- [ ] **Step 2: Run** `pnpm --filter @htn/api check:integrations` → FAIL.
- [ ] **Step 3: Implement** both modules and routes.
- [ ] **Step 4: Run** `check:integrations`, `check:credentials`, `typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(credentials): .env import preview/commit and key verify`.

### Task 4: `IntegrationsService` + `GET /api/integrations`

**Files:**

- Create: `packages/shared/src/integrations.ts` (export from `index.ts`), `apps/api/src/services/integrations.service.ts`, `apps/api/src/api/integrations.routes.ts` (mount in `api/index.ts` after the local-control middleware)
- Test: extend `apps/api/scripts/integrations.check.ts`

**Interfaces — Produces:**

```ts
export type IntegrationKind = 'key' | 'harness' | 'mcp' | 'connector';
export type IntegrationStatus = 'connected' | 'needs_attention' | 'available' | 'error' | 'disabled';
export interface IntegrationItem { kind: IntegrationKind; id: string; name: string; status: IntegrationStatus;
  detail: string; reason?: string; fix?: string; updatedAt?: string }
export interface IntegrationsSummary { connected: number; needsAttention: number; available: number }
export interface IntegrationsResponse { summary: IntegrationsSummary; items: IntegrationItem[] }
// api
export function buildIntegrations(input: { credentials: CredentialStatus[]; mcp: McpConnection[];
  providers: ProviderStatus[] }): IntegrationsResponse;  // pure
```

Mapping: key configured → `connected` (detail `…last4 · operator|your key`); key `error` → `error` with reason; unconfigured → `available`. MCP `connected/error/disabled` → same, detail `N tools`. Harness = providers `hermes`, `claudecode`: live+healthy → `connected`, live+unhealthy → `needs_attention` (reason = health detail, fix = `Check <keyVar>`), mock → `available` (detail `mock`). Connector = provider `composio` same rule. `needsAttention` counts `needs_attention` + `error`.

- [ ] **Step 1:** tests for `buildIntegrations` covering each mapping row and the summary counts; route returns 200 with `summary` + `items`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement (route gathers inputs from `credentials.statuses`, `store.listMcpConnections()`, `providers.statuses()`). **Step 4:** `check:integrations`, `check:contracts`, `typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(integrations): aggregate status read model`.

### Task 5: Integrations tab (shell + Model keys + legacy categories)

**Files:**

- Create: `apps/web/src/pages/Integrations.tsx` (route shell: header summary, rail, category switch), `apps/web/src/components/integrations/IntegrationRail.tsx`, `KeysCategory.tsx` (list + detail + verify + remove inline confirm), `ImportReview.tsx` (shared preview/checkbox component), `EnvImportDialog.tsx`, `HarnessesCategory.tsx` (read-only status), `apps/web/src/lib/integrations.ts` (pure helpers), `apps/web/src/integrations.css` (imported from `index.css`)
- Modify: `apps/web/src/pages/Connections.tsx` (export `ProvidersSection`, `BrowserBackendsSection`, `ComposioCard`, `McpCard`, `ToolInventorySection`, `SupervisionExamples` usage, `useAsync`; drop the `Connections` page export), `apps/web/src/App.tsx` (`/integrations/:kind?/:id?`; `/connections` → `<Navigate to="/integrations" replace />`), `apps/web/src/components/layout/Nav.tsx` (label "Integrations", `to="/integrations"`), `apps/web/src/lib/api.ts` (`integrations()`, `verifyCredential`, `previewEnvImport`, `commitEnvImport`; extend `CredentialStatus` with `last4?`, `updatedAt?`, `error?`), delete `components/connections/CredentialsPanel.tsx` once `KeysCategory` replaces it
- Test: `apps/web/tests/integrations.test.mjs`; extend `apps/web/tests/theme.test.mjs` so the colour-literal rule also scans `src/integrations.css`

**Interfaces — Produces (`lib/integrations.ts`):**

```ts
export const CATEGORIES: ReadonlyArray<{ id: 'keys'|'harnesses'|'mcp'|'connectors'|'system'; label: string; kind?: IntegrationKind }>;
export function categoryFromParam(kind: string | undefined): CategoryId;            // unknown/undefined -> 'keys'
export function countsByCategory(items: IntegrationItem[]): Record<CategoryId, number>; // connected only
export function summaryLine(s: IntegrationsSummary): string;  // '3 connected · 1 needs you' ; needs part omitted at 0
export function statusGlyph(status: IntegrationStatus): 'done' | 'attention' | 'error' | 'planned' | 'off';
export function relativeTime(iso: string | undefined, now?: number): string;          // undefined -> '—'
```

Layout per spec §3.1: `.integrations` grid `rail | list | detail`; rail on `--rail`, list on `--panel`, detail on `--raised-panel`; 1px `--line-*` borders; selected row uses `--accent` background with `--accent-ink` text (the only accent); status glyphs `--edge-done` / `--amber` / `--danger`; unconfigured rows use `--node-planned-line` dashed border and `--node-planned-text`. Below 900px the rail becomes a horizontal segmented control and the detail stacks under the list. Keys detail: facts table (Status, Source, Key `…last4`, Updated, Used by), password field + Save (primary), Verify (secondary, shows result in `inline-note`/`error-note`), Remove (`danger` secondary, inline "Remove? Yes / Cancel"). List header: "Import .env" opens `EnvImportDialog` (file picker reads with `File.text()` client-side, or paste) → `ImportReview` → commit. Used-by copy: anthropic "Agent text, Claude Code API mode"; gemini "Agent text"; jev "Typed decisions"; browserbase/browserless "Browser sessions"; tavily "Web search". MCP category renders `McpCard`; Connectors renders `ComposioCard`; System renders `ProvidersSection`, `BrowserBackendsSection`, `ToolInventorySection`, `SupervisionExamples`.

- [ ] **Step 1: Write failing `integrations.test.mjs`** for every helper: `categoryFromParam('mcp')==='mcp'`, `('nope')==='keys'`, `(undefined)==='keys'`; `summaryLine({connected:3,needsAttention:1,available:6})==='3 connected · 1 needs you'`, `({connected:0,needsAttention:0,available:2})==='0 connected'`; `countsByCategory` counts only `connected`; `statusGlyph` table; `relativeTime(undefined)==='—'`.
- [ ] **Step 2: Run** `pnpm --filter @htn/web test` → FAIL.
- [ ] **Step 3: Implement** helpers, components, CSS, routing, nav.
- [ ] **Step 4: Run** `pnpm --filter @htn/web test && pnpm --filter @htn/web build && pnpm -r exec tsc --noEmit` → PASS.
- [ ] **Step 5: Browser check** — run api+web, visit `/connections` (redirects), `/integrations/keys`, select a row, open Import, `/integrations/mcp`, narrow viewport 700px; screenshot; no console errors.
- [ ] **Step 6:** update `docs/frontend-handoff.md` with `/api/credentials*` (incl. import/verify) and `/api/integrations`. **Commit** `feat(web): Integrations tab replaces Connections`.
