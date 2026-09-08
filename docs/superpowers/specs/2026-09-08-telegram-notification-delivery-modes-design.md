# Telegram Notification Delivery Modes — Design

## Status

Approved in chat for implementation direction. This document freezes the behavior and architecture before the implementation plan is written.

## Goal

Add configurable delivery modes for RanobeLib chapter notifications without losing chapters, duplicating notifications, or breaking the existing v3 outbox/Queue delivery pipeline.

Users must be able to choose:

- **Instant** — a new chapter/release is delivered as soon as the notification worker can send it.
- **Stacked** — accumulate chapters for a title and send one notification when the configured threshold is reached.
- Preset stack sizes: **5 / 10 / 20**.
- Custom stack size: **2–100**.
- A global default mode for all subscribed titles.
- Per-title overrides that take precedence over the global default and survive later global-setting changes.

## Approved product rules

1. Stack counters are calculated **per user + per title**.
2. The user also has one **global default mode** that applies to every title without an override.
3. Per-title overrides are preserved when the global mode changes.
4. Custom stack size is limited to **2–100** chapters.
5. Switching from a stack to **Instant** immediately makes all already accumulated chapters ready; they are sent in **one notification**, not as separate messages.
6. Lowering a threshold below the already accumulated count immediately makes the full accumulated stack ready. Example: 7 accumulated, `10 -> 5` => send all 7.
7. Raising a threshold does not flush early. Example: 3 accumulated, `5 -> 10` => continue accumulating.
8. When a threshold is crossed by a release that adds several chapters, send the **entire accumulated stack**, not exactly the threshold. Example: 8 accumulated + 5 new at threshold 10 => send 13 and reset the stack.
9. A partial stack may not wait forever. If the threshold is not reached within **7 days from the first chapter in the current stack**, send everything accumulated.
10. The 7-day deadline is anchored to the **oldest pending chapter/release**, not extended by later chapters.
11. Removing a per-title override immediately re-evaluates the pending stack under the global setting. If the inherited threshold is already reached, the full stack becomes ready.
12. Notification links keep the existing rule:
    - exactly 1 chapter => direct RanobeLib reader link;
    - 2+ chapters => title page.

## Existing architecture to preserve

Notifications v3 already uses:

```text
RanobeLib release detection
        ↓
ranobelib_releases
        ↓ trigger
ranobelib_notification_outbox
        ↓
Queue wake-up / cron fallback
        ↓
Telegram delivery worker
```

`ranobelib_notification_outbox` remains the durable source of truth. This feature must not add a second table that copies pending chapter data merely to implement stacking.

The existing v3 lease fields on the outbox (`claim_token`, `claim_expires_at`) remain the concurrency primitive. Delivery modes change **which groups are ready to claim**, not the authority of the outbox.

## Effective delivery setting

Each pending notification group resolves its effective mode in this order:

```text
per-title override exists?
    yes -> use override
    no  -> use user's global default
```

A title override is independent from subscription membership. Disabling/excluding a title does not need to destroy the override; if the title is later re-enabled, its previous delivery preference can be reused.

## Data model

### 1. Global settings

Retain the existing `telegram_subscription_settings.delivery_mode` column and add `stack_size`:

```sql
delivery_mode TEXT NOT NULL DEFAULT 'instant'
stack_size INTEGER
```

Semantics:

```text
instant + NULL
stack   + 5
stack   + 10
stack   + 20
stack   + any integer 2..100
```

The migration should add/check constraints where practical:

- `delivery_mode IN ('instant', 'stack')`;
- `stack_size IS NULL` for `instant`;
- `stack_size BETWEEN 2 AND 100` for `stack`.

Existing users remain `instant` after migration.

### 2. Per-title overrides

Add:

```text
telegram_title_delivery_settings

user_telegram_id TEXT
book_ref TEXT
delivery_mode TEXT
stack_size INTEGER NULL
updated_at TEXT
PRIMARY KEY (user_telegram_id, book_ref)
```

No row means **inherit global mode**.

Foreign keys should follow existing subscription tables:

