# Telegram Webhook Performance v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove avoidable D1/schema/router work from ordinary Telegram interactions so `/start`, menu callbacks, proposal navigation, notification navigation, and text input reach their owning handler faster without changing user-visible semantics.

**Architecture:** Keep existing feature handlers, but add a pure outer classifier and use it to bypass unrelated handler families. Cache runtime schema repair per D1 binding, remove slash-command notification cleanup from the pre-handler, and move only best-effort proposal admin alerts off the response critical path with `ctx.waitUntil()`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Telegram Bot API, Node test runner, GitHub Actions, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-09-telegram-webhook-performance-v1-design.md`

## Global Constraints

- Optimize interactive Telegram responsiveness only; do not redesign PDF/EPUB/R2 file transfer.
- Preserve proposal, notification, membership, appeal, publication, and subscription semantics.
- Keep webhook validation fail-closed: missing or mismatched `TELEGRAM_WEBHOOK_SECRET` must not enter business handlers.
- Runtime schema repair remains available as a safety net but must not execute repeatedly after one successful initialization for the same D1 binding object.
- Do not add a destructive D1 migration; this pass is expected to require no new migration.
- `chat_member`, `/start dl_*`, `gate-thanks:*`, `gate-download:*`, appeal callbacks, proposal callbacks, notification callbacks, and ordinary text must keep their current behavior.
- Best-effort side effects may use `ctx.waitUntil()` only after correctness-critical user mutations have completed.
- Every behavior change follows RED -> minimal GREEN -> refactor only while green.
- Before merge: local migrations, TypeScript, website JS syntax, full tests, Wrangler dry-run, PR diff review, exact-head CI, unique production marker, post-merge CI, and production smoke must all pass.

---

### Task 1: Cache runtime schema repair per D1 binding

**Files:**
- Modify: `src/telegram-notification-settings.ts`
- Modify: `src/telegram-text-bot-ux-schema.ts`
- Modify: `src/channel-membership-appeals.ts`
- Modify: `tests/telegram-notification-settings.test.mjs`
- Modify: `tests/telegram-text-bot-ux-schema.test.mjs`
- Modify: `tests/channel-membership-appeals.test.mjs`

**Interfaces:**
- Consumes: existing exported `ensureTelegramNotificationSettingsSchema()`, `ensureTelegramTextBotUxSchema()`, and appeal webhook helpers.
- Produces: same public function signatures and behavior, but DDL executes once per successful warm DB binding and retries after failed initialization.

- [ ] **Step 1: Add failing notification-settings schema-cache test**

Add a mock DB that records every SQL statement and supports duplicate-column responses. Call:

```js
await ensureTelegramNotificationSettingsSchema(env);
await ensureTelegramNotificationSettingsSchema(env);
```

Assert the second call adds zero new SQL statements. Add a second case where the first initialization throws a non-duplicate error, then the DB succeeds; assert the second call retries rather than returning a poisoned cached promise.

- [ ] **Step 2: Add failing text-bot UX schema-cache test**

Call `ensureTelegramTextBotUxSchema(env)` twice against the same mock DB object and assert both `ALTER TABLE` attempts plus table/index creation happen only on the first successful call. Verify a distinct DB object initializes independently.

- [ ] **Step 3: Add failing appeal schema warm-path test**

Drive two appeal-related operations that need schema on the same DB binding (for example two `membership:appeal` callbacks or a callback followed by text submission). Assert `CREATE TABLE channel_membership_appeals` / its indexes are not emitted again after the first successful initialization.

- [ ] **Step 4: Run focused tests and confirm RED**

Run:

```bash
npm run build:runtime-test
node --test tests/telegram-notification-settings.test.mjs tests/telegram-text-bot-ux-schema.test.mjs tests/channel-membership-appeals.test.mjs
```

Expected: new schema-cache assertions fail on current repeated DDL behavior.

- [ ] **Step 5: Add `WeakMap<object, Promise<void>>` caches**

Use the same pattern in both exported schema modules:

```ts
const schemaPromises = new WeakMap<object, Promise<void>>();

