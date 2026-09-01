# Telegram Notifications v2 — Design

## Goal

Turn the Telegram release notifier into a useful notification center without touching the website. The release should improve the actual DM experience now and create a clean base for later quiet-hours and digest modes.

## Scope

This release is Telegram-only.

It adds:

- richer release notifications;
- direct per-title subscribe/unsubscribe controls from a release DM;
- a per-title settings panel opened from a release DM;
- `/notifications` as the stable entry point for notification settings;
- per-title exclusions while the user is in “all translations” mode;
- a global `delivery_mode` preference with `instant` as the only exposed mode in this release;
- migration/runtime schema support and regression tests.

It does not add quiet hours, daily digests, “important only”, website UI, reading history, community features, or new RanobeLib write APIs.

## UX

### Release DM

A release DM uses a compact format:

```text
📚 <Title>

🆕 Главы 51–52 уже доступны.
Перевод команды «Дом Некроманта».
```

Buttons:

- `📖 Читать` — opens the RanobeLib title URL;
- `🔕 Отписаться` or `🔔 Подписаться` — toggles this title for the current user;
- `⚙️ Настройки тайтла` — opens a separate title settings message without destroying the release DM.

The existing release aggregation remains authoritative: if one RanobeLib sync detects several new chapters for a title, one release row produces one DM with the chapter range.

### `/notifications`

`/notifications` opens a compact center that shows:

- delivery mode: `⚡ Сразу`;
- subscription scope: all translations, selected titles, or none;
- number of explicit subscriptions / exclusions when useful.

Buttons:

- `📚 Управлять тайтлами` → existing subscription list;
- `🔕 Отключить все`;
- `⚡ Режим: сразу` as a non-destructive status control in this release.

`/subscriptions` continues to open the full title list directly.

### Per-title settings

The title settings panel shows:

- title name;
- current effective state (`уведомления включены/отключены`);
- whether the state comes from “all translations” or an explicit subscription.

Buttons:

- toggle effective subscription for that title;
- `📖 Читать`;
- `📚 Все подписки`.

## Subscription semantics

Current behavior is extended rather than replaced.

### Selected-title mode

When `all_titles = 0`, `title_subscriptions` is the allow-list. Toggling a title inserts/deletes the corresponding row.

### All-translations mode

When `all_titles = 1`, every team title is subscribed by default. A new table `title_subscription_exclusions` stores opt-outs.

This makes “unsubscribe from this title” meaningful even when the user previously selected “all translations”.

Enabling “all translations” clears exclusions because the action means “notify me about every title”. Clearing all notifications clears explicit subscriptions and exclusions.

Effective subscription rule:

```text
(all_titles = 1 AND title not excluded)
OR
(all_titles = 0 AND explicit title subscription exists)
```

## Data model

Migration `0012_telegram_notifications_v2.sql`:

1. Add `delivery_mode TEXT NOT NULL DEFAULT 'instant'` to `telegram_subscription_settings`.
2. Create `title_subscription_exclusions`:

```sql
CREATE TABLE IF NOT EXISTS title_subscription_exclusions (
  user_telegram_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);
```

3. Recreate `trg_ranobelib_release_notifications` so all-mode recipients are excluded when a matching exclusion exists.

Runtime self-healing schema in `telegram-subscriptions.ts` mirrors the persistent migration so production does not depend on an unapplied migration for basic operation.

## Callback design

Keep callback payloads under Telegram’s 64-byte limit and use numeric RanobeLib IDs.

Existing callbacks remain compatible.

New callbacks:

- `subs:center`
- `subs:notify:toggle:<ranobelib_id>`
- `subs:notify:settings:<ranobelib_id>`

No full RanobeLib refs are stored in callback data.

## Delivery pipeline

The existing pipeline stays intact:

```text
RanobeLib release
  → ranobelib_releases
  → D1 trigger / enqueueReleaseNotifications()
  → ranobelib_notification_outbox
  → deliverPendingReleaseNotifications()
  → Telegram sendMessage
```

Notifications v2 changes presentation and recipient selection. It does not introduce a second queue.

The outbox query additionally selects `ranobelib_id` so release buttons can target the correct title.

## Error handling

- Telegram 403 continues to mark the outbox delivery as disabled.
- Retry behavior for temporary Telegram errors remains unchanged.
- Missing/inactive title callbacks answer with a short callback notice instead of throwing.
- If a user presses a notification button after the title becomes inactive, no subscription row is created.
- Existing legacy `/start dl_*`, `/site`, `/propose`, and `/help` routing remains untouched.

## Bot command configuration

`configure-bot.mjs` adds:

- `/notifications` — `Настройки уведомлений`.

Existing commands stay available.

## Testing

Add regression coverage for:

- v2 release message text and buttons;
- callback parser for center/settings/toggle;
- exact-title opt-out while `all_titles = 1`;
- re-subscribe removing an exclusion;
- release enqueue excluding all-mode opt-outs;
- global notification center summary;
- `/notifications` webhook routing;
- `/start dl_*` remaining delegated to legacy delivery;
- schema/migration trigger containing the exclusion predicate;
- existing subscription and release-delivery tests remaining green.

## Rollout

Use a feature branch and PR. Required verification before merge:

- D1 local migrations;
- TypeScript typecheck;
- complete test suite;
- Wrangler dry-run;
- Cloudflare preview build;
- after merge, production smoke and a live `/notifications` check.
