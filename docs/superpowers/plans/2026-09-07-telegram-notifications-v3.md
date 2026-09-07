# Telegram Notifications v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce new-chapter notification latency to roughly 1–2 minutes for active titles while keeping each Cloudflare Workers Free invocation safely below external-subrequest and D1-query limits.

**Architecture:** Split the current shared ten-minute job into four isolated jobs: slow team discovery, one-minute due-title scanning, Queue-triggered Telegram delivery with a D1 outbox as source of truth, and hourly membership reconciliation. Keep the existing release detector and subscription semantics, but replace per-recipient subscription reads with a single eligibility query and bounded-concurrency delivery.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Cloudflare Queues, Cron Triggers, Telegram Bot API, RanobeLib public API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-07-telegram-notifications-v3-design.md`

## Global Constraints

- Workers Free: preserve headroom below 50 external subrequests and 50 D1 queries per invocation.
- At most 6 simultaneous outgoing connections; Telegram delivery concurrency is fixed at 5.
- Fast scanner batch is fixed at 6 due titles per invocation.
- Telegram delivery batch is fixed at 20 recipients per invocation.
- Queue messages are wake-up signals only; D1 outbox remains authoritative.
- Queue failure must never lose notifications; five-minute cron fallback must remain.
- Existing release detection semantics, subscriptions, exclusions, proposal flow, publication flow, and membership fail-open behavior must remain compatible.
- New schema changes are forward-only and must not drop user/release/proposal data.

---

### Task 1: Scheduler schema and deterministic cadence

**Files:**
- Create: `migrations/0014_telegram_notifications_v3.sql`
- Create: `src/ranobelib-fast-scanner.ts`
- Create: `tests/ranobelib-fast-scanner.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `FAST_SCAN_LIMIT = 6`.
- Produces: `computeNextCheckDelayMinutes(input: { changed: boolean; consecutiveNoChange: number; lastChangeAt?: string | null; failed?: boolean }): number`.
- Produces: `selectDueTitles(env, limit?: number): Promise<DueTitle[]>`.
- Migration adds `next_check_at`, `last_change_at`, `consecutive_no_change`, `scan_priority`, and due-title index.

- [ ] **Step 1: Write failing scheduler tests**

Cover exact cadence and batch cap:

```js
assert.equal(computeNextCheckDelayMinutes({ changed: true, consecutiveNoChange: 9 }), 1);
assert.equal(computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 1 }), 3);
assert.equal(computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 4 }), 10);
assert.equal(computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 8 }), 20);
assert.equal(computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 20 }), 30);
assert.equal(computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, failed: true }), 10);
```

The D1 fake must assert a due-title query containing `is_active = 1`, `snapshot_ready = 1`, `next_check_at`, deterministic ordering by due time/priority, and `LIMIT 6`.

- [ ] **Step 2: Add the test to the runtime build/test script and run CI**

Expected: RED because `ranobelib-fast-scanner.ts` and migration do not exist.

- [ ] **Step 3: Implement migration and pure scheduler primitives**

Migration SQL:

```sql
ALTER TABLE ranobelib_titles ADD COLUMN next_check_at TEXT;
ALTER TABLE ranobelib_titles ADD COLUMN last_change_at TEXT;
ALTER TABLE ranobelib_titles ADD COLUMN consecutive_no_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ranobelib_titles ADD COLUMN scan_priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_due_scan
ON ranobelib_titles(is_active, snapshot_ready, next_check_at, scan_priority);

CREATE INDEX IF NOT EXISTS idx_ranobelib_notification_due_v3
ON ranobelib_notification_outbox(status, available_at, release_id, user_telegram_id);
```

Cadence implementation is deterministic: changed=1 minute; first 1–2 misses=3 minutes; 3–5 misses=10; 6–11 misses=20; 12+=30; scanner failure=10.

- [ ] **Step 4: Run focused and full tests**

Run `npm test` through CI. Expected: PASS.

- [ ] **Step 5: Commit**

`feat: add adaptive notification scanner schedule`

---

### Task 2: Split team discovery from chapter scanning

**Files:**
- Create: `src/ranobelib-discovery-scheduler.ts`
- Modify: `src/ranobelib-runtime.ts`
- Modify: `src/ranobelib-fast-scanner.ts`
- Create: `tests/ranobelib-discovery-scheduler.test.mjs`
- Extend: `tests/ranobelib-fast-scanner.test.mjs`

