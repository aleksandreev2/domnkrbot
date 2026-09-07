# Telegram Notifications v3 — Design

## Status

Approved in chat for implementation direction. This document freezes the architecture before the implementation plan is written.

## Goal

Reduce the time from a new chapter appearing on RanobeLib to a subscriber receiving a Telegram DM, while staying safely inside Cloudflare Workers Free, D1 Free, Cloudflare Queues Free, and Telegram Bot API limits.

Target behavior for active titles:

- discovery normally within 1–2 minutes;
- delivery starts immediately after discovery when Queue delivery is available;
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

Run approximately every 30–60 minutes.

### Behavior

- call the existing team catalog endpoint;
- upsert discovered titles into `ranobelib_titles`;
- mark no-longer-present team titles inactive using the existing semantics;
- do not fetch chapter lists for every discovered title in this job;
- preserve current title metadata and stable `book_ref` linkage.

### Failure behavior

A failed discovery must not immediately deactivate every existing title. Deactivation only occurs after a successful discovery response has been validated as non-empty, preserving the existing fail-safe behavior.

## 2. Fast chapter scanner

### Purpose

Check a small number of due titles frequently instead of checking a large circular batch infrequently.

### Schedule

Run every minute if the Free-plan cron budget permits; otherwise every two minutes. The initial implementation should use one-minute scheduling and a deliberately small scan batch.

### Data model

Add scheduler fields to `ranobelib_titles`:

- `next_check_at TEXT`;
- `last_change_at TEXT`;
- `consecutive_no_change INTEGER NOT NULL DEFAULT 0`;
- `scan_priority INTEGER NOT NULL DEFAULT 0`.

Add an index that allows cheap due-title selection, for example on `(is_active, next_check_at, scan_priority)`.

### Selection

The scanner selects only active, snapshot-ready titles whose `next_check_at <= now`, ordered by urgency. Initial safe batch: 5–8 titles per invocation.

### Adaptive cadence

After each title scan:

- new release detected: next check in ~1–2 minutes; reset no-change counter;
- recently active title: 3–5 minutes;
- normal active title: around 10 minutes;
- long-inactive title: progressively back off toward 20–30 minutes.

The cadence must be deterministic and testable. It must never become so aggressive that one cron invocation risks Cloudflare subrequest/D1 limits.

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

Remove the extra 0–60 second wait for the delivery cron after a release is discovered.

### Message granularity

Do not enqueue one Queue message per subscriber. Queue operations are charged per message, so that would waste the 10,000 operations/day Free allowance.

Use one compact wake-up message per release or drain request, for example:

```json
{"kind":"release-drain","releaseId":"..."}
```

The message is a signal, not the payload authority. The consumer always reads pending recipients from D1.

### Idempotency

Duplicate Queue wake-ups are harmless because D1 outbox status is authoritative and `(release_id, user_telegram_id)` is unique.

### Queue unavailable / send failure

Failure to enqueue a wake-up must never lose a notification. The pending D1 outbox remains untouched and the fallback cron will drain it later.

## 5. Telegram delivery worker

### Recipient query

Replace the current per-row `isEffectivelySubscribed()` calls with one delivery SELECT that only returns rows whose subscription is still effective.

The eligibility predicate must be expressed in SQL using `EXISTS` / `NOT EXISTS` or equivalent joins so one batch does not perform three extra D1 reads per recipient.

If a pending row is no longer eligible, clean it up in bounded bulk rather than issuing three reads for that user.

### Batch size

Choose a batch that fits comfortably within Workers Free subrequest and D1-query limits. Initial target: 20–25 recipients per invocation.

### Telegram concurrency

Send concurrently with a fixed concurrency of 4–6, never unbounded `Promise.all` over the full batch.

Keep effective broadcast throughput below Telegram's free ~30 messages/second limit. No paid broadcasts are required.

### Result persistence

Avoid one D1 `UPDATE` per recipient when possible.

Preferred design:

- collect successful `(release_id, user_id)` pairs;
- collect disabled pairs;
- collect retry pairs grouped by retry time where practical;
- persist results with bounded batch statements or compact updates, staying below D1 per-invocation limits.

If D1's 100-bound-parameter limit makes a single bulk statement awkward, split into small bounded chunks.

### Telegram errors

- `403`: mark recipient delivery disabled for that outbox item using existing semantics;
- `429`: parse Telegram `retry_after` when available and set `available_at` accordingly;
- other temporary errors: exponential/bounded backoff with jitter or the existing minute-based fallback, capped to a reasonable maximum;
- one failed user must not abort the entire batch.

## 6. Cron fallback

Retain a low-cost delivery cron even after Queue is introduced.

Purpose:

- drain pending outbox rows if Queue delivery was unavailable;
- recover from transient Queue consumer failures;
- recover delayed `retry` rows when `available_at` is reached.

