# RanobeLib OAuth for restricted-title scanning

## Status

Approved direction for implementation on `main`. This design adds authenticated, read-only
RanobeLib API access to the existing discovery and multi-team scanner without changing release,
baseline, subscription, or delivery semantics.

## Problem

RanobeLib hides some 18+ titles from signed-out API clients. Team chapter history remains public,
so discovery can identify an exact team/title relationship, but the title-specific detail and
chapter endpoints return HTTP 404 without authorization. The scanner therefore records a retryable
failure and cannot establish a baseline or create releases for later chapters.

The confirmed production example is `247881--deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha`:
team `64306--blinnaia-besa` published chapter 203, the public team history exposed it, and the
anonymous `/api/manga/{ref}/chapters` endpoint returned 404.

## Goals

- Let the Worker read restricted RanobeLib titles and chapters through a dedicated drop account.
- Refresh OAuth tokens automatically, including rotated refresh tokens.
- Keep credentials out of Git, Wrangler variables, logs, D1 plaintext, API responses, and Telegram.
- Send credentials only to the allowlisted RanobeLib API origin.
- Preserve public discovery fallbacks when authentication is missing or temporarily broken.
- Preserve the existing no-historical-replay baseline invariant.
- Expose useful credential health to an authenticated administrator without exposing secrets.

## Non-goals

- Storing or automating the RanobeLib username/password.
- Performing write operations on RanobeLib.
- Replacing the existing team-history discovery fallback.
- Replaying chapters missed before a translation received its first successful baseline.
- Adding a general OAuth framework for unrelated providers.

## Upstream protocol

The current RanobeLib frontend uses OAuth2 bearer tokens:

- API requests send `Authorization: Bearer <access_token>`.
- The stored token bundle contains `access_token`, `refresh_token`, `expires_in`, and a local
  acquisition timestamp.
- Refresh uses `POST /api/auth/oauth/token` with `grant_type=refresh_token`, `client_id=1`, the
  current refresh token, and an empty scope.
- A successful refresh replaces the entire token bundle, because the refresh token may rotate.

The Worker will reproduce only this refresh and read-request behavior. It will not automate the
interactive authorization-code login flow.

## Architecture

### Encrypted credential store

Migration `0027` adds a singleton `ranobelib_auth_credentials` row containing:

- versioned AES-GCM ciphertext;
- IV and key-version metadata;
- access-token expiry time;
- credential state (`active`, `expired`, or `invalid`);
- last successful validation/refresh time;
- last sanitized error and update time.

The encryption key is a new Cloudflare Worker secret named
`RANOBELIB_TOKEN_ENCRYPTION_KEY`. It is never stored in D1 or committed to the repository. The
plaintext token bundle exists only in request-local memory while encrypting, refreshing, or making
an authorized request.

### Admin import and health API

The existing Telegram-authenticated web admin receives a small RanobeLib authorization panel.
It supports:

- importing a complete OAuth token bundle copied from the already signed-in drop account;
- validating the bundle with `GET /api/auth/me` before committing it;
- replacing an invalid/expired bundle;
- viewing state, expiry, validation time, refresh time, and a sanitized error;
- removing credentials after an explicit destructive-action confirmation.

The browser submits the bundle directly to the Worker's same-origin admin endpoint. Tokens are
never sent through chat, Telegram, GitHub, query parameters, analytics, or console logging. API
responses never echo token values.

### Token provider

A focused `RanobeLibAuthProvider` owns decrypt/load, refresh, validation, and persistence. It:

1. Loads and decrypts the singleton token bundle.
2. Refreshes shortly before the server-provided expiry time.
3. Coalesces concurrent refreshes within one Worker isolate.
4. Persists the complete rotated bundle atomically after successful refresh.
5. Marks credentials invalid after a failed refresh or validation, using a sanitized error.
6. On an authenticated read returning 401, refreshes and retries exactly once.

The provider never returns a bearer header for any origin except
`https://api.cdnlibs.org`. Redirects to a different origin must not retain authorization.