- `user_telegram_id -> users(telegram_id) ON DELETE CASCADE`;
- `book_ref -> ranobelib_titles(book_ref) ON DELETE CASCADE`.

### 3. Custom-input state

Custom stack size requires the next ordinary Telegram message to be interpreted as a number. Add a small transient table, for example:

```text
telegram_notification_input_state

user_telegram_id TEXT PRIMARY KEY
scope TEXT                  -- global | title
book_ref TEXT NULL
expires_at TEXT
created_at TEXT
```

Rules:

- state expires after about 10 minutes;
- valid input is an integer 2–100;
- invalid input returns a short error and keeps the state active until expiry or valid input;
- a new custom-size request replaces the user's prior pending input state.

### Migration number

The current migration sequence ends at `0015`, so implementation should use a forward migration named approximately:

```text
migrations/0016_telegram_notification_delivery_modes.sql
```

Runtime schema helpers may be updated for local/test compatibility, but migration `0016` is the authoritative production schema change. Runtime code must not use destructive schema rebuilds in the hot path.

## Delivery groups

The current worker primarily thinks in individual outbox rows. Stacking requires delivery to operate on **groups**:

```text
(user_telegram_id, book_ref)
```

A group may contain one or many pending/retry outbox rows. One ready group produces at most one Telegram message in that delivery cycle.

### Group accumulation count

For a group, the accumulated chapter count is:

```sql
SUM(ranobelib_releases.chapter_count)
```

Do not count outbox rows themselves because one release row can represent several chapters.

### Oldest age

The stack deadline is derived from the earliest pending member of the group. The implementation may use the outbox/release creation timestamp that is written when the release is detected and fanned out.

The deadline is:

```text
oldest_pending_at + 7 days
```

A later release must not move this timestamp forward.

## Ready-to-send rules

For each still-subscribed, reachable group:

### Instant

Ready whenever there is at least one due pending member. Instant mode introduces **no intentional batching delay** and never waits for a chapter threshold.

A normal single pending release keeps the existing behavior. If several release rows for the same title happen to be simultaneously pending when the worker drains them, they may be coalesced into one immediate notification. This coalescing is opportunistic and must not postpone delivery in order to collect more chapters.

This same grouped path implements the approved `stack -> instant` flush behavior: all already accumulated pending members become ready immediately and are sent together.

### Stack

Ready when either:

```text
accumulated chapter count >= effective stack_size
```

or:

```text
oldest pending member is at least 7 days old
```

When ready, claim and send **all currently accumulated members of the group**. Never leave `threshold overflow` behind intentionally.

Example:

```text
threshold = 10
pending = 8
new release = 5
current total = 13
=> send 13
=> mark all 13 chapters' release/outbox members delivered
=> next stack starts empty
```

## Retry interaction

A failed grouped send must not allow newer rows for the same title to jump ahead of the failed stack.

Therefore a group with a retry member whose `available_at` is still in the future is considered temporarily blocked. New pending rows may accumulate behind it, but the group is not sent until the retry delay expires.

Once due again, all still-pending members of that user/title group are aggregated together and retried as one message.

This prevents chapter gaps such as sending chapters 11–12 while chapters 1–10 are still in Telegram backoff.

## Claiming and concurrency

The v3 lease mechanism remains mandatory.

The new worker should:

1. select a bounded number of **ready group keys** rather than a bounded number of individual outbox rows;
2. atomically claim every unclaimed due member belonging to each selected group using the invocation `claim_token` and lease expiry;
3. aggregate claimed members by `(user_telegram_id, book_ref)`;
4. send one Telegram message per claimed group;
5. update every claimed member in that group according to the one delivery outcome.

### Batch limit

`DELIVERY_BATCH_LIMIT` should now mean **maximum Telegram messages / groups per invocation**, not maximum release rows.

An individual group must not be split merely because it contains more release rows than the old row limit. A 25-chapter stack must still be one notification.

Where practical, aggregation should happen in SQL so a very large group does not require constructing one in-memory object per chapter.

### Duplicate prevention

Two concurrent workers must not be able to send the same ready stack. A worker may only send a group after successfully claiming its pending members with its own valid lease token.

If a worker dies after claiming, existing `claim_expires_at` semantics allow recovery after lease expiry.

