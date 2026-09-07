# Telegram Notifications v3 — Design

## Status

Approved in chat for implementation direction. This document freezes the architecture before the implementation plan is written.

## Goal

Reduce the time from a new chapter appearing on RanobeLib to a subscriber receiving a Telegram DM, while staying safely inside Cloudflare Workers Free, D1 Free, Cloudflare Queues Free, and Telegram Bot API limits.

Target behavior for active titles:

- a newly active title is normally checked again within 1–2 minutes;
- delivery starts immediately after release detection when Queue delivery is available;
- cron fallback keeps notifications deliverable if Queue delivery is unavailable;
- no duplicate notifications;
- no regression to existing subscriptions, exclusions, notification controls, release aggregation, scheduled-chapter recovery, or membership access.

## Current bottlenecks

The existing v2 pipeline is reliable but inefficient on the Free plan:

1. RanobeLib sync runs every 10 minutes.
2. Each sync rediscovers the team's entire title list.
3. Only up to 40 titles are processed per sync using a circular cursor.
4. Membership reconciliation and RanobeLib sync share the same scheduled invocation.
5. Notification delivery runs every minute but re-checks effective subscription with multiple D1 queries for each outbox row.
6. Delivery is sequential.
7. Runtime schema initialization recreates the release trigger in the hot path.

With more than 40 active titles, the effective chapter polling interval grows with the number of titles. The shared cron and per-user D1 checks also conflict with Workers Free limits.

## Platform constraints

The design assumes the current Workers Free constraints verified on 2026-09-07:

- 50 external subrequests per Worker invocation;
- 6 simultaneous outgoing connections per invocation;
- 50 D1 queries per Worker invocation on Free;
- 5 Cron Triggers per account on Workers Free;
- Cloudflare Queues Free: 10,000 operations/day and 24-hour retention;
- Telegram free bulk broadcast: about 30 messages/second.

The implementation must retain safety headroom rather than operating exactly at these ceilings.

## Architecture

Notifications v3 separates four independent jobs:

```text
Team discovery (slow)
        ↓
D1 active title catalog
        ↓
Fast chapter scanner
        ↓
ranobelib_releases + notification outbox
        ↓
Queue wake-up ───────────────┐
        ↓                    │
Telegram delivery consumer  │
        ↓                    │
Telegram                    │
                             │
Cron fallback ───────────────┘

Membership webhook → realtime membership state
Membership reconciliation → slow safety sweep
```

The existing `ranobelib_releases` and `ranobelib_notification_outbox` remain authoritative. Queues do not replace the outbox and do not become the source of truth; they only wake the delivery worker quickly.

## 1. Team discovery

### Purpose

Keep the set of active Dom Nekromanta RanobeLib titles up to date without paying the cost of full team discovery during every chapter scan.

### Schedule

Run every 30 minutes.

### Behavior

- call the existing team catalog endpoint;
- upsert discovered titles into `ranobelib_titles`;
- mark no-longer-present team titles inactive using the existing semantics;
- do not fetch chapter lists for every discovered title in this job;
- preserve current title metadata and stable `book_ref` linkage;
- newly discovered titles receive `next_check_at = CURRENT_TIMESTAMP` so the fast scanner initializes them promptly.

### Failure behavior

A failed discovery must not immediately deactivate every existing title. Deactivation only occurs after a successful discovery response has been validated as non-empty, preserving the existing fail-safe behavior.

## 2. Fast chapter scanner

### Purpose

Check a small number of due titles frequently instead of checking a large circular batch infrequently.

### Schedule

Run every minute.

### Data model

Add scheduler fields to `ranobelib_titles`:

- `next_check_at TEXT`;
- `last_change_at TEXT`;
- `consecutive_no_change INTEGER NOT NULL DEFAULT 0`;
- `consecutive_failures INTEGER NOT NULL DEFAULT 0`;
- `scan_priority INTEGER NOT NULL DEFAULT 0`.

Add an index for due-title selection on `(is_active, snapshot_ready, next_check_at, scan_priority)`.

### Selection

