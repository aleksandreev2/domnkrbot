# Telegram Latency v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary Telegram bot interactions feel effectively immediate by acknowledging callbacks before expensive work, removing global maintenance from navigation, parallelizing independent D1 work, and adding stage-level latency instrumentation.

**Architecture:** Keep the Performance v1 outer webhook classifier and existing feature handlers. Add one focused callback-ack helper, refactor notification/subscription and proposal handlers so acknowledgement and housekeeping are no longer serialized, defer demand maintenance with `ctx.waitUntil()` after durable state writes, and preserve correctness-first handling for moderation/security actions.

**Tech Stack:** TypeScript, Cloudflare Workers Paid, D1/SQLite, Telegram Bot API, Node test runner, GitHub Actions, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-09-telegram-latency-v2-design.md`

## Global Constraints

- Optimize perceived and actual latency of interactive Telegram commands/callbacks only; PDF/EPUB/R2 transfer remains out of scope.
- Keep webhook validation fail-closed.
- Do not make ban/unban, appeal decisions, publication moderation, or proposal creation itself optimistic/background-only.
- Pure navigation must never call `refreshAllNotificationDemand()`.
- Single-title subscription mutations persist first, then schedule `refreshTitleNotificationDemand(bookRef)`.
- All-title mutations persist first, then schedule `refreshAllNotificationDemand()`.
- Callback acknowledgement failures are non-fatal; state mutation/render failures are not silently swallowed.
- No new D1 migration is expected.
- D1 Read Replication/Sessions API is not enabled in this PR; stage timings determine whether a v2.1 experiment is justified.
- Performance tests assert ordering/call-count/critical-path structure, not wall-clock milliseconds in CI.
- Before merge: local migrations, TypeScript, full tests, website JS/static guards, Wrangler dry-run, exact-head CI, diff review, no blocking threads, unique production marker, post-merge CI, Cloudflare build, and production smoke all must pass.

---

### Task 1: Add a reusable early callback acknowledgement helper

**Files:**
- Create: `src/telegram-fast-ack.ts`
- Create: `tests/telegram-fast-ack.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export type TelegramFastAckEnv = { TELEGRAM_BOT_TOKEN?: string };
export type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };

