# Telegram Latency v2 — Design

## Status

Approved in chat for design. This pass targets perceived and actual latency of the interactive Telegram bot after Performance v1. The user is on Cloudflare Workers Paid, so the optimization goal is responsiveness rather than minimizing every subrequest for free-tier quotas.

## Goal

Make ordinary bot interactions feel effectively immediate:

- callback spinner disappears as early as safely possible;
- navigation buttons start their Telegram acknowledgement before D1/UI work;
- `/start` begins sending the root menu without waiting for unrelated housekeeping;
- subscription navigation does not run global notification-demand recomputation;
- independent D1 work does not execute serially when it can be batched or parallelized;
- external RanobeLib work never blocks acknowledgement of a Telegram button;
- production timing data can distinguish Telegram API latency from D1 and application work.

No fixed millisecond SLA is promised until production measurements exist. The structural target is to remove avoidable sequential network round trips from the user-visible critical path.

## Confirmed root causes after Performance v1

Performance v1 removed repeated schema DDL and unrelated handler chains, but important latency remains inside the owning handlers.

### 1. Callback acknowledgement happens too late

Several proposal and notification callbacks currently do roughly:

```text
D1 reads/writes
-> build payload
-> Telegram editMessageText/sendMessage
-> answerCallbackQuery
```

Telegram keeps the button spinner active until `answerCallbackQuery` arrives. Waiting for D1 and message editing before answering the callback therefore makes even a correct fast Worker feel slow.

### 2. Subscription callbacks perform global demand maintenance

The legacy subscription callback path runs:

```text
ensure schema
-> upsert Telegram user
-> mark user reachable
-> refreshAllNotificationDemand()
-> actual callback work
-> edit message
-> answerCallbackQuery
```

`refreshAllNotificationDemand()` updates demand for every active RanobeLib title. It is maintenance work, not navigation work, and must not run before rendering a menu.

### 3. `/start` waits on housekeeping before starting Telegram output

The proposal-v2 `/start` path waits for user upsert, proposal input reset, notification-search cleanup, and custom-input cleanup before it calls `sendMessage` for the root menu. Those state operations are largely independent of the outbound Telegram request.

### 4. Proposal callback prework is sequential

Proposal callbacks commonly wait for schema readiness, user upsert, search cleanup, custom-input cleanup, session reads/writes, editMessageText, and finally callback acknowledgement. Much of the prework is independent and can be started together.

### 5. Telegram API round trips dominate perception

The Worker still performs separate outbound HTTPS calls for message editing and callback acknowledgement. For callback routes, the acknowledgement should be started first or, where safe, returned as the webhook response while remaining work continues under `waitUntil()`.

## Non-goals

This pass does not:

- redesign bot copy or navigation;
- change membership/ban correctness rules;
- background correctness-critical ban/unban or appeal decisions;
- redesign PDF/EPUB/R2 delivery;
- move proposal creation itself into the background;
- introduce Durable Objects;
- replace D1;
- add a Queue for ordinary button clicks;
- enable D1 Read Replication blindly before measuring whether read latency is still a dominant residual cost;
- weaken webhook secret validation.

## Design principles

### Perceived speed first

For callback queries, stopping Telegram's spinner is a separate performance objective from finishing the screen update. The bot should acknowledge the click as soon as ownership and basic validity are known.

### Correctness-critical state remains durable

A fast acknowledgement must not cause correctness-critical writes to be skipped. Background work is allowed only when:

- the callback can be safely acknowledged before the write finishes;
- the write is idempotent or the unchanged UI is an acceptable failure state;
- failures are caught and logged;
- user-visible recovery is possible.

### Maintenance is not UI work

Global notification demand recomputation, reachability bookkeeping, analytics, and similar maintenance must not execute before a menu can be shown unless the menu itself depends on the result.

### Measure structure, not flaky wall-clock tests

CI tests should assert ordering, call counts, and critical-path ownership. Production timings provide real latency numbers.

## Architecture

### 1. Introduce a callback acknowledgement helper

Add a focused helper module, for example:

```text
src/telegram-fast-ack.ts
```

It owns only callback acknowledgement policy.

Proposed interface:

```ts
export type CallbackAckPolicy = 'early-empty' | 'after-mutation';

export function startCallbackAck(
  env: TelegramBotEnv,
  callbackId: string,
  ctx: ExecutionContextLike,
  options?: { text?: string },
): Promise<void>;
```

The helper starts `answerCallbackQuery` immediately and registers the promise with `ctx.waitUntil()` when the route can safely continue without awaiting it.

It must swallow only callback-ack failures, matching current semantics. It must never swallow state mutation or screen-rendering failures.

### 2. Ack policy by callback family

#### Early empty acknowledgement