### RanobeLib client integration

`RanobeLibClient` gains an optional authorization-header provider. Existing test-injected clients
and anonymous behavior continue to work unchanged. Production discovery, scanners, status refresh,
and admin preview obtain clients through one environment-aware factory rather than constructing
unauthenticated clients independently.

Authentication is preferred for RanobeLib API reads when configured. Public team-history and HTML
fallbacks remain available. Authentication failure must not turn an inconclusive upstream response
into evidence that a team/title relation is dormant.

## Request flow

For a restricted-title scan:

1. Discovery finds the title through exact team attribution in public team history.
2. The scanner selects the unbaselined team/title relation.
3. The client asks the provider for a valid bearer token.
4. The provider refreshes first when needed and persists any rotated bundle.
5. The client calls `/api/manga/{ref}/chapters` with the bearer header.
6. The first successful scan records the branch snapshot and sets `baseline_ready=1` without a
   release.
7. A later new branch creates the normal team-scoped release and notification fanout.

## Failure behavior

- No configured credentials: retain current anonymous behavior and health state `missing`.
- Decryption/key mismatch: fail closed for authenticated access, retain public fallbacks, and show a
  sanitized admin error.
- Refresh/network/5xx failure: do not overwrite the last valid encrypted bundle; schedule the
  existing scanner retry.
- Refresh 400/401 or validation 401: mark credentials invalid and require a new import.
- Authorized title 404: treat it as the existing upstream scan failure; never fabricate chapters.
- Concurrent refresh: only one refresh request runs per isolate; other callers await it.
- Logging: URLs, status codes, and credential state are allowed; tokens and request authorization
  headers are forbidden.

## Security boundaries

- Use the dedicated drop account only; it must contain no personal data or valuable permissions.
- The Worker performs only GET requests except the OAuth refresh POST.
- Bearer authorization is restricted to the exact HTTPS API origin.
- Token import and health endpoints require the existing admin session and same-origin mutation
  checks.
- Token fields use `Cache-Control: no-store`, are never serialized back to clients, and are redacted
  from thrown errors.
- AES-GCM uses a fresh random 96-bit IV for every write and authenticated additional data containing
  the schema/key version.

## Testing

Automated tests must cover:

- encryption round-trip and failure with the wrong key;
- token values absent from persisted plaintext fields, logs, errors, and API responses;
- authorization attached only to the exact RanobeLib API origin;
- no authorization on redirects or unrelated origins;
- pre-expiry refresh and complete refresh-token rotation persistence;
- one refresh for concurrent callers;
- 401 refresh plus one retry, with no retry loop;
- missing/invalid credential fallback behavior;
- admin authentication, origin checks, validation, import, health, replacement, and deletion;
- anonymous 404 followed by authenticated success for a restricted chapter fixture;
- initial authenticated baseline creates no historical release;
- the next team-attributed branch creates exactly one release and eligible notification;
- existing anonymous title, multi-team attribution, baseline, and delivery suites remain green.

## Deployment and verification

1. Apply migration `0027` through the normal deployment pipeline.
2. Configure `RANOBELIB_TOKEN_ENCRYPTION_KEY` as a Cloudflare secret.
3. Deploy with no token bundle first; public behavior must remain unchanged.
4. Import and validate the drop-account token bundle through the authenticated admin panel.
5. Run a restricted-title baseline and confirm no historical notification is emitted.
6. Confirm the next new restricted team chapter creates one notification for an eligible test
   subscriber.
7. Verify CI, Worker deployment, credential health, and production logs with redaction checks.

## Acceptance criteria

- Restricted title detail/chapter reads succeed while the drop-account authorization is healthy.
- Refresh survives access-token expiry and persists a rotated refresh token.
- No credential material appears outside encrypted D1 content and request-local memory.
- Missing or broken authorization is visible to admins and does not erase discovered relations.
- First successful scan remains a silent baseline; only subsequent new chapters notify.
- Existing public-title notifications and all regression tests continue to pass.