The scanner selects at most **6** active titles that are due:

```sql
WHERE is_active = 1
  AND (snapshot_ready = 0 OR next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP)
ORDER BY COALESCE(next_check_at, '') ASC, scan_priority DESC
LIMIT 6
```

This prioritizes the most overdue title first and uses `scan_priority` only as a tie-breaker. New/uninitialized titles are eligible immediately.

### Adaptive cadence

Cadence is deterministic:

- release detected: `last_change_at = now`, `consecutive_no_change = 0`, `consecutive_failures = 0`, next check in **1 minute**;
- no release, but `last_change_at` is within 15 minutes: next check in **2 minutes**;
- no release, but `last_change_at` is within 2 hours: next check in **5 minutes**;
- otherwise after a successful no-change scan: increment `consecutive_no_change`; values 1–2 → **10 minutes**, values 3+ → **30 minutes**;
- scan failure: increment `consecutive_failures`, keep release/no-change state unchanged, and back off for `min(30, 5 * 2^(failures-1))` minutes: 5, 10, 20, then 30 minutes capped.

Any successful scan resets `consecutive_failures` to 0. A release resets `consecutive_no_change` to 0.

### Chapter detection

Reuse the existing release detector, including:

- normal added-chapter detection;
- scheduled-release transition recovery;
- recent bootstrap recovery;
- aggregation of multiple newly visible chapters into one release row.

Do not change the semantic definition of a release in this project.

## 3. Notification outbox

`ranobelib_notification_outbox` stays the durable source of pending delivery.

The existing D1 trigger remains responsible for fan-out when a new release row is inserted. Runtime code must no longer `DROP TRIGGER` / `CREATE TRIGGER` during ordinary hot-path execution. Trigger creation/changes belong in a forward migration.

The trigger continues to apply v2 subscription semantics:

```text
(all_titles = 1 AND not excluded)
OR
(all_titles = 0 AND explicit subscription exists)
```

## 4. Queue wake-up

### Purpose

Remove the extra 0–60 second wait for the delivery cron after a release is detected.

### Message granularity

Do not enqueue one Queue message per subscriber or per outbox row.

The fast scanner sends **one** compact wake-up message if its invocation created at least one release:

```json
{"kind":"drain"}
```

The message contains no user/title data. It is only a signal. The consumer reads pending recipients from D1.

### Continuation

The Queue consumer drains one bounded delivery batch. If the delivery query reports that more due rows remain, it enqueues one new `{"kind":"drain"}` continuation message. This creates a controlled chain of small Worker invocations instead of one oversized invocation.

### Idempotency

Duplicate Queue wake-ups are harmless because D1 outbox status is authoritative and `(release_id, user_telegram_id)` is unique.

### Queue unavailable / send failure

Failure to enqueue a wake-up must never lose a notification. The pending D1 outbox remains untouched and the fallback cron will drain it later.

## 5. Telegram delivery worker

### Recipient query

Replace the current per-row `isEffectivelySubscribed()` calls with a delivery query that determines effective subscription in SQL.

The query must return:

- due and still-eligible rows for sending;
- enough information to identify due rows that are no longer eligible so they can be cleaned in bounded bulk.

The effective predicate is expressed using `EXISTS` / `NOT EXISTS` or equivalent joins so the worker does not perform three subscription reads per recipient.

### Batch size

Each delivery invocation processes at most **20** Telegram recipients. This leaves headroom below the Workers Free 50-subrequest limit for Queue continuation and error handling.

### Telegram concurrency

Send with fixed concurrency **5**, never an unbounded `Promise.all` over the full batch.

The worker must also pace starts so aggregate free broadcast throughput stays below **25 messages/second**, leaving margin under Telegram's approximate 30 messages/second bulk limit.

### Result persistence

Avoid one D1 `UPDATE` per recipient when possible.

Preferred design:

- collect successful `(release_id, user_id)` pairs;
- collect disabled pairs;
- collect retry pairs with their next `available_at`;
- persist results with D1 `batch()` or compact bounded update statements;
- split statements before D1's bound-parameter limit is reached.