## Delivery result persistence

Every outbox member in one claimed group shares the Telegram send outcome:

- success => all claimed group members become `sent` with `delivered_at`;
- Telegram 403 => all claimed group members become `disabled` and reachability is updated;
- Telegram 429 / temporary error => all claimed group members become `retry` with the same retry schedule;
- no longer subscribed => pending group members are cleaned/skipped using existing subscription semantics.

Do not mark only one representative row sent while leaving the rest pending.

## Settings changes and immediate re-evaluation

Settings mutations must not manually craft a second delivery pathway inside Telegram callback handling.

Instead:

1. persist the new global or per-title mode;
2. re-evaluate whether existing pending groups are now ready;
3. wake the normal notification delivery path when the change makes work ready.

Examples:

```text
7 pending, title mode 10 -> instant
=> group becomes ready immediately
=> wake delivery
=> one message for all 7
```

```text
7 pending, title mode 10 -> 5
=> ready immediately
=> wake delivery
=> one message for all 7
```

```text
3 pending, title mode 5 -> 10
=> not ready
=> no flush
```

```text
global mode = 5
title override = 20
8 pending
remove title override
=> inherited threshold is now 5
=> ready immediately
=> wake delivery
```

Changing the global mode never deletes or rewrites title overrides.

## Seven-day flush wake-up

A title may receive no further chapters after the first pending release, so Queue activity alone cannot guarantee the 7-day flush.

The existing notification cron fallback must continue scanning for ready groups. It will make an expired stack deliverable even when no new release has arrived.

With the existing 5-minute fallback cadence from v3, the practical timeout is `7 days + up to one fallback interval`, which is acceptable.

## Telegram UI

### Notification center

The global notification center should expose the current default mode and presets, conceptually:

```text
🔔 Уведомления

Режим по умолчанию: 📦 Стаками по 10
Подписки: 23 тайтла
Индивидуальные настройки: 3 тайтла

[⚡ Мгновенно]
[📦 По 5] [📦 По 10] [📦 По 20]
[⚙️ Кастомный]
[📚 Управлять тайтлами]
[🔕 Отключить все]
```

The center should show how many title overrides currently exist so the user understands that the global setting is not necessarily universal.

### Title settings panel

Conceptually:

```text
📚 <Title>

Уведомления: ✅ включены
Режим: 📦 По 5
Общий режим: По 10

[⚡ Мгновенно]
[📦 5] [📦 10] [📦 20]
[⚙️ Кастомный]
[↩️ Использовать общий режим]
```

`Использовать общий режим` deletes the override row, not copies the global value into a title row.

Callbacks should continue using compact numeric title IDs where possible so Telegram callback payloads stay comfortably under Telegram's callback-data size limit.

### Custom input

After `⚙️ Кастомный`:

```text
📦 Введите размер стака от 2 до 100 глав.
```

Valid example:

```text
37
```

Confirmation:

```text
✅ Уведомления будут приходить после накопления 37 глав.
Если за 7 дней накопится меньше — бот отправит то, что есть.
```

## Notification formatting

### One chapter

Keep current direct-reader behavior:

```text
📚 <Title>
🆕 Доступна глава N
```

`Читать` links directly to the chapter reader when chapter metadata is sufficient, with title-page fallback if it is not.

### Stack / multiple chapters

Example:

```text
📚 <Title>

🆕 Накопилось 13 новых глав
Главы 101–113

Перевод команды «Дом Некроманта».
```

The `Читать` button links to the title page for any aggregated notification containing 2+ chapters.

If the aggregated releases cannot safely be represented as one contiguous numeric range, show only the reliable total (`13 новых глав`) rather than inventing a false chapter range.

## Subscription and exclusion behavior

Existing v2/v3 subscription semantics remain unchanged:

```text
(all_titles = 1 AND title not excluded)
OR
(all_titles = 0 AND explicit title subscription exists)
```

Delivery-mode configuration must not itself subscribe or unsubscribe a title.

If a title becomes ineligible while rows are pending, existing cleanup behavior remains authoritative; stale queued work must not later send after unsubscribe.