export async function ensureTelegramNotificationSettingsSchema(env: TelegramNotificationSettingsEnv): Promise<void> {
  const key = env.DB as object;
  const existing = schemaPromises.get(key);
  if (existing) return existing;
  const promise = initializeTelegramNotificationSettingsSchema(env).catch((error) => {
    schemaPromises.delete(key);
    throw error;
  });
  schemaPromises.set(key, promise);
  return promise;
}
```

Move the current DDL body unchanged into a private initializer. Apply the same design to `ensureTelegramTextBotUxSchema()`.

Inside `channel-membership-appeals.ts`, add an equivalent cache for the private `ensureAppealSchema()`; it must still call `ensureChannelMembershipSchema()` during the first initialization.

- [ ] **Step 6: Run focused tests to GREEN**

Use the same command from Step 4. Require all focused tests green.

- [ ] **Step 7: Commit**

Commit message:

```text
perf: cache Telegram runtime schema initialization
```

---

### Task 2: Remove slash-command notification pre-handler D1 work

**Files:**
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `tests/telegram-subscription-webhook.test.mjs`
- Modify: `tests/telegram-text-bot-ux-e2e.test.mjs`

**Interfaces:**
- Consumes: `handleTelegramNotificationTextInputRequest(request, env)`.
- Produces: slash commands return `null` immediately from this pre-handler without schema repair or state cleanup; owning command handlers retain responsibility for semantically necessary resets.

- [ ] **Step 1: Add failing `/start` no-D1 pre-handler test**

Create a valid private `/start` webhook request with correct secret and a DB mock whose `prepare()` throws if called. Assert:

```js
const response = await handleTelegramNotificationTextInputRequest(request, env);
assert.equal(response, null);
```

Current behavior should fail because it calls notification settings/text-bot UX schema and cleanup statements.

- [ ] **Step 2: Add failing `/propose` and `/help` no-D1 cases**

Use the same DB-throws-on-access mock for `/propose` and `/help`. Both must return `null` without DB access.

- [ ] **Step 3: Run focused test and confirm RED**

```bash
npm run build:runtime-test
node --test tests/telegram-subscription-webhook.test.mjs
```

- [ ] **Step 4: Implement immediate slash-command bypass**

In `handleTelegramNotificationTextInputRequest()`, after validating private non-empty text, change slash-command handling to:

```ts
if (text.startsWith('/')) return null;
```

Delete the pre-handler calls to:

```ts
ensureTelegramNotificationSettingsSchema(env);
ensureTelegramTextBotUxSchema(env);
setProposalInputActive(...);
clearNotificationSearch(...);
clearNotificationCustomInput(...);
```

Remove imports that become unused. Do not change the regular custom-stack/search input priority.

- [ ] **Step 5: Verify `/start` UX remains identical**

Run the notification webhook test plus the existing E2E root-menu scenario. The proposal-v2 `/start` handler must still upsert the user, reset proposal input state, clear transient notification input once, and send the root menu.

- [ ] **Step 6: Commit**

```text
perf: bypass notification prework for slash commands
```

---

### Task 3: Add pure Telegram route classification

**Files:**
- Create: `src/telegram-webhook-routing.ts`
- Create: `tests/telegram-webhook-routing.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export type TelegramWebhookRoute =
  | 'chat-member'
  | 'download-start'
  | 'reader-gate'
  | 'reader-forward'
  | 'membership-appeal'
  | 'notifications'
  | 'proposal'
  | 'generic-private-text'
  | 'compat';

export type TelegramWebhookUpdate = {
  message?: {
    chat?: { type?: string };
    text?: string;
    is_automatic_forward?: boolean;
  };
  callback_query?: { data?: string };
  chat_member?: unknown;
};