**Interfaces:**
- Produces: `discoverRanobeLibTeam(env): Promise<{ discovered: number; activated: number; deactivated: number }>` that performs team discovery/upserts only.
- Produces: `scanDueRanobeLibTitles(env, options?: { limit?: number; now?: Date; onRelease?: (releaseId: string) => Promise<void> }): Promise<FastScanResult>`.
- Reuses existing `RanobeLibClient.getChapters`, `detectReleaseDelta`, `detectScheduledReleaseTransitions`, `detectRecentBootstrapReleaseCandidates`.

- [ ] **Step 1: Write failing discovery isolation tests**

Tests must prove:

```js
await discoverRanobeLibTeam(env);
assert.equal(getChaptersCalls, 0);
```

and an empty/invalid discovery response cannot execute mass deactivation.

- [ ] **Step 2: Write failing scanner tests**

The scanner must load at most six due titles from D1, call `getChapters` only for those titles, create the same release-row shape as existing `syncBook`, and update scheduler fields after each title.

- [ ] **Step 3: Run RED CI**

Expected: only new v3 tests fail.

- [ ] **Step 4: Extract discovery logic from `syncRanobeLib` without changing legacy public behavior**

`syncRanobeLib()` remains available for manual/admin compatibility, but scheduled v3 paths call the new discovery/scanner functions directly. Discovery validates a non-empty result before `UPDATE ranobelib_titles SET is_active = 0`.

- [ ] **Step 5: Implement due-title scan using the existing detector semantics**

For each selected title:

1. load stored chapter snapshot;
2. fetch current chapter list;
3. calculate added/scheduled/bootstrap release candidates with existing detector functions;
4. insert/delete chapter rows as current runtime does;
5. insert an idempotent `ranobelib_releases` row;
6. update title metadata plus scheduler fields;
7. call `onRelease(releaseId)` only when the insert actually created a new release.

- [ ] **Step 6: Run focused/full CI and commit**

`feat: split RanobeLib discovery and fast scanning`

---

### Task 3: Low-query Telegram delivery engine

