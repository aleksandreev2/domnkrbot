# Telegram Webhook Performance v1 — Design

## Status

Approved in chat for implementation. Scope is interactive Telegram responsiveness only: ordinary commands, menu buttons/callbacks, proposal/notification navigation, appeal input, and other lightweight bot interactions. Heavy PDF/EPUB/R2 document transfer is explicitly not part of this pass.

## Goal

Reduce avoidable latency before the bot responds to ordinary Telegram updates without changing user-visible behavior, subscription semantics, proposal semantics, membership policy, or notification delivery semantics.

The optimization target is the request path from `POST /telegram/webhook` arrival until the responsible handler starts its actual business action and Telegram receives the first reply/edit/acknowledgement.

## Confirmed hot-path problems

The current production routing is layered:

```text
live-entry-v2.ts
  -> appeal / reader / publication handlers
  -> live-entry.ts
       -> membership / publication handlers
       -> entry.ts
            -> notification text input
            -> proposal v2
            -> proposal cabinet
            -> proposal legacy + alert preflight
            -> subscriptions
            -> base worker
```

Several handlers independently:

- check the same `/telegram/webhook` path and secret;
- clone and parse the same Telegram JSON body;
- inspect the same callback/message shape;
- execute D1 lookups before deciding the update belongs elsewhere.

Specific avoidable costs confirmed in current code:

1. `handleTelegramNotificationTextInputRequest()` executes notification schema repair plus proposal/search/input cleanup for every slash command, then returns `null` so the command is handled elsewhere.
2. `ensureTelegramNotificationSettingsSchema()` attempts `ALTER TABLE ... ADD COLUMN stack_size` and executes `CREATE TABLE/INDEX IF NOT EXISTS` statements whenever invoked.
3. `ensureTelegramTextBotUxSchema()` similarly attempts two `ALTER TABLE` statements and creates the notification-search table/index.
4. `handleChannelMembershipAppealWebhook()` inspects every private text message. The appeal lookup calls `ensureAppealSchema()`, which also performs schema DDL before checking whether the user has a draft appeal.
5. Ordinary callbacks traverse multiple unrelated handlers before reaching the handler whose callback prefix owns them.
6. Proposal admin alerts may be awaited after a successful user action even though they are best-effort side effects.

## Non-goals

This pass does not:

- redesign Telegram UX;
- add new bot features;
- change notification scanner cadence or Queue architecture;
- optimize R2 upload bandwidth or Telegram `sendDocument` throughput;
- remove runtime schema repair completely;
- rewrite every handler around a new framework;
- change database schema unless strictly necessary for performance instrumentation (the preferred design requires no migration);
- weaken Telegram webhook secret validation.

## Architecture

Performance v1 uses three complementary changes rather than a full rewrite.

### 1. Fast classification before expensive handlers

Introduce a small pure Telegram update classifier in a focused module, for example `src/telegram-webhook-routing.ts`.

It consumes already parsed update data and returns a route hint such as:

```ts
export type TelegramWebhookRoute =
  | 'chat-member'
  | 'download-start'
  | 'reader-gate'
  | 'membership-appeal'
  | 'proposal'
  | 'proposal-cabinet'
  | 'notifications'
  | 'generic-private-text'
  | 'other';
```

Classification is based only on update shape and stable callback/command prefixes:

- `chat_member` -> membership;
- `/start dl_<id>` -> reader/download flow;
- `gate-thanks:*` / `gate-download:*` -> reader gate;
- `membership:appeal*` -> appeals;
- `prop:*` and `/propose` -> proposal family;
- `subs:*`, `/notifications`, `/subscriptions`, and legacy `prop:notifications` -> notification family;
- ordinary private text remains generic because proposal/search/custom-input state may own it.

The classifier performs no D1, Telegram API, R2, or external HTTP work.

### 2. Eliminate unconditional schema/cleanup work from unrelated updates

Runtime schema repair remains as a defensive production fallback but becomes isolate-cached and is invoked only by flows that actually require that schema.

Required changes:

- cache notification settings schema initialization per D1 binding using `WeakMap<object, Promise<void>>` (matching patterns already used elsewhere in the repo);
- cache text-bot UX schema initialization per D1 binding the same way;
- cache appeal schema initialization per D1 binding;
- a schema promise resets only after failure, so a later request can retry;
- slash commands must not trigger notification input cleanup before their owning handler runs;
- `/start` and `/propose` should perform only the state reset they semantically require, once;
- ordinary callbacks that are not appeal callbacks must not call appeal D1 helpers;
- ordinary private text should query only lightweight state tables needed to resolve ownership, with no DDL after schema warm-up.

Runtime repair is a safety net, not normal request work.

### 3. Route by ownership before entering unrelated handler chains

`live-entry-v2.ts` becomes the earliest Telegram-specific dispatcher while preserving the existing web/API fallback structure.

For `POST /telegram/webhook`:

1. verify the configured secret once at the outer boundary;
2. parse JSON once;
3. classify the update;
4. invoke only the handler family that can own that class, except for `generic-private-text`, where a short ordered list of stateful text consumers remains necessary;
5. fall back to existing compatibility routing only for truly unclassified/legacy cases.