A delivery invocation must stay below 50 D1 queries with headroom.

### Telegram errors

- `403`: mark that outbox delivery `disabled`;
- `429`: parse Telegram `parameters.retry_after` and set `available_at` to that delay (minimum 1 second, capped defensively at 1 hour); if Telegram omits `retry_after`, fall back to the normal temporary-error backoff;
- other temporary errors: increment attempts and retry after `min(30, max(1, attempts + 1))` minutes;
- one failed user must not abort the entire batch.

### More-work signal

The delivery function returns `hasMoreDue`. Queue consumer re-enqueues `drain` when true. Cron fallback simply ends and lets the next cron invocation continue.

## 6. Cron fallback

Retain a low-cost delivery cron even after Queue is introduced.

Schedule: every **5 minutes**.

Purpose:

- drain pending outbox rows if Queue delivery was unavailable;
- recover from transient Queue consumer failures;
- recover delayed `retry` rows when `available_at` is reached.

Queue remains the normal fast path.

## 7. Membership access

Telegram `chat_member` webhook remains the primary realtime source for channel membership changes.

The periodic `getChatMember` reconciliation becomes a separate slow safety sweep rather than sharing the RanobeLib scanner invocation.

Schedule: **hourly**, with the existing bounded batch of at most 40 monitored users. Since this invocation does no RanobeLib sync or notification sending, it remains below the 50 external-subrequest limit.

A Telegram/API failure must remain fail-open for punishment: never blacklist a user only because reconciliation could not contact Telegram.

## 8. Cron budget

Workers Free supports only five cron triggers per account. Notifications v3 uses four:

1. `* * * * *` — fast chapter scanner;
2. `*/30 * * * *` — team discovery;
3. `*/5 * * * *` — notification fallback drain;
4. `0 * * * *` — membership reconciliation.

One cron slot remains unused for future operational needs.

Routing must distinguish cron strings explicitly and **return after the selected job** so unrelated jobs never share one invocation, including at minute `00` when all four schedules may fire independently.

## 9. Runtime boundaries

Create focused modules rather than expanding `live-entry-v2.ts` or `telegram-subscriptions.ts` indefinitely.

Suggested boundaries:

- `ranobelib-discovery-scheduler.ts` — slow team discovery;
- `ranobelib-fast-scanner.ts` — due-title selection and adaptive scheduling;
- `telegram-notification-delivery.ts` — outbox eligibility, batching, Telegram send/retry persistence;
- Queue consumer wiring in the Worker entrypoint;
- existing subscription UI/callback code remains in `telegram-subscriptions.ts`.

Shared Telegram release formatting can remain in `telegram-subscriptions.ts` initially. Extract it only if imports become cyclic or tests become awkward. Avoid unrelated refactors.

## 10. Migration

Add forward-only migration `0014_telegram_notifications_v3.sql`.

It should:

- add the five scheduler columns to `ranobelib_titles`;
- initialize `next_check_at` for existing active titles so they enter the scanner gradually/consistently;
- add scheduler and outbox drain indexes;
- recreate the notification fan-out trigger once if trigger SQL must be normalized;
- preserve every existing subscription, exclusion, release, proposal, and outbox row.

No destructive table rebuild is allowed in v3 unless SQLite/D1 makes a specific required schema change impossible otherwise; if that becomes necessary, stop and revise the spec before implementation.

## 11. Queue configuration

Add one Cloudflare Queue binding and consumer to Wrangler configuration.

The same Worker acts as producer and consumer to keep deployment simple. Queue messages remain tiny and contain no Telegram bot token, user profile data, chapter content, or release metadata.

The implementation must remain operational without Queue delivery during local unit tests and must keep cron fallback as a production safety net.

## 12. Observability

Each job logs one compact structured summary rather than one log per recipient/title unless an error occurs.

Useful metrics:

### Scanner

- selected titles;
- successful scans;
- failed scans;
- releases detected;
- oldest due-title lateness;
- external RanobeLib request count.

### Delivery

