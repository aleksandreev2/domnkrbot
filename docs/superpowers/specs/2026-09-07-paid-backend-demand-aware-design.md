# Paid Backend v1 — Demand-Aware Scheduler Design

## Status

Approved direction from chat. This spec is the first implementation slice of the broader Workers Paid modernization.

## Goal

Stop polling RanobeLib at high frequency when nobody can receive notifications, while making subscribed titles faster on Workers Paid and preserving current notification correctness.

## Principles

- D1 remains authoritative for subscriptions, releases, notification outbox, scheduler state and demand state.
- Cloudflare Queue remains a wake-up mechanism only.
- A title with at least one reachable effective subscriber is HOT.
- A title with zero reachable effective subscribers is IDLE and is still scanned slowly to keep snapshots current and prevent historical replay when demand returns.
- If every initialized title is IDLE, the one-minute fast cron performs only D1 work and makes no RanobeLib request.
- New/uninitialized titles are allowed through the fast scanner even with zero subscribers so the public catalog receives an initial snapshot promptly.
- A 0→1 demand transition immediately wakes the title by setting `next_check_at=CURRENT_TIMESTAMP`.
- A 1→0 demand transition moves the title to the slow IDLE cadence.
- Telegram 403 marks a user unreachable for demand counting. Any later private interaction with the subscription UI marks that user reachable again.
- Users with no reachability record are treated as reachable for backward compatibility.

## Data model

Forward migration `0015_paid_backend_demand_aware.sql` adds to `ranobelib_titles`:

- `notification_subscriber_count INTEGER NOT NULL DEFAULT 0`
- `subscriber_count_updated_at TEXT`

It also creates `telegram_delivery_reachability`:

- `user_telegram_id TEXT PRIMARY KEY`
- `state TEXT NOT NULL` with values `active` or `blocked`
- `blocked_at TEXT`
- `last_success_at TEXT`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

Indexes support active demand lookup and reachability lookup.

## Effective demand semantics

A user counts for a title when the user is reachable and either:

1. `telegram_subscription_settings.all_titles = 1` and there is no `title_subscription_exclusions` row for that title; or
2. `all_titles != 1` and there is a `title_subscriptions` row for that title.

A reachability row with `state='blocked'` excludes the user. Missing reachability rows count as reachable.

## Demand refresh

Create `src/notification-demand.ts` with focused functions:

- `refreshTitleNotificationDemand(env, bookRef)` — recompute one title.
- `refreshAllNotificationDemand(env)` — recompute all active titles in one bounded statement.
- `markTelegramUserReachable(env, userId)` — upsert active reachability.
- `markTelegramUserBlocked(env, userId)` — upsert blocked reachability.

Demand refresh updates `notification_subscriber_count` and `subscriber_count_updated_at`.

Transition handling is atomic inside the title update:

- old count 0, new count >0 → `next_check_at=CURRENT_TIMESTAMP`, boost `scan_priority`.
- old count >0, new count 0 → `next_check_at=datetime(CURRENT_TIMESTAMP, '+180 minutes')`.
- otherwise preserve normal scheduler timing.

Subscription mutations call title-scoped refresh for single-title toggles and full refresh for all-title toggles.

## Fast scanner

Workers Paid removes the old 50-subrequest constraint, but the Worker still has the platform connection limit, so external concurrency stays bounded.

- `FAST_SCAN_LIMIT = 24`
- RanobeLib scan concurrency = 4
- Fast selection includes:
  - any active `snapshot_ready=0` title that is due; or
  - any active title with `notification_subscriber_count > 0` that is due.
- Fast selection orders by overdue time first, then demand count and priority.
- If no row matches, no RanobeLib call occurs.

HOT cadence remains the existing v3 deterministic cadence: changed 1m, recent 2m/5m, quiet 10m/30m, failures 5/10/20/30m.

## Idle scanner

Add one paid-plan cron for slow baseline maintenance:

- `17 */3 * * *` — scan IDLE initialized titles.

Idle scanner:

- selects at most 24 active initialized titles with `notification_subscriber_count = 0` and due time reached;
- uses the same release detector and D1 release/outbox path;
- after a successful no-demand scan sets next check to 180 minutes;
- never replays historical chapters because snapshots continue to advance;
- if a title gains a subscriber, demand refresh wakes it immediately and the fast scanner takes over.

## Telegram reachability

Delivery behavior changes only for reachability bookkeeping:

- successful notification send marks the user active/reachable;
- Telegram 403 marks the user blocked, then demand counts are refreshed after the batch;
- 429 and transient errors do not change reachability.

A blocked user becomes active again when they interact with subscription callbacks/menu in a private chat.

## Compatibility

Must preserve:

- current all-title / explicit-title / exclusion semantics;
- current outbox trigger and unique `(release_id,user_telegram_id)` behavior;
- current claim lease and Queue/fallback race safety;
- current release detector semantics and bootstrap protection;
- current Telegram formatting and buttons;
- public catalog freshness through slow IDLE scans;
- membership-access behavior.

## Testing

Required RED→GREEN coverage:

- effective demand SQL excludes blocked users and respects all-title/exclusion/explicit semantics;
- 0→1 demand wakes a title immediately;
- 1→0 demand schedules 180-minute idle cadence;
- fast scanner ignores initialized zero-demand titles;
- fast scanner still bootstraps uninitialized zero-demand titles;
- fast batch cap is 24 and scan concurrency never exceeds 4;
- idle scanner selects only initialized zero-demand titles and schedules 180 minutes;
- global no-demand fast invocation makes zero RanobeLib fetches;
- Telegram 403 marks reachability blocked and triggers demand refresh;
- later private subscription interaction marks reachability active;
- all existing tests remain green;
- D1 local migrations, typecheck and Wrangler dry-run pass.

## Rollout

1. Apply migration 0015.
2. Deploy demand refresh + reachability code while keeping old scan cap initially test-driven in the same branch.
3. Enable paid scanner cap/concurrency and idle cron.
4. Verify production D1 counts and scanner logs.
5. Verify a zero-demand system performs no RanobeLib fetches on the minute fast cron.
6. Verify subscribing to a sleeping title wakes it on the next minute.