## Compatibility

- Existing users default to `instant` and retain no-delay delivery semantics.
- A normal single pending instant release is formatted and linked exactly as today.
- If multiple instant releases for the same title are already pending at one drain, the grouped worker may coalesce them immediately rather than send avoidable back-to-back messages; it must never wait intentionally to create such a group.
- Existing pending outbox rows are interpreted using the effective setting at delivery time.
- No data migration is needed for existing chapter releases/outbox rows beyond the settings schema additions.
- Queue messages remain wake-up signals only; they do not carry stack contents.
- `ranobelib_releases` remains unchanged as the chapter/release source.

## Error handling

- Invalid custom values (`<2`, `>100`, non-integer) are rejected without altering the current setting.
- Expired custom-input state causes the ordinary message to be handled normally rather than as a stack size.
- Missing title metadata falls back to title-page URLs.
- Missing or corrupt stack settings must fail safely to `instant` in runtime normalization rather than silently suppress notifications.
- Telegram delivery errors retain the v3 retry/disable semantics, applied to the whole claimed group.

## Testing requirements

At minimum cover:

1. Existing user/default `instant` keeps no-delay behavior and normal single-release output.
2. Instant single chapter produces one notification.
3. Multiple already-due instant releases for the same title may coalesce without intentional waiting.
4. Stack 5: `2 + 3` becomes one five-chapter notification.
5. Stack 10: `8 + 5` sends one 13-chapter notification with no leftover members.
6. One release containing more than the threshold sends the entire release.
7. Partial stack flushes after 7 days.
8. Seven-day age is anchored to the first pending member and is not reset by newer releases.
9. Global mode applies when no title override exists.
10. Title override wins over global mode.
11. Global-mode changes preserve title overrides.
12. Removing an override restores inheritance.
13. `10 -> instant` with 7 pending makes all 7 ready.
14. `10 -> 5` with 7 pending makes all 7 ready.
15. `5 -> 10` with 3 pending does not flush.
16. Removing a `20` override when global is `5` and 8 are pending flushes all 8.
17. Custom stack accepts boundary values 2 and 100.
18. Custom stack rejects 1, 101, decimals, empty input, and non-numeric input.
19. Expired custom-input state is ignored as a settings reply.
20. A future-dated retry member blocks newer members from jumping ahead.
21. When retry becomes due, old + newly accumulated members are sent together.
22. Concurrent workers cannot send the same group twice.
23. A group larger than the worker's old row batch limit is not split.
24. Group success marks every claimed member sent.
25. Group 403 marks every claimed member disabled.
26. Group retry reschedules every claimed member consistently.
27. Exactly one aggregated chapter uses direct chapter URL.
28. Two or more aggregated chapters use title URL.
29. Missing direct-link metadata falls back safely to title URL.
30. Unsubscribed/excluded pending groups are not sent.
31. 7-day-expired groups are discovered by cron even without a new Queue wake-up.

## Likely implementation surface

Expected implementation areas, to be converted into a concrete plan after this design is reviewed:

- `migrations/0016_telegram_notification_delivery_modes.sql`;
- `src/telegram-subscriptions.ts` — callbacks, UI, settings persistence, custom-input workflow;
- `src/telegram-notification-delivery.ts` — ready-group selection, group claiming, aggregation, grouped outcome persistence;
- Telegram update/router code that can consume a pending custom numeric reply;
- notification-delivery and subscription tests;
- migration/schema tests;
- any Queue/cron tests needed to prove timeout flush wake-up behavior.

## Non-goals

This feature does not:

- combine different titles into one Telegram notification;
- create daily/weekly digest scheduling;
- change RanobeLib polling cadence;
- change subscription/exclusion semantics;
- guarantee an exact translation branch via `?bid=`;
- add a second durable chapter accumulator separate from the outbox.

## Acceptance criteria

The feature is complete when a user can set a global delivery mode, override any individual title, choose 5/10/20/custom 2–100, and reliably receive one grouped notification when the threshold or 7-day timeout is reached, with immediate re-evaluation on mode changes, no lost chapters, no duplicate sends under concurrent workers, and no intentional delay for `instant` users.