Use immediate acknowledgement for pure navigation and idempotent screen transitions, including representative:

- `prop:home`
- `prop:new`
- `prop:resume`
- `prop:back`
- `prop:results:*`
- `subs:center`
- notification dashboard/list/title navigation
- search screen navigation
- `subs:noop`

The callback spinner should disappear while D1 reads and `editMessageText` continue.

#### Immediate acknowledgement before mutation, then durable mutation

For reversible user settings such as subscription toggles, acknowledge immediately, then perform the mutation and update the message. If the mutation fails, log the error and send/edit an error state when practical. The existing message remains authoritative until the successful edit lands.

Representative:

- enable/disable title notification;
- set all-titles on/off;
- delivery-mode controls.

#### Keep correctness-critical acknowledgement after decision

Do not apply optimistic early acknowledgement to actions where the acknowledgement text itself must report the authoritative result or where the operation is security-sensitive, including:

- admin appeal approve/reject;
- Telegram ban/unban operations;
- destructive admin publication actions;
- other moderation actions where success/failure must be exact.

### 3. Remove global notification-demand recompute from navigation

`refreshAllNotificationDemand()` must not run for ordinary `subs:*` navigation.

New policy:

- pure navigation: no demand refresh;
- single-title subscription mutation: schedule `refreshTitleNotificationDemand(bookRef)` with `ctx.waitUntil()` after the durable subscription write;
- all-titles on/off: schedule `refreshAllNotificationDemand()` with `ctx.waitUntil()` after the durable setting mutation;
- notification reachability updates are bookkeeping and may be scheduled after successful interaction rather than blocking the menu;
- scanner correctness may lag by one short background task, which is acceptable because the user setting itself is already persisted.

This removes the most obviously inappropriate global D1 operation from the button critical path.

### 4. Fast `/start`

Current housekeeping remains semantically useful, but it should not delay starting the Telegram request.

After cached schema readiness:

```text
start Telegram sendMessage(root menu)
||
run independent D1 housekeeping
```

Housekeeping includes:

- upsert/touch Telegram user;
- set proposal input inactive;
- clear notification search;
- clear custom stack-size input.

Prefer one D1 `batch()` when the binding/type supports it. Otherwise use `Promise.all()` for independent statements.

The handler should await both the message promise and the correctness-relevant state-reset promise before returning, but the outbound Telegram request begins immediately rather than after the writes.

### 5. Parallel proposal callback prework

For claimed proposal callbacks:

1. start callback acknowledgement immediately according to policy;
2. ensure cached schema readiness;
3. batch/parallelize independent user-touch and notification-input cleanup;
4. perform only the session read/write needed by that callback;
5. edit the message;
6. do not call `answerCallbackQuery` a second time.

This removes the repeated serial pattern:

```text
upsert -> clear search -> clear custom -> business read -> business write -> edit -> ack
```

### 6. Notification UX prework

For notification callbacks:

- parse callback first;
- early-ack supported routes;
- schema readiness stays cached;
- user upsert/touch is not required before every read-only navigation click;
- clear unrelated proposal/custom-input state only when entering a mode that semantically cancels that input, and batch it where possible;
- navigation reads use `Promise.all()` when independent;
- mutation routes persist user choice before background demand refresh.

### 7. Legacy subscription handler cleanup

The older `handleTelegramSubscriptionUpdate()` remains for compatibility, but it must stop doing universal prework for every callback.

Move logic into route-specific branches:

```text
parse callback
-> noop: ack only
-> navigation: read/render only
-> title mutation: durable mutation + targeted background demand refresh
-> all mutation: durable mutation + global background demand refresh
```

Do not execute `refreshAllNotificationDemand()` merely because a user opened the notification center or paged through titles.

### 8. Telegram webhook-response optimization

Telegram allows Bot API method calls to be returned directly as the webhook HTTP response. This can remove one outbound request for selected acknowledgement-only cases.

Use this conservatively in v2:

- evaluate for callback routes where the webhook can immediately return an `answerCallbackQuery` method payload;
- schedule the actual D1/render work with `ctx.waitUntil()`;
- only use it when the remaining work is safe after the HTTP response and failure recovery is acceptable;
- keep the ordinary outbound Bot API helper as fallback.

The implementation plan must start with a focused compatibility test before adopting this path broadly. If it complicates correctness or testing, keep early concurrent outbound acknowledgement instead; v2 does not depend on webhook-response Bot API optimization to succeed.

### 9. D1 batching and parallelism

Use D1 `batch()` for multiple independent statements that always travel together when practical. Otherwise use `Promise.all()`.

Priority candidates:

- `/start` transient-state cleanup;
- proposal callback user-touch + transient-input cleanup;
- notification screen state cleanup;
- all-subscriptions deletion set.