**Files:**
- Create: `src/telegram-notification-delivery.ts`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-subscription-delivery-schema.ts`
- Create: `tests/telegram-notification-delivery-v3.test.mjs`

**Interfaces:**
- Produces: `DELIVERY_BATCH_LIMIT = 20` and `TELEGRAM_SEND_CONCURRENCY = 5`.
- Produces: `drainNotificationOutbox(env, options?: { limit?: number; releaseId?: string }): Promise<DeliveryResult>`.
- `DeliveryResult` contains `claimed`, `sent`, `retry`, `disabled`, `skipped`, `rateLimited`.
- Existing formatter `formatReleaseNotification()` remains authoritative for message text/buttons.

- [ ] **Step 1: Write failing SQL-shape tests**

The delivery SELECT must determine eligibility in SQL using subscription/exclusion `EXISTS` predicates. The fake DB should fail the test if delivery invokes `SELECT ... telegram_subscription_settings WHERE user_telegram_id = ?` once per outbox row.

- [ ] **Step 2: Write failing concurrency/error tests**

Use a mocked Telegram fetch that records active sends and assert `maxActive <= 5` for a 20-recipient batch.

Mock error bodies:

```json
{"ok":false,"error_code":403,"description":"Forbidden"}
```

and

```json
{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":17}}
```

Assert 403 -> `disabled`; 429 -> `retry` with an update that schedules approximately +17 seconds instead of the old generic minute backoff.

- [ ] **Step 3: Run RED CI**

Expected: new delivery tests fail while v2 tests remain green.

- [ ] **Step 4: Implement one eligibility query and bounded concurrent sender**

Query pending/retry rows joined to releases/titles and retain a row only when:

```sql
EXISTS (
  SELECT 1 FROM telegram_subscription_settings s
  WHERE s.user_telegram_id = o.user_telegram_id
    AND s.all_titles = 1
    AND NOT EXISTS (
      SELECT 1 FROM title_subscription_exclusions e
      WHERE e.user_telegram_id = o.user_telegram_id
        AND e.book_ref = r.book_ref
    )
)
OR EXISTS (
  SELECT 1 FROM title_subscriptions ts
  WHERE ts.user_telegram_id = o.user_telegram_id
    AND ts.book_ref = r.book_ref
    AND NOT EXISTS (
      SELECT 1 FROM telegram_subscription_settings s2
      WHERE s2.user_telegram_id = o.user_telegram_id AND s2.all_titles = 1
    )
)
```

Send through a five-worker promise pool, not unbounded `Promise.all`.

- [ ] **Step 5: Persist outcomes in bounded D1 batches**

Use `env.DB.batch` when available with no more than roughly 20 result statements; otherwise run the same bounded statements sequentially. This keeps the invocation below the D1-query cap and removes three per-user subscription reads.

- [ ] **Step 6: Remove hot-path trigger recreation**

`ensureTelegramSubscriptionDeliverySchema()` may ensure ordinary table/column compatibility, but must not execute `DROP TRIGGER` or `CREATE TRIGGER` during delivery. The persistent trigger remains migration-owned.

- [ ] **Step 7: Run full CI and commit**

`feat: optimize Telegram notification delivery`

---

### Task 4: Queue wake-up and isolated cron routing

**Files:**
- Modify: `src/live-entry-v2.ts`
- Modify: `wrangler.jsonc`
- Create: `tests/telegram-notification-v3-wiring.test.mjs`
- Modify: `tests/telegram-notification-schedule.test.mjs`

**Interfaces:**
- Env gains optional Queue producer binding `NOTIFICATION_QUEUE` with `send(message: NotificationWakeup): Promise<void>`.
- Worker gains `queue(batch, env, ctx)` consumer handler.
- Queue message: `{ kind: 'drain'; releaseId?: string }`.

- [ ] **Step 1: Write failing wiring tests**

Assert exact cron allocation exists:

```text
* * * * *
*/30 * * * *
*/5 * * * *
0 * * * *
```

and each `scheduled()` branch calls exactly one job then returns.

Assert Wrangler defines one Queue producer and consumer binding for the same queue.

- [ ] **Step 2: Write failing Queue tests**

Queue consumer must call `drainNotificationOutbox(env, { limit: 20, releaseId })`. If pending work remains, it may enqueue one continuation `{kind:'drain'}`; duplicate wakeups must still send each outbox row only once because D1 status is authoritative.

- [ ] **Step 3: Run RED CI**

Expected: wiring tests fail before implementation.

- [ ] **Step 4: Implement scheduled routing**

Routes:

- `* * * * *` -> `scanDueRanobeLibTitles(... onRelease => queueWakeup())`;
- `*/30 * * * *` -> `discoverRanobeLibTeam()`;
- `*/5 * * * *` -> `drainNotificationOutbox(env, { limit: 20 })`;
- `0 * * * *` -> `runChannelMembershipMaintenance(env, 20)`.

Every branch returns immediately after its job; no membership/discovery/scanner/delivery work shares an invocation.

- [ ] **Step 5: Implement Queue fallback semantics**

`onRelease` attempts `NOTIFICATION_QUEUE.send({kind:'drain', releaseId})` and logs failure without touching/deleting pending outbox rows. Queue consumer drains D1; fallback cron recovers missed wake-ups and retry rows.

- [ ] **Step 6: Run full CI + Wrangler dry-run and commit**

`feat: add queue-backed notification wakeups`

---

### Task 5: Release hardening and regression gate

**Files:**
- Modify: `README.md`
- Extend: `tests/telegram-notification-v3-wiring.test.mjs`
- Extend existing v2/scheduled recovery tests only where compatibility assertions are needed.

**Interfaces:**
- No new production interfaces; this task verifies the integrated v3 behavior and documents operations.

- [ ] **Step 1: Add regression assertions**

Verify:

- scheduled chapter recovery still creates one release;
- exclusions and all-title subscription semantics still match v2;
- notification text/buttons remain compatible;
- proposal and publication webhook routing remain unchanged;
- Queue absence does not prevent outbox creation or fallback delivery.

- [ ] **Step 2: Document operational schedule and Queue fallback**

README must explain the four crons, the Queue binding, D1 as source of truth, and that Queue failure degrades latency but does not lose notifications.

- [ ] **Step 3: Run final release gate**

Required green checks:

```text
wrangler d1 migrations apply DB --local
npm run typecheck
npm test
node --check public/admin/admin.js
wrangler deploy --dry-run
```

- [ ] **Step 4: Open/update PR against `main`**

PR summary must include latency architecture, Free-plan budget strategy, migration `0014`, Queue fallback, and exact current-head CI result. Do not merge without user instruction.
