# RanobeLib OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow production scanners to read RanobeLib titles hidden from anonymous users by securely importing, refreshing, and applying a disposable account's OAuth token bundle.

**Architecture:** Store one AES-GCM-encrypted token bundle in D1, expose it through a focused `RanobeLibAuthProvider`, and inject an environment-aware `RanobeLibClient` into existing discovery/scanner entry points. Keep release detection, silent baseline, subscriptions, delivery, and public fallbacks unchanged.

**Tech Stack:** Cloudflare Workers, TypeScript, D1, Web Crypto AES-GCM, Node test runner, vanilla admin HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-11-ranobelib-oauth-design.md`

## Global Constraints

- Work on the current `main` line only; do not create a branch or PR.
- Never commit or log OAuth tokens or the encryption key.
- Send bearer authorization only to exact origin `https://api.cdnlibs.org` and only for GET reads.
- Preserve anonymous operation when credentials are missing and preserve silent first baseline behavior.
- Add behavior test-first and commit only focused, passing slices.

---

### Task 1: Add the encrypted singleton schema

**Files:**
- Create: `migrations/0027_ranobelib_auth_credentials.sql`
- Modify: `tests/multi-team-migration.test.mjs`

- [ ] Add a RED migration test that reads migration `0027` and asserts a singleton primary key, AES-GCM ciphertext/IV fields, key version, expiry, state constraint, validation/refresh/error timestamps, and no plaintext access/refresh token columns.
- [ ] Run `npm run build:runtime-test && node --test tests/multi-team-migration.test.mjs`; expect failure because migration `0027` does not exist.
- [ ] Add the additive migration:

```sql
CREATE TABLE IF NOT EXISTS ranobelib_auth_credentials (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  access_expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'invalid')),
  last_validated_at TEXT,
  last_refreshed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] Re-run the focused migration test and expect PASS.
- [ ] Commit as `feat: add encrypted RanobeLib credential store`.

### Task 2: Implement token encryption and persistence

**Files:**
- Create: `src/ranobelib-auth.ts`
- Create: `tests/ranobelib-auth.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

- [ ] Add RED tests for strict token-bundle parsing, AES-GCM round-trip, fresh IVs, wrong-key failure, encrypted D1 persistence, health projection without secret fields, and sanitized errors that never contain either token.
- [ ] Run `npm run build:runtime-test && node --test tests/ranobelib-auth.test.mjs`; expect module/test failures.
- [ ] Implement these public contracts:

```ts
export interface RanobeLibAuthEnv {
  DB: D1DatabaseLike;
  RANOBELIB_TOKEN_ENCRYPTION_KEY?: string;
}

export interface RanobeLibTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface RanobeLibAuthHealth {
  state: 'missing' | 'active' | 'expired' | 'invalid' | 'unavailable';
  accessExpiresAt: string | null;
  lastValidatedAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}
```

- [ ] Derive a 256-bit AES key from the configured secret with SHA-256 and domain separation, use a fresh 96-bit IV, AES-GCM additional data `domnkrbot:ranobelib-auth:v1`, base64 encode only ciphertext/IV, and validate ISO expiry before persistence.
- [ ] Add `tests/ranobelib-auth.test.mjs` to the explicit `npm test` list and `src/ranobelib-auth.ts` to `tsconfig.runtime-test.json`.
- [ ] Re-run the focused test and `npm run typecheck`; expect PASS.
- [ ] Commit as `feat: encrypt RanobeLib OAuth credentials`.

### Task 3: Add refresh, validation, allowlisting, and retry semantics

**Files:**
- Modify: `src/ranobelib-auth.ts`
- Modify: `src/integrations/ranobelib/client.ts`
- Modify: `tests/ranobelib-auth.test.mjs`
- Modify: `tests/ranobelib-sync.test.mjs`

- [ ] Add RED auth-provider tests for validation through `GET https://api.cdnlibs.org/api/auth/me`, pre-expiry refresh through `POST /api/auth/oauth/token`, complete rotated-bundle persistence, one refresh for concurrent callers, refresh failure state, and token-free errors.
- [ ] Add RED client tests proving bearer attachment to exact API-origin GETs, no bearer for `ranobelib.me` or lookalike origins, `redirect: 'manual'`, and exactly one refresh/retry after an authenticated 401.
- [ ] Run the two focused tests; expect assertion failures.
- [ ] Implement `RanobeLibAuthProvider.getAccessToken()`, `validateAndStore()`, `refresh()`, `remove()`, and `health()` with an isolate-local in-flight refresh promise and a two-minute refresh skew.
- [ ] Extend `RanobeLibClientOptions` with a narrow provider interface and update `request()` to request authorization only for exact allowlisted API GETs, reject cross-origin redirects, and perform one 401 refresh retry without looping.
- [ ] Re-run focused tests and `npm run typecheck`; expect PASS.
- [ ] Commit as `feat: authorize restricted RanobeLib reads`.

### Task 4: Wire one authenticated client factory into production jobs

**Files:**
- Create: `src/ranobelib-client-factory.ts`
- Modify: `src/ranobelib-multi-team-scanner.ts`
- Modify: `src/ranobelib-multi-team-discovery.ts`
- Modify: `src/ranobelib-fast-scanner.ts`
- Modify: `src/ranobelib-discovery-scheduler.ts`
- Modify: `src/team-admin-notification-preview.ts`
- Modify: `src/telegram-team-admin.ts`
- Modify: `src/live-entry-v2.ts`
- Modify: `tsconfig.runtime-test.json`
- Modify: `tests/ranobelib-scheduled-recovery.test.mjs`
- Modify: `tests/multi-team-delivery.test.mjs`