Recommended cadence: every 5 minutes, unless Queue platform behavior during implementation shows a one-minute fallback is still cheap enough. Queue remains the normal fast path.

## 7. Membership access

Telegram `chat_member` webhook remains the primary realtime source for channel membership changes.

The periodic `getChatMember` reconciliation becomes a separate slow safety sweep rather than sharing the RanobeLib scanner invocation.

Recommended cadence: hourly, in a small bounded batch.

A Telegram/API failure must remain fail-open for punishment: never blacklist a user only because reconciliation could not contact Telegram.

## 8. Cron budget

Workers Free supports only five cron triggers per account. Notifications v3 must fit inside that budget.

Recommended allocation:

1. `* * * * *` — fast chapter scanner;
2. `*/30 * * * *` — team discovery;
3. `*/5 * * * *` — notification fallback drain;
4. `0 * * * *` — membership reconciliation.

One cron slot remains unused for future operational needs.

If Cloudflare treats overlapping cron expressions as separate invocations, routing must distinguish them explicitly and return after the selected job so unrelated jobs never share the same invocation.

## 9. Runtime boundaries

Create focused modules rather than expanding `live-entry-v2.ts` or `telegram-subscriptions.ts` indefinitely.

Suggested boundaries:

- `ranobelib-discovery-scheduler.ts` — slow team discovery;
- `ranobelib-fast-scanner.ts` — due-title selection and adaptive scheduling;
- `telegram-notification-delivery.ts` — outbox eligibility, batching, Telegram send/retry persistence;
- Queue consumer wiring in the Worker entrypoint;
- existing subscription UI/callback code remains in `telegram-subscriptions.ts`.

Shared Telegram formatting can stay in the current module or be extracted only if needed by the implementation. Avoid unrelated refactors.

## 10. Migration

Add a new forward-only migration after `0013`.

It should:

- add scheduler columns to `ranobelib_titles`;
- add scheduler indexes;
- recreate the notification fan-out trigger once, if trigger SQL must change;
- add any outbox indexes needed by the new eligibility/drain query.

No existing proposal/subscription/release data may be dropped or rewritten destructively.

## 11. Queue configuration

Add one Cloudflare Queue binding and consumer to Wrangler configuration.

The same Worker may act as producer and consumer if that keeps deployment simple. Queue messages must stay tiny and must not contain Telegram bot tokens, user profile data, or chapter content.

The implementation must remain operational without Queue delivery during local tests and must keep cron fallback as a production safety net.

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

- claimed/pending recipients;
- sent;
- retry;
- disabled;
- skipped because subscription changed;
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

- due-title selection ordering;
- 5–8 title batch cap;
- adaptive next-check calculation;
- release detection still uses existing detector semantics;
- failure backoff does not hot-loop a broken title.

### Discovery

- discovery no longer happens on every fast scan;
- valid discovery activates/upserts titles;
- invalid/empty failed discovery cannot mass-deactivate the catalog.

### Delivery

- one batch query can determine effective subscription without per-user subscription SELECTs;
- unsubscribed/excluded pending rows are skipped/cleaned;
- bounded Telegram concurrency;
- successful rows become sent;
- 403 becomes disabled;
- 429 respects `retry_after`;
- transient failures retry;
- duplicate Queue wake-up does not duplicate Telegram delivery.

### Scheduling/wiring

- fast scan, discovery, fallback drain and membership reconciliation route to separate cron branches;
- one branch returns before another job can run in the same invocation;
- Queue consumer invokes only delivery logic;
- outbox trigger is not recreated in the hot path.

### Regression

- all existing tests remain green;
- local D1 migrations pass;
- TypeScript typecheck passes;
- Wrangler dry-run passes with Queue bindings.

## 15. Rollout

1. Implement on `feat/telegram-notifications-v3`.
2. Keep existing D1 outbox and fallback delivery throughout migration.
3. Deploy migration before relying on scheduler columns.
4. Deploy Worker/Queue configuration.
5. Verify discovery and fast scanner logs before considering latency target achieved.
6. Verify a real release produces exactly one outbox fan-out and one DM per eligible subscriber.
7. Keep old notification cron path available until Queue consumer has been observed working in production.

## 16. Success criteria

Notifications v3 is ready when:

1. active titles are normally checked every 1–2 minutes after a release/change;
2. inactive titles back off automatically;
3. team discovery is no longer executed during every chapter scan;
4. membership reconciliation cannot consume the scanner's invocation budget;
5. delivery does not perform three subscription D1 queries per recipient;
6. delivery sends concurrently with an explicit bound;
7. Telegram 429 uses `retry_after`;
8. Queue wakes delivery immediately after a release;
9. D1 outbox + cron fallback prevents notification loss when Queue fails;
10. hot-path runtime does not recreate the D1 trigger;
11. every scheduled job fits Workers Free invocation/query/subrequest limits with headroom;
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