export function startCallbackAck(
  env: TelegramFastAckEnv,
  callbackId: string,
  ctx?: ExecutionContextLike,
  text?: string,
): Promise<void>;
```

Semantics:
- start `answerCallbackQuery` immediately;
- when `ctx` exists, register the promise with `ctx.waitUntil()` and return the same promise to tests/callers;
- swallow Telegram callback-ack failure after logging a compact error;
- never log bot token or callback payload text beyond optional constant UI text supplied by the caller.

- [ ] **Step 1: Write RED tests for immediate scheduling and error swallowing**

Add `tests/telegram-fast-ack.test.mjs` with a deferred `globalThis.fetch` mock. Verify:

```js
const scheduled = [];
const ctx = { waitUntil(promise) { scheduled.push(promise); } };
const ack = startCallbackAck({ TELEGRAM_BOT_TOKEN: 'token' }, 'cb-1', ctx);
assert.equal(fetchCalls.length, 1);
assert.equal(scheduled.length, 1);
```

Then resolve the Telegram response and await `ack`. Add a failure response and assert `ack` does not reject.

- [ ] **Step 2: Run focused test and confirm RED**

Run:

```bash
npm run build:runtime-test
node --test tests/telegram-fast-ack.test.mjs
```

Expected: module/import missing.

- [ ] **Step 3: Implement the helper**

Create `src/telegram-fast-ack.ts` with one Telegram request:

```ts
const promise = fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callback_query_id: callbackId, ...(text ? { text } : {}) }),
}).then(async (response) => {
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram answerCallbackQuery failed with HTTP ${response.status}`);
}).catch((error) => {
  console.error('Telegram callback acknowledgement failed', error);
});
if (ctx) ctx.waitUntil(promise);
return promise;
```

If token/callback ID is absent, return `Promise.resolve()`.

- [ ] **Step 4: Wire runtime-test/package and run GREEN**

Add the source to `tsconfig.runtime-test.json` and the test to the explicit `npm test` list. Re-run focused test and `npm run typecheck`.

- [ ] **Step 5: Commit**

```text
perf: add early Telegram callback acknowledgement
```

---

### Task 2: Remove global notification-demand maintenance from navigation and defer mutation refreshes

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `src/live-entry-v2.ts`
- Modify: `tests/telegram-subscriptions.test.mjs`
- Modify: `tests/telegram-subscription-webhook.test.mjs`
- Create: `tests/telegram-latency-v2-subscriptions.test.mjs`

**Interfaces:**
- `handleTelegramSubscriptionWebhookRequest(request, env, ctx?)` accepts optional execution context.
- `handleTelegramSubscriptionUpdate(update, env, ctx?)` accepts optional execution context.
- Consumes `startCallbackAck()` from Task 1.

- [ ] **Step 1: Write RED test proving `subs:center` does not run global demand refresh**

Use a D1 mock that throws if SQL contains the `WITH demand AS` body used by `refreshAllNotificationDemand()`. Drive a `subs:center` callback through `handleTelegramSubscriptionWebhookRequest()` with Telegram fetch mocked. Expected behavior: callback handled successfully without matching global-demand SQL.

- [ ] **Step 2: Write RED ordering test for early callback ack**

Record events from the Telegram fetch mock and D1 mock:

```text
ack:start
D1:menu-read
edit:start
```

Assert `ack:start` occurs before the first menu D1 query and before `editMessageText`.

- [ ] **Step 3: Write RED mutation tests for deferred maintenance**

For a single-title toggle:
- durable subscription INSERT/DELETE must occur before `ctx.waitUntil()` receives targeted demand refresh;
- no global demand refresh runs.

For all-titles on/off:
- durable setting mutation occurs first;
- global refresh is scheduled via `waitUntil()` rather than awaited before screen update.

- [ ] **Step 4: Run focused tests and confirm RED**

```bash
npm run build:runtime-test
node --test tests/telegram-latency-v2-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs tests/telegram-subscriptions.test.mjs
```

- [ ] **Step 5: Thread execution context into subscription webhook/update functions**

Change signatures:

```ts
export async function handleTelegramSubscriptionWebhookRequest(request, env, ctx?)
export async function handleTelegramSubscriptionUpdate(update, env, ctx?)
```

Pass `ctx` from `live-entry-v2.ts` direct `notifications` dispatch.

- [ ] **Step 6: Refactor `handleTelegramSubscriptionUpdate()` by route ownership**

After parse:

```text
noop -> start ack; return
navigation -> start ack; only route-specific reads/render
single-title mutation -> start ack; persist; ctx.waitUntil(refreshTitleNotificationDemand)
all mutation -> start ack; persist; ctx.waitUntil(refreshAllNotificationDemand)
```

Remove unconditional:

```ts
await markTelegramUserReachable(...);
await refreshAllNotificationDemand(env);
```

from the callback preamble. If reachability bookkeeping is retained, schedule it with `ctx.waitUntil(markTelegramUserReachable(...))` after ownership is known.

- [ ] **Step 7: Ensure only one callback acknowledgement per route**

Remove trailing `await answerCallback(...)` for routes that call `startCallbackAck()`. Keep authoritative-result text only where the UX genuinely needs it; for mutation routes use empty early ack and let the updated message reflect state.

- [ ] **Step 8: Run focused tests to GREEN**

Require no `WITH demand AS` query for navigation and correct deferred ordering for mutation routes.

- [ ] **Step 9: Commit**

```text
perf: remove demand maintenance from subscription navigation
```

---

### Task 3: Early-ack and streamline Notification UX v2 callbacks

**Files:**
- Modify: `src/telegram-notification-ux-runtime.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `tests/telegram-notification-ux-runtime.test.mjs`
- Create: `tests/telegram-latency-v2-notification-ux.test.mjs`

**Interfaces:**
- `handleTelegramNotificationUxUpdate(update, env, ctx?)` accepts optional execution context.
- Consumes `startCallbackAck()`.

- [ ] **Step 1: Write RED navigation ordering tests**

For representative `subs:center`, `subs:mine:*`, `subs:all-list:*`, title-card and search navigation callbacks, assert callback ack starts before:
- `ensureNotificationUxSchema()` completes;
- D1 menu/title reads;
- `editMessageText`.

- [ ] **Step 2: Write RED test that read-only navigation does not upsert user**

Use a DB mock that throws on `INSERT INTO users` for a pure navigation callback already containing a Telegram user. The route should still render.

- [ ] **Step 3: Write RED mutation maintenance ordering test**

For Notification UX title toggle:
- subscription write completes first;
- `refreshTitleNotificationDemand()` is scheduled after the write with `ctx.waitUntil()`;
- edit/render proceeds without awaiting demand refresh.

- [ ] **Step 4: Implement optional `ctx` and early ack**

Start acknowledgement immediately after callback parse/ownership and private-chat validation. Remove route-end duplicate acknowledgements.

- [ ] **Step 5: Make user-touch/cleanup route-specific**

Remove universal `upsertTelegramUser`, `setProposalInputActive`, and `clearNotificationCustomInput` before the route switch. Apply cleanup only when entering a mode that semantically cancels another input; batch/parallelize independent cleanup where needed.

- [ ] **Step 6: Defer targeted mutation maintenance**

After `setEffectiveTitleSubscription()` succeeds:

```ts
const refresh = refreshTitleNotificationDemand(env, title.book_ref).catch(...);
if (ctx) ctx.waitUntil(refresh);
else await refresh;
```

- [ ] **Step 7: Run focused tests to GREEN and commit**

```text
perf: acknowledge notification UI callbacks before render work
```

---

### Task 4: Make `/start` start Telegram output concurrently with housekeeping

**Files:**
- Modify: `src/telegram-title-proposals-v2.ts`
- Modify: `tests/telegram-text-bot-ux-e2e.test.mjs`
- Create: `tests/telegram-latency-v2-start.test.mjs`

**Interfaces:** existing proposal-v2 webhook signature remains unchanged unless an optional `ctx` is needed for later tasks.

- [ ] **Step 1: Write RED concurrency test**

Use deferred D1 promises for user upsert/reset/notification cleanup and a Telegram fetch mock. Drive `/start` and assert `sendMessage` fetch begins before the deferred housekeeping promises are resolved.

Also assert the handler itself does not resolve until the required state cleanup finishes.

- [ ] **Step 2: Run focused test and confirm RED**

```bash
npm run build:runtime-test
node --test tests/telegram-latency-v2-start.test.mjs tests/telegram-text-bot-ux-e2e.test.mjs
```

- [ ] **Step 3: Refactor `/start` after cached schema readiness**

Start two promises without awaiting either first:

```ts
const menuPromise = sendMessage(env, message.chat.id, buildMainMenu(origin));
const housekeepingPromise = Promise.all([
  upsertTelegramUser(env, message.from),
  setProposalInputActive(env, String(message.from.id), 0),
  clearTransientNotificationInput(env, message.from.id),
]);
await Promise.all([menuPromise, housekeepingPromise]);
```

If D1 binding types support `batch()` cleanly for the cleanup statements, prefer a later minimal refactor only after the concurrency test is GREEN.

- [ ] **Step 4: Keep `/propose` correctness ordering**

Do not parallelize session load/reset past writes that determine whether a meaningful draft exists. Only parallelize independent user-touch/transient cleanup with the first session read where safe and covered by tests.

- [ ] **Step 5: Run focused tests to GREEN and commit**

```text
perf: start Telegram root menu before housekeeping completes
```

---

### Task 5: Early-ack and parallelize proposal callback prework

**Files:**
- Modify: `src/telegram-title-proposals-v2.ts`
- Modify: `src/entry.ts`
- Modify: `tests/telegram-title-proposal-navigation-v2.test.mjs`
- Modify: `tests/telegram-title-proposal-editing-v2.test.mjs`
- Create: `tests/telegram-latency-v2-proposals.test.mjs`

**Interfaces:**
- `handleTelegramTitleProposalV2WebhookRequest(request, env, ctx?)` may gain optional execution context.
- Consumes `startCallbackAck()`.

- [ ] **Step 1: Write RED ack-order test for pure proposal navigation**

For `prop:home`, `prop:new`, `prop:resume`, `prop:back`, and `prop:results:0`, assert `answerCallbackQuery` begins before D1 session reads/writes and before `editMessageText`.

- [ ] **Step 2: Write RED single-ack regression test**

Count Telegram `answerCallbackQuery` requests and require exactly one per handled callback.

- [ ] **Step 3: Write RED parallel-prework test**

For a claimed proposal callback, defer user upsert and transient-input cleanup and prove they are started together rather than sequentially before business session work.

- [ ] **Step 4: Thread optional `ctx` from `entry.ts` to proposal-v2 handler**

Update `entry.ts` call to pass the existing execution context.

- [ ] **Step 5: Start callback ack before schema/business work**

After callback ownership is known and private chat is validated:

```ts
const ack = startCallbackAck(env, callback.id, ctx);
```

Do not await it in early-ack routes.

- [ ] **Step 6: Parallelize independent callback prework**

After cached schema readiness, use:

```ts
await Promise.all([
  upsertTelegramUser(env, callback.from),
  clearTransientNotificationInput(env, callback.from.id),
]);
```

Do not parallelize session mutations that depend on a prior session read.

- [ ] **Step 7: Remove duplicate tail `answerCallback()` calls for early-ack routes**

Keep result-text acknowledgement only for authoritative exceptional cases; where a callback needs a toast, either pass constant text to `startCallbackAck()` before work when truthful regardless of outcome, or keep that route after-decision.

- [ ] **Step 8: Run focused tests to GREEN and commit**

```text
perf: acknowledge proposal callbacks before D1 and rendering
```

---

### Task 6: Add stage-level production latency instrumentation

**Files:**
- Modify: `src/live-entry-v2.ts`
- Create: `src/telegram-latency-timing.ts`
- Create: `tests/telegram-latency-timing.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Produces a small timer object:

```ts
export type TelegramLatencyTiming = {
  mark(stage: 'ack_started' | 'schema_done' | 'db_done' | 'telegram_done'): void;
  snapshot(route: string, kind?: string): Record<string, number | string>;
};
export function createTelegramLatencyTiming(startedAt?: number): TelegramLatencyTiming;
```

- [ ] **Step 1: Write RED unit test for monotonic stage deltas**

Inject deterministic timestamps and assert snapshot fields are non-negative deltas with only normalized route/kind metadata.

- [ ] **Step 2: Implement timer helper**

Track start and named marks; return coarse fields:

```text
route, kind, ack_started_ms, schema_ms, db_ms, telegram_ms, total_ms
```

Omit absent stages rather than inventing zeroes.

- [ ] **Step 3: Wire outer dispatcher timing**

Keep Performance v1 route-level log, but replace with a single structured v2 summary. Do not log message text, callback data, user IDs, bot token, or webhook secret.

- [ ] **Step 4: Add source-security assertion**

Extend routing/performance tests so the timing log cannot contain `text`, `callbackData`, `token`, `secret`, or raw update data.

- [ ] **Step 5: Run focused tests to GREEN and commit**

```text
perf: add Telegram latency stage instrumentation
```

---

### Task 7: Evaluate direct Telegram webhook-response acknowledgement as an optional spike inside the PR

**Files:**
- Create: `tests/telegram-webhook-response-ack.test.mjs`
- Modify only if retained: `src/live-entry-v2.ts`, `src/telegram-fast-ack.ts`

**Interfaces:** no required production interface; this task may end with test/documentation only if the direct-response path is not simpler or safe.

- [ ] **Step 1: Write compatibility test for direct webhook response shape**

Build the Telegram webhook HTTP response payload:

```json
{
  "method": "answerCallbackQuery",
  "callback_query_id": "cb-1"
}
```

Assert content type and payload are correct.

- [ ] **Step 2: Compare complexity against concurrent outbound ack**

Review whether direct response can be used without making the remaining render/mutation work depend on the request body/response lifetime and without duplicating handler ownership.

- [ ] **Step 3: Keep only if simpler and correctness-equivalent**

If retained, use only for pure-navigation callbacks where all remaining work is safely registered with `ctx.waitUntil()`. If not retained, document in the test/PR body that early concurrent outbound ack remains the v2 implementation because it preserves simpler error semantics.

- [ ] **Step 4: Run full relevant tests**

No merge blocker requires this optimization to be retained; v2 succeeds with early outbound ack alone.

---

### Task 8: Full verification, diff review, unique marker, PR, merge, and production proof

**Files:**
- Modify: `public/build.txt`
- Modify: `.github/workflows/ci.yml`
- Update: PR body

**Interfaces:** none.

- [ ] **Step 1: Add unique production marker**

Append:

```text
domnkr-build-20260909-telegram-perf2
```

Preserve all older markers still asserted by CI. Update main-push production smoke to require the v2 marker.

- [ ] **Step 2: Run complete verification on exact final head**

Require success for:

```bash
npm run db:local
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

CI also runs website JavaScript/static guards.

- [ ] **Step 3: Review full diff**

Explicitly verify:
- no moderation/ban correctness-critical operation moved to background;
- no subscription mutation acknowledged with misleading success text before the mutation result is known;
- pure navigation does zero global demand refresh;
- targeted/global demand maintenance is scheduled only after durable writes;
- callback routes do not double-ack;
- `/start dl_*`, reader-gate, membership appeal, and compat routes are unchanged;
- timing logs contain no sensitive user content;
- no accidental cron/scanner/RanobeLib-sync changes;
- no D1 Read Replication configuration in this PR.

- [ ] **Step 4: Open/update one PR**

Head: `perf/telegram-latency-v2`
Base: `main`
Title: `Make Telegram bot interactions respond immediately`

PR body must include:
- root causes confirmed after v1;
- exact critical-path changes;
- what remains correctness-first;
- whether direct webhook-response ack was retained or rejected;
- exact-head verification evidence.

- [ ] **Step 5: Require exact-head CI GREEN and no blocking review threads**

Any new defect requires a failing regression test before the fix.

- [ ] **Step 6: Squash merge automatically to `main`**

Use the exact tested head SHA.

- [ ] **Step 7: Verify production on merge SHA**

Require all three on the same merge SHA:
1. main CI `test` success;
2. Cloudflare Workers build success;
3. production smoke success for `domnkr-build-20260909-telegram-perf2`.

- [ ] **Step 8: Use production stage timings for the next decision**

If residual latency is dominated by D1 reads on read-only catalog/search routes, propose a separate v2.1 D1 Read Replication/Sessions API experiment. If Telegram API latency dominates, optimize transport/response strategy instead. Do not guess before the data exists.