- selected recipients;
- sent;
- retry;
- disabled;
- skipped because subscription changed;
- `hasMoreDue`;
- batch duration;
- Telegram 429 count.

### Discovery / membership

- discovered titles / activated / deactivated;
- membership checked / blacklisted / API failures.

Do not add a large analytics subsystem in v3; logs plus the existing D1 state are enough.

## 13. Compatibility

Must preserve:

- `/notifications` and `/subscriptions` UX;
- all-title and per-title subscription semantics;
- exclusions;
- release message format and buttons unless a small compatibility fix is necessary;
- existing RanobeLib title/release APIs;
- scheduled release handling;
- current Telegram webhook security;
- publication workflow;
- proposal workflow;
- channel-membership safety behavior.

## 14. Testing

Required tests include:

### Scheduler

- due-title selection ordering and exact six-title cap;
- exact adaptive next-check calculation;
- release detection still uses existing detector semantics;
- failure backoff does not hot-loop a broken title;
- successful scans reset failure count.

### Discovery

- discovery no longer happens on every fast scan;
- valid discovery activates/upserts titles;
- newly discovered titles become immediately scannable;
- invalid/empty failed discovery cannot mass-deactivate the catalog.

### Delivery

- one bounded query/batch determines effective subscriptions without per-user subscription SELECTs;
- unsubscribed/excluded pending rows are skipped/cleaned;
- batch cap is 20;
- Telegram concurrency is bounded at 5;
- successful rows become sent;
- 403 becomes disabled;
- 429 respects `retry_after`;
- transient failures retry;
- `hasMoreDue` causes one continuation wake-up;
- duplicate Queue wake-up does not duplicate Telegram delivery.

### Scheduling/wiring

- fast scan, discovery, fallback drain and membership reconciliation route to separate cron branches;
- one branch returns before another job can run in the same invocation;
- Queue consumer invokes only delivery logic;
- outbox trigger is not recreated in the hot path;
- Wrangler declares exactly the intended Queue producer/consumer and four cron schedules.

### Regression

- all existing tests remain green;
- local D1 migrations pass;
- TypeScript typecheck passes;
- Wrangler dry-run passes with Queue bindings.

## 15. Rollout

1. Implement on `feat/telegram-notifications-v3`.
2. Keep existing D1 outbox throughout migration.
3. Apply migration `0014` before relying on scheduler columns.
4. Deploy Worker/Queue configuration.
5. Verify discovery and fast scanner logs before considering latency target achieved.
6. Verify a real release creates one durable fan-out and exactly one DM per eligible subscriber.
7. Verify Queue drain chaining on a test backlog larger than 20 recipients.
8. Keep the 5-minute fallback drain permanently; it is part of the reliability design, not temporary scaffolding.

## 16. Success criteria

Notifications v3 is ready when:

1. a title that has just released a chapter is checked again after 1 minute and stays on a 1–2 minute hot cadence for the first 15 minutes without another release;
2. quiet titles back off deterministically to 10/30-minute checks;
3. team discovery is no longer executed during every chapter scan;
4. membership reconciliation cannot consume the scanner's invocation budget;
5. delivery performs no per-recipient three-query effective-subscription check;
6. each delivery invocation sends at most 20 DMs with concurrency 5 and pacing below 25 starts/second;
7. Telegram 429 uses `retry_after` when provided;
8. one Queue wake-up starts immediate D1 outbox draining and continuation wake-ups handle backlogs;
9. D1 outbox + 5-minute cron fallback prevents notification loss when Queue fails;
10. hot-path runtime does not recreate the D1 trigger;
11. every scheduled/Queue invocation fits Workers Free query/subrequest limits with headroom;
12. the existing Telegram subscription UX remains compatible;
13. the complete repository CI is green.

## Out of scope

- paid Telegram broadcasts;
- quiet hours;
- daily/weekly digest modes;
- per-user delivery priority tiers;
- replacing D1 outbox with Queue-only delivery;
- scraping RanobeLib HTML;
- polling every title every minute regardless of activity;
- changing translation/publication workflows unrelated to release notifications.