export function classifyTelegramWebhookUpdate(update: TelegramWebhookUpdate): TelegramWebhookRoute;
```

- [ ] **Step 1: Write classifier RED tests**

Cases:

```text
chat_member                                 -> chat-member
/start dl_123                              -> download-start
gate-thanks:12 / gate-download:12          -> reader-gate
is_automatic_forward=true                  -> reader-forward
membership:appeal*                         -> membership-appeal
subs:*                                     -> notifications
prop:notifications                         -> notifications
/notifications / /subscriptions            -> notifications
prop:*                                     -> proposal
/start / /propose                          -> proposal
plain private text                         -> generic-private-text
unknown callback / non-private update      -> compat
```

Also assert the classifier never mutates input and needs no DB/network object.

- [ ] **Step 2: Run test and confirm RED because module is missing**

```bash
npm run build:runtime-test
node --test tests/telegram-webhook-routing.test.mjs
```

- [ ] **Step 3: Implement the pure classifier**

Use only string/shape checks. Ordering must avoid overlap:

```ts
if (update.chat_member) return 'chat-member';
if (/^\/start(?:@[A-Za-z0-9_]+)?\s+dl_\d+\s*$/i.test(text)) return 'download-start';
if (/^gate-(?:thanks|download):/.test(callbackData)) return 'reader-gate';
if (message?.is_automatic_forward) return 'reader-forward';
if (callbackData.startsWith('membership:appeal')) return 'membership-appeal';
if (callbackData.startsWith('subs:') || callbackData === 'prop:notifications') return 'notifications';
if (isPlainCommand(text, 'notifications') || isPlainCommand(text, 'subscriptions')) return 'notifications';
if (callbackData.startsWith('prop:') || isPlainCommand(text, 'start') || isPlainCommand(text, 'propose')) return 'proposal';
if (message?.chat?.type === 'private' && typeof message.text === 'string') return 'generic-private-text';
return 'compat';
```

Keep callback-data handling below Telegram's existing assumptions; do not introduce new callbacks.

- [ ] **Step 4: Wire test build/package**

Add `src/telegram-webhook-routing.ts` to `tsconfig.runtime-test.json` and `tests/telegram-webhook-routing.test.mjs` to the explicit `npm test` list.

- [ ] **Step 5: Run classifier test to GREEN**

- [ ] **Step 6: Commit**

```text
perf: classify Telegram webhook updates before dispatch
```

---

### Task 4: Dispatch explicit Telegram routes before unrelated handler chains

**Files:**
- Modify: `src/live-entry-v2.ts`
- Modify: `src/entry.ts`
- Modify: `tests/telegram-webhook-routing.test.mjs`
- Modify: `tests/telegram-subscription-wiring.test.mjs`
- Modify: `tests/channel-membership-access.test.mjs`
- Modify: `tests/channel-membership-appeals.test.mjs`
- Modify: `tests/publication-reader-delivery.test.mjs`

**Interfaces:**
- Consumes: `classifyTelegramWebhookUpdate()` from Task 3.
- Direct handler imports used by `live-entry-v2.ts`:
  - `handleChannelMembershipWebhook()`
  - `handleChannelMembershipAppealWebhook()`
  - `handlePublicationReaderDeliveryWebhook()`
  - `handleTelegramSubscriptionWebhookRequest()`
  - default interactive `entry.ts` worker for proposal/generic paths.
- Produces: outer `POST /telegram/webhook` dispatch that validates once, parses once, routes explicit families, and preserves a compatibility fallback.

- [ ] **Step 1: Add RED source/wiring test for one outer Telegram branch**

Assert `live-entry-v2.ts` contains an explicit `POST /telegram/webhook` branch before generic appeal/reader/base-worker fallbacks and imports `classifyTelegramWebhookUpdate`.

- [ ] **Step 2: Add RED direct notification routing test**

Construct a valid `subs:center` request and instrument unrelated handler dependencies through source assertions or runtime mocks so the test proves notification routing goes directly to `handleTelegramSubscriptionWebhookRequest` rather than first entering appeal/proposal/download handlers.

The behavioral invariant is: no appeal schema SQL and no proposal-session SQL before the notification handler begins.

- [ ] **Step 3: Add RED proposal routing test**

For `prop:new`, assert the route reaches interactive proposal handling without notification custom/search D1 lookups before proposal ownership is evaluated.

- [ ] **Step 4: Add RED security test at the outer boundary**

For missing secret, missing header, and mismatched header, expect `403 Forbidden` from `live-entry-v2.fetch()` before any handler DB/network work.

- [ ] **Step 5: Add RED regressions for special routes**

Verify routing contracts:

```text
chat-member       -> handleChannelMembershipWebhook
download-start    -> appeal check first, then reader-delivery if not handled
reader-gate       -> handlePublicationReaderDeliveryWebhook
reader-forward    -> handlePublicationReaderDeliveryWebhook
membership-appeal -> handleChannelMembershipAppealWebhook
notifications     -> handleTelegramSubscriptionWebhookRequest
proposal          -> interactive entry worker
generic text      -> appeal handler first, then interactive entry
compat            -> existing baseWorker chain
```

- [ ] **Step 6: Implement outer parse/classify branch**

At the top of `live-entry-v2.fetch()` after URL construction and before unrelated handlers:

```ts
if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim() || '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) {
    return new Response('Forbidden', { status: 403 });
  }

  const startedAt = Date.now();
  const update = await request.clone().json().catch(() => null) as TelegramWebhookUpdate | null;
  if (!update) return new Response('Bad Request', { status: 400 });
  const route = classifyTelegramWebhookUpdate(update);
  const response = await dispatchTelegramWebhook(route, request, env, ctx);
  console.log('Telegram webhook handled', { route, durationMs: Date.now() - startedAt });
  return response;
}
```

Keep the timing log free of user message text/callback bodies/tokens.

- [ ] **Step 7: Implement `dispatchTelegramWebhook()` as a focused private function**

Use explicit route branches. For `download-start`, preserve appeal-first behavior:

```ts
const appeal = await handleChannelMembershipAppealWebhook(request, env, ctx);
if (appeal) return appeal;
return (await handlePublicationReaderDeliveryWebhook(request, env, ctx)) ?? new Response('ok');
```

For `generic-private-text`, preserve state priority by calling appeal first and then the interactive entry worker. For `compat`, delegate to `baseWorker.fetch()` unchanged.

- [ ] **Step 8: Pass execution context into interactive entry**

Change `src/entry.ts` worker signature to accept an optional context:

```ts
interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }

