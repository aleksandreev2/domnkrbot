# Paid Backend v1 — Demand-Aware Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RanobeLib polling demand-aware, use Workers Paid headroom safely, and stop high-frequency external polling when there are no reachable notification subscribers.

**Architecture:** Add durable reachability and per-title demand state in D1, recompute demand on subscription/reachability changes, split HOT and IDLE title selection, raise the paid fast-scan batch with bounded concurrency, and keep slow snapshots for zero-demand titles. Existing releases, D1 outbox, Queue wake-ups and subscription semantics remain authoritative.

**Tech Stack:** TypeScript, Cloudflare Workers Paid, D1, Cloudflare Queues, Cron Triggers, Telegram Bot API, RanobeLib API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-07-paid-backend-demand-aware-design.md`

## Global Constraints

- Fast scan cap: 24 titles.
- RanobeLib scan concurrency: maximum 4.
- Idle cadence: 180 minutes.
- Uninitialized titles remain eligible for fast bootstrap even with zero demand.
- Missing reachability row means reachable; only explicit `blocked` excludes a user.
- Telegram 403 blocks reachability; 429/transient errors do not.
- D1 outbox, claim lease, Queue fallback and release semantics must not regress.
- Schema changes are forward-only.

---

### Task 1: Demand and reachability schema

**Files:**
- Create: `migrations/0015_paid_backend_demand_aware.sql`
- Create: `src/notification-demand.ts`
- Create: `tests/notification-demand.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Produces `refreshTitleNotificationDemand(env, bookRef): Promise<number>`.
- Produces `refreshAllNotificationDemand(env): Promise<void>`.
- Produces `markTelegramUserReachable(env, userId): Promise<void>`.
- Produces `markTelegramUserBlocked(env, userId): Promise<void>`.

- [ ] **Step 1: Write failing tests**

Cover SQL semantics and transitions. The fake D1 layer must inspect generated SQL and emulate old/new counts. Required assertions:

```js
assert.match(query, /telegram_delivery_reachability/);
assert.match(query, /state\s*!=\s*'blocked'|state\s*=\s*'blocked'/i);
assert.match(query, /title_subscription_exclusions/);
assert.match(query, /title_subscriptions/);
assert.match(query, /all_titles/i);
```

A 0→1 refresh must set `next_check_at` to current time and boost priority. A 1→0 refresh must schedule `+180 minutes`.

- [ ] **Step 2: Add the test to the runtime harness and run PR CI**

Expected: RED because `notification-demand.ts` and migration 0015 do not exist.

- [ ] **Step 3: Implement migration and minimal demand functions**

Migration adds:

