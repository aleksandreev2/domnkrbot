# Telegram Notifications v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Telegram release notifications with direct per-title controls, a notification center, and all-mode exclusions without changing the website.

**Architecture:** Extend the existing `telegram-subscriptions.ts` subsystem rather than creating a parallel notifier. Keep `ranobelib_notification_outbox` as the single delivery queue, add an exclusion table for all-title users, and route `/notifications` through the existing Telegram webhook wrapper.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Telegram Bot API, Node test runner, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-02-telegram-notifications-v2-design.md`

## Global Constraints

- Telegram-only; do not modify public website files.
- Preserve `/subscriptions` behavior and `/start dl_*` legacy delegation.
- Do not add another notification queue.
- Callback data must use numeric RanobeLib IDs and remain below Telegram’s 64-byte limit.
- Existing retry/403 delivery behavior remains unchanged.
- Default and only user-exposed delivery mode in this release is `instant`.

---

### Task 1: Persist all-mode exclusions and delivery mode

**Files:**
- Create: `migrations/0012_telegram_notifications_v2.sql`
- Modify: `src/telegram-subscriptions.ts`
- Test: `tests/telegram-notifications-v2.test.mjs`

**Interfaces:**
- Produces table `title_subscription_exclusions(user_telegram_id, book_ref, created_at)`.
- Produces `telegram_subscription_settings.delivery_mode` defaulting to `instant`.
- Updates `trg_ranobelib_release_notifications` to exclude matching opt-outs.

- [ ] **Step 1: Write failing schema tests**

Create tests that read migration SQL and assert it contains:

```js
assert.match(sql, /ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'instant'/i);
assert.match(sql, /CREATE TABLE IF NOT EXISTS title_subscription_exclusions/i);
assert.match(sql, /NOT EXISTS[\s\S]*title_subscription_exclusions/i);
```

Also extend the mock DB so exclusions and `delivery_mode` can be represented.

- [ ] **Step 2: Run tests and verify RED**

Run the repository test workflow. Expected: new migration/schema assertions fail because `0012_telegram_notifications_v2.sql` does not exist and runtime schema lacks exclusions.

- [ ] **Step 3: Add migration and runtime schema**

Migration shape:

```sql
ALTER TABLE telegram_subscription_settings
  ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'instant';

CREATE TABLE IF NOT EXISTS title_subscription_exclusions (
  user_telegram_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS trg_ranobelib_release_notifications;
CREATE TRIGGER trg_ranobelib_release_notifications
AFTER INSERT ON ranobelib_releases
BEGIN
  INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id)
  SELECT NEW.id, s.user_telegram_id
  FROM telegram_subscription_settings s
  WHERE s.all_titles = 1
    AND NOT EXISTS (
      SELECT 1 FROM title_subscription_exclusions e
      WHERE e.user_telegram_id = s.user_telegram_id
        AND e.book_ref = NEW.book_ref
    )
  UNION
  SELECT NEW.id, user_telegram_id
  FROM title_subscriptions
  WHERE book_ref = NEW.book_ref;
END;
```

Mirror table/index creation in `initializeSchema()`. For additive `delivery_mode`, inspect `PRAGMA table_info(telegram_subscription_settings)` before issuing `ALTER TABLE` so self-healing runtime is idempotent.

- [ ] **Step 4: Run tests and verify GREEN**

Expected: schema regression tests and existing subscription schema tests pass.

- [ ] **Step 5: Commit**

Commit message: `feat: add notification preference foundation`.

---

### Task 2: Make effective subscriptions support all-mode opt-outs

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Test: `tests/telegram-notifications-v2.test.mjs`
- Test: `tests/telegram-subscriptions.test.mjs`

**Interfaces:**
- Produces `isEffectivelySubscribed(env, userId, bookRef): Promise<boolean>`.
- Produces `setEffectiveTitleSubscription(env, userId, bookRef, enabled): Promise<void>`.
- Existing title-list callbacks reuse those helpers.

- [ ] **Step 1: Write failing behavior tests**

Cover:

```js
// all mode + no exclusion => subscribed
// all mode + exclusion => not subscribed
// toggling off in all mode inserts exclusion
// toggling on in all mode deletes exclusion
// enabling all mode clears exclusions
// clear-all removes explicit subscriptions and exclusions
```

- [ ] **Step 2: Run tests and verify RED**

Expected: all-mode exact-title opt-out tests fail because current code only supports `all_titles` or explicit subscriptions.

- [ ] **Step 3: Implement effective subscription helpers**

Rules:

```text
if all_titles:
  enabled = no exclusion exists
else:
  enabled = explicit subscription exists