async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response>
```

Update `live-entry.ts` fallback call from:

```ts
return appEntry.fetch(request, env);
```

to:

```ts
return appEntry.fetch(request, env, ctx);
```

The direct performance route in `live-entry-v2.ts` also passes `ctx`.

- [ ] **Step 9: Run focused routing/security/regression tests to GREEN**

At minimum:

```bash
npm run build:runtime-test
node --test \
  tests/telegram-webhook-routing.test.mjs \
  tests/telegram-subscription-wiring.test.mjs \
  tests/channel-membership-access.test.mjs \
  tests/channel-membership-appeals.test.mjs \
  tests/publication-reader-delivery.test.mjs \
  tests/telegram-text-bot-ux-e2e.test.mjs
```

- [ ] **Step 10: Commit**

```text
perf: route Telegram updates directly to owning handlers
```

---

### Task 5: Move proposal admin alerts off the successful response critical path

**Files:**
- Modify: `src/entry.ts`
- Modify: `tests/telegram-title-proposal-admin-alert.test.mjs`
- Modify: `tests/telegram-title-proposal-submit.test.mjs`

**Interfaces:**
- Consumes: optional `ExecutionContextLike` added in Task 4 and existing `notifyAdminsForCreatedTitleProposal()`.
- Produces: once proposal creation is confirmed by the proposal handler, admin alert scheduling no longer blocks the user response when `ctx` exists.

- [ ] **Step 1: Add RED waitUntil test**

Use an execution context mock:

```js
const scheduled = [];
const ctx = { waitUntil(promise) { scheduled.push(promise); } };
```

Drive a `prop:submit` flow that creates a new proposal. Assert the response can complete after proposal creation while one admin-alert promise is registered in `scheduled`.

- [ ] **Step 2: Preserve no-context compatibility test**

Call `entry.fetch(request, env)` without context and verify existing tests still observe admin notification behavior by awaiting it inline.

- [ ] **Step 3: Implement helper**

After `proposalResponse` is confirmed and `proposalAlertContext` exists:

```ts
const alert = notifyAdminsForCreatedTitleProposal(env, proposalAlertContext).catch((error) => {
  console.error('Proposal admin alert failed', error);
});
if (ctx) ctx.waitUntil(alert);
else await alert;
return proposalResponse;
```

Do not background proposal creation or session deletion itself.

- [ ] **Step 4: Run proposal alert/submit tests to GREEN**

- [ ] **Step 5: Commit**

```text
perf: defer proposal admin alerts after user response
```

---

### Task 6: Full verification, review, unique production marker, and merge

**Files:**
- Modify: `public/build.txt`
- Modify: `.github/workflows/ci.yml`
- Optionally create: `.github/workflows/production-smoke-telegram-perf-v1.yml` if changing the shared marker would make older checks ambiguous.
- Modify: PR body only after final review.

**Interfaces:** none; this task proves the exact build reached production.

- [ ] **Step 1: Add unique build marker**

Preserve existing marker lines required by CI and add:

```text
domnkr-build-20260909-telegram-perf1
```

Update/add a main-push production smoke that explicitly requires this marker. Do not silently replace a marker still asserted by other CI without updating those assertions safely.

- [ ] **Step 2: Run complete verification on exact final branch head**

Require success for:

```bash
npm run db:local
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

CI additionally runs all website JavaScript syntax/static guards.

- [ ] **Step 3: Review full diff**

Check specifically:

- no user-visible navigation/copy changes except timing logs;
- no weakened webhook-secret path;
- generic private text keeps appeal -> notification custom -> notification search -> proposal priority;
- no correctness-critical mutation moved into `waitUntil()`;
- no sensitive Telegram text/tokens in timing logs;
- no new schema migration accidentally introduced;
- callbacks and `/start dl_*` compatibility remain intact.

- [ ] **Step 4: Open/update one PR**

Head: `perf/telegram-webhook-hot-path-v1`
Base: `main`
Title: `Speed up Telegram bot webhook hot path`

PR body must summarize confirmed old hot-path costs, the structural optimization, TDD coverage, and exact verification state.

- [ ] **Step 5: Require exact-head CI GREEN and no blocking review threads**

If CI/review exposes any defect, add a failing regression first, fix it, then obtain a fresh full green run on the new head.

- [ ] **Step 6: Squash merge to `main` automatically**

Merge only when exact current head is green and mergeable.

- [ ] **Step 7: Verify post-merge production**

Require both:

1. post-merge `main` CI `success` on the merge SHA;
2. production smoke `success` for `domnkr-build-20260909-telegram-perf1` on the same merge SHA.

Only after both succeed claim Performance v1 is live.