```sql
ALTER TABLE ranobelib_titles ADD COLUMN notification_subscriber_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ranobelib_titles ADD COLUMN subscriber_count_updated_at TEXT;

CREATE TABLE IF NOT EXISTS telegram_delivery_reachability (
  user_telegram_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','blocked')),
  blocked_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

Add demand/reachability indexes and initialize demand counts through one recomputation statement after migration application.

- [ ] **Step 4: Run focused/full CI**

Expected: GREEN.

- [ ] **Step 5: Commit**

`feat: add notification demand state`

---

### Task 2: Wire demand refresh into subscription changes

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Modify: `tests/telegram-subscriptions.test.mjs`

**Interfaces:**
- Consumes demand refresh functions from Task 1.

- [ ] **Step 1: Add RED tests**

Test that:

- explicit title on/off refreshes only that `book_ref`;
- all-title on/clear performs one full demand refresh;
- private subscription interaction marks the user reachable before demand is used.

- [ ] **Step 2: Verify RED in CI**

- [ ] **Step 3: Implement minimal wiring**

After `setEffectiveTitleSubscription`, call title-scoped refresh. After `setAllTitles` + exclusion/subscription cleanup, call full refresh. At the start of a valid private subscription callback/menu flow, mark user reachable.

- [ ] **Step 4: Verify GREEN**

- [ ] **Step 5: Commit**

`feat: refresh demand on subscription changes`

---

### Task 3: HOT fast scanner on Workers Paid

**Files:**
- Modify: `src/ranobelib-fast-scanner.ts`
- Modify: `tests/ranobelib-fast-scanner.test.mjs`

**Interfaces:**
- `FAST_SCAN_LIMIT = 24`.
- Add `FAST_SCAN_CONCURRENCY = 4`.
- `selectDueTitles` returns only due HOT titles plus uninitialized titles.

- [ ] **Step 1: Add RED tests**

Required behavior:

```text
initialized + subscriber_count 0 → excluded from fast scan
initialized + subscriber_count >0 → eligible when due
snapshot_ready 0 + subscriber_count 0 → eligible when due
returned rows <=24
max concurrent RanobeLib chapter fetches <=4
no selected rows → 0 external fetches
```

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement bounded concurrency**

Use a four-worker mapper over the selected rows. Preserve per-title failure isolation and existing scheduler/release behavior. Order due titles by overdue time, then subscriber count DESC, then priority DESC.

- [ ] **Step 4: Verify GREEN**

- [ ] **Step 5: Commit**

`feat: use paid capacity for hot title scans`

---

### Task 4: IDLE scanner

**Files:**
- Modify: `src/ranobelib-fast-scanner.ts`
- Modify: `src/live-entry-v2.ts`
- Modify: `wrangler.jsonc`
- Modify: `tests/ranobelib-fast-scanner.test.mjs`
- Modify: `tests/telegram-notification-v3-wiring.test.mjs`

**Interfaces:**
- Produce `IDLE_SCAN_LIMIT = 24`.
- Produce `IDLE_SCAN_DELAY_MINUTES = 180`.
- Produce `scanIdleRanobeLibTitles(env, options?): Promise<FastScanResult>`.

- [ ] **Step 1: Add RED tests**

Idle selection must require `snapshot_ready=1`, `notification_subscriber_count=0`, active and due. Successful idle scans schedule 180 minutes. A release is still recorded with current detector semantics.

Cron must include `17 */3 * * *` and route only to idle scanning.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement idle mode and cron routing**

Reuse the existing scan-one-book path with an explicit scan mode so release detection is not duplicated.

- [ ] **Step 4: Verify GREEN**

- [ ] **Step 5: Commit**

`feat: add slow idle title maintenance`

---

### Task 5: Telegram reachability from delivery outcomes

**Files:**
- Modify: `src/telegram-notification-delivery.ts`
- Modify: `tests/telegram-notification-delivery-v3.test.mjs`

**Interfaces:**
- 403 → mark blocked.
- successful send → mark active and update last success.
- after any reachability state changes in the batch, refresh demand once.

- [ ] **Step 1: Add RED tests**

A 403 outcome must persist both outbox disabled status and blocked reachability. A success must persist active reachability. 429/transient retry must not mark blocked. Multiple 403/success outcomes trigger at most one full demand refresh after mutations.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement outcome bookkeeping**

Keep Telegram pacing/concurrency and claim semantics unchanged.

- [ ] **Step 4: Verify GREEN**

- [ ] **Step 5: Commit**

`feat: exclude blocked telegram users from demand`

---

### Task 6: Discovery activation and observability

**Files:**
- Modify: `src/ranobelib-discovery-scheduler.ts`
- Modify: `src/live-entry-v2.ts`
- Modify: `tests/ranobelib-discovery-scheduler.test.mjs`

**Interfaces:**
- Newly activated titles receive current demand state after discovery.
- Scanner logs include selected/hot/idle and skipped-no-demand information where available.

- [ ] **Step 1: Add RED tests**

A newly discovered title with effective demand must be both due immediately and have non-zero demand after refresh. Empty/failed discovery still cannot deactivate catalog.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement refresh after activation and compact logs**

- [ ] **Step 4: Verify GREEN**

- [ ] **Step 5: Commit**

`feat: initialize demand for discovered titles`

---

### Task 7: Full verification and PR readiness

**Files:**
- Modify documentation only if verification uncovers stale operational notes.

- [ ] **Step 1: Run D1 migrations locally in CI**

Expected: PASS through the existing CI migration step.

- [ ] **Step 2: Run typecheck and full test suite**

Expected: all tests PASS.

- [ ] **Step 3: Run Wrangler dry-run**

Expected: PASS with five cron triggers and existing Queue bindings.

- [ ] **Step 4: Review the complete PR diff for scope/regressions**

Ensure no legacy sync removal, site caching rewrite, membership tuning or analytics rollups slipped into this PR; those belong to later modernization slices.

- [ ] **Step 5: Mark PR ready**

Production merge remains a separate integration action because `main` auto-deploys through Cloudflare.