```

When all mode is enabled, title toggle changes the exclusion table. When selected-title mode is active, title toggle changes `title_subscriptions` as before.

Update menu checkmarks so all-mode exclusions render as off, not always checked.

- [ ] **Step 4: Update enqueue logic**

`enqueueReleaseNotifications()` must select all-mode users with a `NOT EXISTS` exclusion predicate and union explicit subscribers.

- [ ] **Step 5: Run tests and verify GREEN**

Expected: old title subscription flows stay green and new exclusion tests pass.

- [ ] **Step 6: Commit**

Commit message: `feat: support per-title opt-outs in all mode`.

---

### Task 3: Upgrade release DM and add title controls

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Test: `tests/telegram-notifications-v2.test.mjs`

**Interfaces:**
- Extend `OutboxRow` with `ranobelib_id`.
- Extend `formatReleaseNotification()` input with `titleId` and `subscribed`.
- Add callback variants:
  - `subs:notify:toggle:<id>`
  - `subs:notify:settings:<id>`

- [ ] **Step 1: Write failing notification-format tests**

Expected keyboard:

```js
[
  [{ text: '📖 Читать', url: release.url }],
  [
    { text: '🔕 Отписаться', callback_data: `subs:notify:toggle:${titleId}` },
    { text: '⚙️ Настройки тайтла', callback_data: `subs:notify:settings:${titleId}` },
  ],
]
```

For an unsubscribed state, the toggle label becomes `🔔 Подписаться`.

Message text must contain the title and localized one/range chapter wording.

- [ ] **Step 2: Run tests and verify RED**

Expected: parser and keyboard assertions fail.

- [ ] **Step 3: Extend parser and formatter**

Add parser branches for the two compact callback formats. Keep old callback formats unchanged.

- [ ] **Step 4: Handle notification toggle callback**

Resolve numeric title ID to active `book_ref`, apply `setEffectiveTitleSubscription()`, then update only the callback message reply markup so the release text remains intact. Answer callback with concise confirmation.

- [ ] **Step 5: Handle title settings callback**

Send a new Telegram message containing title name and effective subscription source/status. Buttons:

```text
🔕 Не уведомлять / 🔔 Уведомлять
📖 Читать
📚 Все подписки
```

Use numeric IDs in callback data.

- [ ] **Step 6: Make delivery know the user’s effective state**

The outbox query selects `t.ranobelib_id` and `r.book_ref`. Before formatting each DM, determine effective subscription state. Normal deliveries should be subscribed; the formatter still accepts the state so button rendering is deterministic.

- [ ] **Step 7: Run tests and verify GREEN**

Expected: v2 formatting, callbacks, existing retry tests, and multi-chapter single-message tests all pass.

- [ ] **Step 8: Commit**

Commit message: `feat: add release notification controls`.

---

### Task 4: Add `/notifications` center

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `scripts/configure-bot.mjs`
- Test: `tests/telegram-notifications-v2.test.mjs`
- Test: `tests/telegram-subscription-webhook.test.mjs`

**Interfaces:**
- Produces `buildNotificationCenter(...)`.
- Produces `sendTelegramNotificationCenter(env, user, chatId)`.
- Adds callback `subs:center`.

- [ ] **Step 1: Write failing center tests**

Assert center text reports:

```text
🔔 Уведомления
Режим доставки: ⚡ Сразу
Подписки: Все переводы / N тайтлов / Отключены
```

Buttons include `📚 Управлять тайтлами`, `⚡ Режим: сразу`, and `🔕 Отключить все`.

- [ ] **Step 2: Write failing webhook test**

A private `/notifications` message must call the notification-center sender. `/subscriptions` continues to call the list sender. `/start dl_*` returns `null` for legacy handling.

- [ ] **Step 3: Run tests and verify RED**

Expected: `/notifications` is currently swallowed as an unknown private message.

- [ ] **Step 4: Implement center and callback**

`subs:center` edits the current message into the center. `📚 Управлять тайтлами` uses `subs:list:0`. `⚡ Режим: сразу` uses `subs:noop` in this release.

- [ ] **Step 5: Route command and update BotFather configuration script**

Webhook recognizes plain `/notifications` (including `@botname` suffix). Add command:

```js
{ command: 'notifications', description: 'Настройки уведомлений' }
```

Do not automatically execute `configure-bot.mjs` from CI.

- [ ] **Step 6: Run tests and verify GREEN**

Expected: center and webhook tests pass; legacy command tests remain green.

- [ ] **Step 7: Commit**

Commit message: `feat: add Telegram notification center`.

---

### Task 5: Full verification and rollout PR

**Files:**
- Modify only if verification exposes defects.

**Interfaces:**
- No new public interfaces.

- [ ] **Step 1: Run local-equivalent CI through GitHub Actions**

Required successful steps:

```text
Apply D1 migrations locally
Typecheck
Website JavaScript syntax
Tests
Wrangler dry run
```

- [ ] **Step 2: Confirm Cloudflare preview build**

The feature head must have a successful `Workers Builds: domnkrbot` check.

- [ ] **Step 3: Review PR diff**

Confirm no `public/` website files changed, callback payloads are compact, and no secrets were committed.

- [ ] **Step 4: Merge the verified SHA**

Use `expected_head_sha` when merging.

- [ ] **Step 5: Verify production**

Require successful main CI, `production-smoke`, and Cloudflare production build. Then manually verify in Telegram:

```text
/notifications
/subscriptions
```

And verify one test release notification through a safe test mechanism if available; do not fabricate a production RanobeLib release solely for testing.