- [ ] Add RED wiring tests showing production jobs pass `env` to `createRanobeLibClient(env)` while explicit test-injected clients remain authoritative.
- [ ] Add a RED restricted-title scenario: anonymous chapter fetch returns 404, authenticated fetch succeeds, the first scan writes branch baseline with zero releases/outbox rows, and a later team-attributed branch writes exactly one release/outbox entry.
- [ ] Run focused scanner tests; expect failures because production code still constructs anonymous clients.
- [ ] Implement `createRanobeLibClient(env)` returning an anonymous client when no encryption key is configured and an auth-provider client otherwise.
- [ ] Replace only production `new RanobeLibClient()` defaults with the factory; extend job env types with `RanobeLibAuthEnv`; do not alter selection, reconciliation, baseline, release, or delivery SQL.
- [ ] Re-run focused tests and `npm run typecheck`; expect PASS.
- [ ] Commit as `feat: use RanobeLib auth in scanners`.

### Task 5: Add protected credential administration API

**Files:**
- Create: `src/ranobelib-auth-admin.ts`
- Create: `tests/ranobelib-auth-admin.test.mjs`
- Modify: `src/live-entry-v2.ts`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

- [ ] Add RED tests for `GET /api/admin/ranobelib/auth`, `PUT /api/admin/ranobelib/auth`, and `DELETE /api/admin/ranobelib/auth`: require admin session, reject cross-origin mutations, reject malformed/oversized bodies, validate upstream before storing, permit replacement, return only health metadata, and explicitly assert response/error bodies contain no tokens.
- [ ] Run `npm run build:runtime-test && node --test tests/ranobelib-auth-admin.test.mjs`; expect missing-handler failure.
- [ ] Implement `handleRanobeLibAuthAdmin(request, env)` using `requireAdminSession`, a small JSON body limit, strict `{accessToken, refreshToken, expiresAt}` parsing, upstream validation before encrypted persistence, no-store responses, and idempotent deletion.
- [ ] Intercept this handler in `live-entry-v2.fetch` before falling through to the base worker.
- [ ] Add the test to `npm test`, re-run it and `npm run typecheck`; expect PASS.
- [ ] Commit as `feat: administer RanobeLib OAuth credentials`.

### Task 6: Add the RanobeLib authorization admin panel

**Files:**
- Modify: `public/admin/admin.js`
- Modify: `public/admin/admin.css`
- Modify: `public/admin/index.html`
- Create: `tests/admin-ranobelib-auth-ui.test.mjs`
- Modify: `package.json`

- [ ] Add a RED static UI test asserting the RanobeLib route renders credential health, three password inputs for access token, refresh token and expiry, import/replace action, and a separately confirmed remove action; assert no token is saved to localStorage or included in GET URLs.
- [ ] Run the focused UI test; expect failure.
- [ ] Extend `renderSync()` with a health card and import form that sends a same-origin JSON `PUT`, clears inputs in `finally`, never renders returned token material, and refreshes health after success.
- [ ] Add deletion through `DELETE` guarded by `confirm('Удалить авторизацию RanobeLib?')`; bump the admin asset cache key in `public/admin/index.html`.
- [ ] Re-run focused UI test and `npm run typecheck`; expect PASS.
- [ ] Commit as `feat: add RanobeLib authorization controls`.

### Task 7: Full verification, deployment, and credential import

**Files:**
- Modify only if verification finds an in-scope defect.

- [ ] Run `npm test` and record the complete passing count.
- [ ] Run `npm run typecheck` and verify migration/config syntax checks used by CI.
- [ ] Inspect `git diff` and `git status`; ensure only planned files are tracked and no token-like material occurs with `rg -n "access_token|refresh_token|Bearer "` outside test fixtures/protocol code.
- [ ] Push the verified commits directly to the existing `main` ref without force and wait for all GitHub checks to pass.
- [ ] Verify Cloudflare production deployment completed and migration `0027` applied.
- [ ] Configure `RANOBELIB_TOKEN_ENCRYPTION_KEY` as a Cloudflare Worker secret; never store its value in GitHub or repository files.
- [ ] Immediately before transmitting the disposable account's token bundle to the production same-origin admin endpoint, obtain explicit action-time confirmation naming that bundle and destination.
- [ ] Import the token bundle through the admin API, verify health `active`, and confirm API responses/logs do not expose it.
- [ ] Trigger/observe the restricted title `247881--deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha`: first successful authorized scan must establish a silent baseline; confirm a subsequent new Bлинная Беса branch creates exactly one eligible notification.
- [ ] Report commit SHAs, CI result, deployment version, credential health, baseline state, and any residual operational risk.

## Plan self-review

- Every acceptance criterion in the approved spec maps to Tasks 1–7.
- Token import, persistence, refresh rotation, origin restriction, redirect handling, 401 retry, failure states, silent baseline, and next-release notification each have an explicit RED test.
- Runtime interfaces use the existing `D1DatabaseLike` boundary and Cloudflare Web Crypto; no Node-only production dependency is introduced.
- No step creates a branch/PR, changes unrelated notification semantics, weakens tests, or stores credentials in plaintext.
- Placeholder scan: no TBD, TODO, ellipsis implementation placeholders, or unresolved file names remain.