To avoid a risky all-at-once rewrite, existing handlers remain callable with `Request`. The router may create one replayable request from the already buffered body for compatibility in v1. The important guarantee is that unrelated handlers are skipped; parsing every handler can be eliminated incrementally where practical.

The v1 implementation must not require changing every handler signature.

## Stateful private text priority

Ordinary non-command private text can legitimately belong to more than one feature. Preserve current priority:

1. membership appeal draft;
2. notification custom stack input;
3. notification search input;
4. proposal draft input;
5. generic acknowledgement/fallback.

This path may perform D1 reads, but it must not run schema DDL on every request. Queries should be indexed point lookups by `user_telegram_id`.

## Fast acknowledgement and side effects

User-visible response work remains awaited when it is the actual action (for example Telegram `editMessageText`). Best-effort secondary work should use `ctx.waitUntil()` where an execution context is available.

Candidate side effects:

- proposal admin alert after a proposal has already been successfully created;
- non-critical analytics/event recording that is not required to decide the response.

Do not move correctness-critical writes into the background. In particular:

- proposal/session mutations that determine the next screen remain awaited;
- membership blacklist/ban enforcement remains correctness-critical;
- appeal decision persistence remains awaited;
- subscription setting mutations remain awaited.

## Observability

Add compact timing logs at the outer Telegram webhook dispatcher.

Example shape:

```ts
console.log('Telegram webhook handled', {
  route,
  updateKind,
  durationMs: Date.now() - startedAt,
});
```

Requirements:

- one success summary per handled webhook, not one log per internal query;
- include route and duration;
- never log Telegram webhook secrets, bot token, full message text, full callback payloads containing user content, or uploaded file data;
- errors retain existing focused logs.

The timing log exists so later passes can target measured residual latency rather than guess.

## Performance regression tests

Tests must prove avoided work, not assert wall-clock timing in GitHub Actions.

Required behavioral/performance-budget tests:

### `/start`

- reaches the proposal/root-menu handler without notification settings schema DDL;
- does not run duplicate notification search/custom-input cleanup in the pre-handler;
- produces the same root menu response as before.

### Notification callback

For `subs:center`:

- unrelated appeal/proposal/download handlers are not entered;
- no appeal lookup/schema DDL occurs;
- notification handler behavior stays unchanged.

### Proposal callback

For representative `prop:new` / proposal navigation callback:

- unrelated notification state handlers do not perform D1 work before proposal routing;
- proposal behavior stays unchanged.

### Ordinary private text

- appeal lookup remains first when a draft appeal exists;
- when no appeal exists, the path proceeds to notification/proposal state ownership without appeal DDL;
- slash commands bypass the generic text-state chain.

### Schema cache

For notification settings, text-bot UX, and appeals:

- two calls in the same isolate/D1 binding execute DDL only once;
- a failed initialization clears the cached promise so the next call retries;
- separate DB binding objects do not incorrectly share initialization state.

### Security/regression

- missing/mismatched webhook secret remains fail-closed at the outer route;
- `chat_member` membership handling still works;
- `/start dl_*` still reaches download membership/delivery flow;
- `gate-thanks:*` still returns quickly using `ctx.waitUntil()` behavior;
- all existing repository tests remain green.

## Expected impact

The main expected gain is removal of multiple sequential D1 round trips and DDL attempts before ordinary interactions. This should be most visible for `/start`, menu navigation, notification settings, proposal navigation, and plain-text input.

No fixed millisecond SLA is claimed before production timing data exists. Success is defined structurally first: one owner route, no unrelated DDL, no duplicate state cleanup, and measured route-duration logs in production.

## Rollout

1. Implement on `perf/telegram-webhook-hot-path-v1`.
2. Add regression tests before production changes.
3. Introduce schema initialization caches first.
4. Remove slash-command notification pre-cleanup.
5. Add/update fast route classification and dispatch.
6. Move only best-effort post-success side effects to `waitUntil()`.
7. Run migrations locally even though no new migration is expected.
8. Run TypeScript, website JS syntax checks, full test suite, and Wrangler dry-run.
9. Review exact PR diff for changed routing semantics/security.
10. Add a unique production build marker for this performance release.
11. Merge only when exact PR head CI is green.
12. Require post-merge CI and production smoke for the merge SHA before calling the optimization live.

## Success criteria

Performance v1 is complete when:

1. ordinary slash commands do not invoke notification settings schema repair before their owner handler;
2. schema fallback DDL for notification settings, text-bot UX, and appeals runs at most once per warm isolate/DB binding after success;
3. `subs:*` callbacks skip unrelated appeal/proposal/download DB work;
4. `prop:*` callbacks skip unrelated notification/appeal DB work where ownership is explicit;
5. ordinary text preserves the existing state-consumer priority without repeated DDL;
6. Telegram webhook secret validation is not weakened;
7. proposal admin alerts do not extend the successful user-response critical path when an execution context is available;
8. production emits route-level duration logs without sensitive message content;
9. all existing behavior/regression tests remain green;
10. the exact performance build is confirmed in production with a unique marker.