Do not batch operations whose ordering or returned values are required by later statements.

### 10. Read replication is a measured follow-up, not a blind toggle

The account is Workers Paid, so D1 Read Replication/Sessions API can be considered for read-heavy catalog/list/search paths.

However user-specific mutable state requires read-after-write consistency. Therefore:

- do not enable replication for mutable proposal/session/subscription state as part of the first v2 code change;
- first deploy critical-path cleanup and stage timings;
- if production timings show D1 read latency remains dominant, add a separate measured change using Sessions API for read-only RanobeLib catalog/title/search queries.

This avoids introducing consistency complexity before proving it buys latency.

## Production timing instrumentation

Performance v1 logs total route duration. V2 adds coarse stages without logging sensitive content.

Suggested fields:

```text
route
kind
parse_ms
ack_started_ms
schema_ms
db_ms
telegram_ms
total_ms
```

Rules:

- no message text;
- no callback payload contents beyond normalized route/kind;
- no user IDs unless existing logging policy already permits it; default to none;
- no bot token or webhook secret;
- avoid per-query log spam.

If direct Cloudflare log inspection is unavailable to the development workflow, add a very low-rate sampled aggregate only if needed in a later observability PR; do not add D1 writes to every interaction just to measure performance.

## Error handling

### Early acknowledgement failure

Callback acknowledgement failure is non-fatal. Continue the actual action and log the failure.

### Background demand refresh failure

The user setting remains authoritative. Log the failure; the existing scheduled scanner/maintenance path can later reconcile demand. Never roll back a successfully persisted subscription merely because maintenance failed.

### Background navigation render failure

For routes moved fully under `waitUntil()`, catch the error and attempt a lightweight Telegram error message/edit when possible. Avoid silent stuck UI.

### Telegram edit failure

Preserve current handling for benign `message is not modified`. Other failures remain logged/propagated according to the handler's correctness requirements.

## Testing strategy

### Callback acknowledgement ordering

Tests must prove that supported callbacks start `answerCallbackQuery` before:

- D1 menu queries;
- global/targeted demand refresh;
- `editMessageText`.

Do not assert wall-clock milliseconds in CI.

### No global demand maintenance on navigation

Representative `subs:center`, list paging, and title-card navigation must execute zero `refreshAllNotificationDemand()` work.

### Mutation maintenance is deferred

Single-title toggles must persist the setting before scheduling targeted demand refresh. All-title mutations must persist before scheduling global refresh.

### `/start` concurrency

Use deferred mock promises to prove Telegram `sendMessage` is started before housekeeping completes while the handler still waits for required cleanup before returning.

### Proposal callback concurrency

Prove callback acknowledgement starts before independent cleanup and message editing, and that only one acknowledgement is sent.

### Security regression

Webhook secret remains fail-closed at the v1 outer dispatcher.

### Full regressions

Keep coverage for:

- `/start dl_*`;
- membership appeal priority;
- proposal draft resume/cancel/edit;
- notification search/custom input;
- subscription enable/disable;
- admin appeal approve/reject;
- reader gate/download paths.

## Rollout

1. Branch: `perf/telegram-latency-v2` from the current production `main`.
2. Write RED tests for callback ordering and removal of global demand refresh from navigation.
3. Implement fast callback acknowledgement helper.
4. Refactor notification/subscription callback critical paths.
5. Parallelize `/start` and proposal housekeeping.
6. Add stage timing fields.
7. Evaluate direct webhook Bot API response behind tests; keep only if simpler and safe.
8. Run local migrations, TypeScript, full tests, JS checks, and Wrangler dry-run.
9. Review the full diff for backgrounded correctness work and accidental unrelated changes.
10. Add unique marker `domnkr-build-20260909-telegram-perf2`.
11. Exact-head CI must be green with no blocking review threads.
12. Squash merge automatically to `main`.
13. Require post-merge main CI, Cloudflare Workers build, and production smoke for the v2 marker on the merge SHA.
14. Use new timing logs to decide whether a v2.1 D1 Read Replication experiment is justified.

## Success criteria

V2 is complete when all of the following are true:

1. supported callback families start acknowledgement before D1/render work;
2. notification navigation never runs `refreshAllNotificationDemand()`;
3. subscription mutations schedule demand maintenance after durable state writes instead of blocking the UI;
4. `/start` starts the Telegram root-menu request concurrently with independent housekeeping;
5. proposal callbacks no longer serialize user-touch, transient cleanup, edit, then acknowledgement;
6. no correctness-critical moderation/ban operation is made optimistic merely for speed;
7. stage-level production timing is available without sensitive data;
8. all existing tests remain green;
9. exact v2 production marker is confirmed after merge.
