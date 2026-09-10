# Multi-Team RanobeLib Notifications — Design

Status: **Draft / active design discussion**

This document captures decisions already approved in chat for multi-team RanobeLib notifications. It is intentionally a design plan, not yet the implementation plan. Open decisions are listed at the end and must be resolved before implementation planning.

## Goal

Turn the current single-team notification system into a first-class multi-team system without making Telegram UX confusing and without allowing external team metadata to leak into the existing publication/channel-delivery subsystem.

Users should be able to:

- follow an entire translation team;
- follow individual title translations from a specific team;
- exclude individual title translations from an otherwise followed team;
- search titles without being confused by duplicate translations;
- receive exactly one notification for a joint branch translated by multiple followed teams;
- understand why a title is or is not currently notifying them.

Admins should be able to add, verify, synchronize, publish, pause, and manage RanobeLib teams through the Telegram bot.

`Дом Некроманта` remains the primary/default team of the bot.

## Non-goals / safety boundaries

Multi-team support is a **notification/source aggregation feature**, not a multi-channel publishing feature.

An external team's optional Telegram channel must never become a publication destination. It must not inherit or participate in:

- `publications` delivery;
- `publish_channel_id`;
- publication editing/deletion;
- publication asset delivery;
- the existing download membership gate;
- blacklist or Telegram ban enforcement;
- any other write operation against that team's channel.

The optional external team channel exists only to help personalize first-run recommendations. Its intended Telegram usage is read-only membership/metadata lookup such as `getChatMember`/`getChat` where permitted.

The existing `Дом Некроманта` publication pipeline remains independent.

## Core domain model

The system must stop treating a RanobeLib `book_ref` as the complete identity of a translation.

Use three conceptual layers:

1. **Work / title** — the RanobeLib book page itself. Global metadata such as `book_ref`, RanobeLib ID, title, cover, summary, and URL belong here.
2. **Team translation** — a specific team translating a specific work. Subscription semantics, team presence, active/dormant state, and team-scoped notification demand belong to the pair `(team, work)`.
3. **Chapter branch / release** — the actual RanobeLib translation branch for one or more chapters. A branch can belong to one team or multiple teams in a joint translation.

This avoids duplicating the work itself while preserving team-specific subscription identity.

The current `ranobelib_titles` table can remain the work-level foundation rather than being discarded. New team/work and branch/team structures should be layered around it with a migration that preserves historical IDs, links, snapshots, and notification history wherever possible.

## Team registry

Introduce a first-class RanobeLib team registry. Each team needs at least:

- stable internal ID;
- RanobeLib team ID/ref;
- display name;
- primary-team flag;
- visibility/lifecycle state;
- optional recommendation Telegram channel reference;
- sync timestamps and sync error state.

Suggested lifecycle states are conceptually:

- `hidden/syncing` — added by admin but not visible to users;
- `published` — available to users and eligible for notification subscriptions;
- `paused` — hidden and not actively scanned, but all user subscription state is preserved;
- `error` — sync failed and requires admin attention.

Exact persistence values can be selected in the implementation plan.

`Дом Некроманта` is seeded as the primary team and remains published.

## Admin: adding a team through Telegram

Only admins add teams. Ordinary users never paste RanobeLib team URLs or IDs.

Proposed flow:

1. Admin opens `Управление командами`.
2. Admin selects `Добавить команду`.
3. Bot asks for the RanobeLib team URL/ref.
4. Bot validates the team against RanobeLib before mutating the active catalog.
5. Bot shows a preview: team name, RanobeLib ID/ref, number of discovered works, active/completed counts where trustworthy, and validation/sync warnings.
6. Admin confirms.
7. Bot performs the initial synchronization **silently**, without generating historical release notifications.
8. The team remains hidden after successful initial sync.
9. Admin explicitly selects `Опубликовать команду` to expose it to users.

An optional Telegram channel may be attached to the team. Attaching it must be independent from RanobeLib sync success.

If membership cannot be reliably checked (for example, the bot lacks sufficient rights), the team still functions normally for RanobeLib notifications; only personalized onboarding recommendations for that channel are unavailable.

## Admin: pausing a team

Pausing is non-destructive.

When a published team is paused:

- it disappears from the normal user team catalog;
- active scanning for that team stops unless another published team on the same work independently requires the shared work fetch;
- notifications attributable only to the paused team stop;
- team subscriptions, title subscriptions, exclusions, and history remain stored;
- resuming/re-publishing restores the previous user subscription state automatically.

Pausing must not delete subscriptions.

## Subscription model

### Team subscription

A user may follow a whole team.

Following a team means receiving all current and future title translations from that team, except explicit per-title exclusions.

### Explicit title subscription

A user may follow one title translation from a specific team without following that team globally.

A title subscription is therefore always scoped to `(user, team, work)`, never just `(user, work)`.

### Exclusions

If a user follows a whole team, an explicit exclusion for one `(team, work)` wins over the inherited team subscription.

Effective precedence:

1. explicit title exclusion;
2. whole-team subscription;
3. explicit title subscription;
4. no subscription.

The UI should explain the effective reason in human language, for example:

- `Получаете уведомления: подписка на всю команду`;
- `Уведомления отключены: исключение из подписки на команду`;
- `Получаете уведомления: выбрано вручную`.

### Existing users / `all_titles`

The old global `all_titles=1` behavior must **not** become “follow every current and future team”.

Approved migration semantics:

- existing `all_titles=1` becomes “follow all translations from Дом Некроманта”;
- newly added teams are never auto-enabled for those users;
- existing title subscriptions/exclusions and title delivery overrides are migrated into the `Дом Некроманта + title` scope.

This preserves previous behavior without surprising users when new teams are added.

## User notification center

The main notification center becomes team-aware and avoids dumping every inherited title into one giant list.

Recommended root structure:

```text
🔔 Уведомления

👥 Мои команды
📚 Мои новеллы
🔎 Найти новеллу
🧭 Все команды
⚙️ Режим доставки
```

### `Мои команды`

Shows teams the user follows as a whole.

Opening a team shows its status, active translation count, exclusions count, and actions to browse its translations or stop following the whole team.

### `Мои новеллы`

Approved semantics: this screen shows **only manually selected title translations** from teams the user does not follow as a whole.

Titles inherited from a team subscription do not flood this screen.

### Team title card

A title card is always for a concrete team translation.

If inherited from a team subscription, show an action such as `Не уведомлять по этой новелле`, creating an exclusion.

If explicitly excluded, show `Вернуть уведомления`.

If the team is not followed, show the normal explicit title subscribe/unsubscribe action.

## Search UX and duplicate titles

Search operates across published teams.

Approved behavior:

- if a work has only one available team translation, go directly to that team-title card;
- if multiple teams translate the same work, group the search result by the work first and then show a team chooser;
- never expose internal IDs or make users understand branch mechanics.

Example:

```text
📚 Культивация Онлайн
Переводят 2 команды
```

Then:

```text
Выберите перевод:

🔔 Дом Некроманта
🔕 Team X
```

## Release identity and joint translations

A release must no longer be globally identified only by `book_ref` and chapter IDs.

The system must preserve RanobeLib branch identity or a stable branch fingerprint and its associated team set.

Approved semantics:

- one branch associated with `Дом Некроманта + Team X` is one release;
- a user following either participating team is eligible;
- a user following both still receives that release only once;
- two independent branches of the same chapter from two teams are two different releases and may produce two notifications if the user follows both.

The notification should identify the translator team(s) dynamically. Joint translations can display multiple teams in one notification.

## Scanner and discovery architecture

The current single-team assumptions must be removed from discovery/scanning.

### Discovery

Discovery is per team. A work disappearing from Team A's catalog must only archive/pause the Team A → work relationship; it must not globally deactivate the work if Team B still translates it.

### Chapter fetching

Prefer a work-level network fetch followed by branch parsing/fan-out rather than fetching the exact same `/chapters` payload once per team.

If a work is translated by three monitored teams, one RanobeLib chapter fetch should ideally update all relevant branch/team state.

This reduces subrequests, naturally handles joint branches, and prevents the same work from being scanned redundantly.

### Demand

Notification demand should be computed for team-title subscriptions, then aggregated to the work-level scanner scheduler. If any active monitored translation of a work has meaningful subscriber demand, the shared work fetch can run at the appropriate hot cadence.

A paused/hidden team must not independently create scanner demand.

## First `/start` onboarding

A special onboarding flow is shown for genuinely new users and, at rollout, for existing users who have no notification subscriptions. Existing users who already have at least one effective notification subscription skip the onboarding and continue to the normal main menu.

`Дом Некроманта` must be clearly identified as the **primary team of the bot**, but it must not be silently subscribed without a user action.

### Existing-user rollout

Approved rollout rule:

- genuinely new users receive the new onboarding;
- existing users with any current notification subscription do **not** get interrupted by the new onboarding;
- existing users with zero current notification subscriptions receive the onboarding on their next normal `/start`;
- existing subscription state is never rewritten merely because onboarding exists.

The rollout check must account for migrated legacy subscriptions so an existing `all_titles=1`, explicit title subscription, or equivalent migrated team/team-title subscription counts as already configured.

### Default onboarding

When no reliable external-team membership signal is available, show a concise introduction and make `Дом Некроманта` the primary recommendation while still exposing the full team catalog.

Conceptually:

```text
Добро пожаловать в Дом Некроманта!

Бот следит за новыми главами на RanobeLib и присылает уведомления сюда.

🏠 Дом Некроманта — основная команда бота.

[ 🏠 Следить за Домом Некроманта ]
[ 👥 Посмотреть все команды ]
```

### Personalized onboarding from an optional team Telegram channel

A team may have an optional recommendation Telegram channel.

During first onboarding only, the bot may check whether the user belongs to that channel when Telegram permissions make the answer reliable.

If the user belongs to Team X's linked channel, Team X becomes a personalized recommendation while `Дом Некроманта` remains visibly primary.

Recommended single-match choices:

```text
[ ✅ Team X + Дом Некроманта ]
[ 👥 Только Team X ]
[ 🏠 Только Дом Некроманта ]
[ ⚙️ Выбрать команды вручную ]
```

If multiple linked-team memberships are detected, show a compact team selector rather than an explosion of combination buttons.

### Recommendation is not synchronization

Approved rule: external Telegram membership is used **only to personalize first onboarding**.

It never automatically changes notification subscriptions later.

Examples:

- leaving Team X's Telegram channel does not unsubscribe Team X in the bot;
- joining Team X's Telegram channel later does not silently subscribe Team X in the bot;
- a Telegram membership lookup failure falls back to normal onboarding and does not block `/start`.

## Strict publication-channel isolation

This is a hard invariant.

External team recommendation channels are read-only recommendation metadata.

They must not be accepted as destinations by the publication subsystem, notification delivery subsystem, publication lifecycle, download membership gate, or blacklist/ban subsystem.

Implementation should enforce this structurally, not only by convention:

- use separate data fields/tables and naming for recommendation channels;
- do not expose recommendation-channel IDs through publication settings APIs;
- keep `publish_channel_id` as the publication destination for the existing Дом Некроманта publication system;
- ensure normal chapter notifications are sent to the subscribed user's private Telegram chat, not to a team's channel;
- add regression tests proving external recommendation channel IDs cannot flow into publication/write operations.

The existing `channel-membership-access` behavior for Дом Некроманта downloads remains a separate feature and must not be generalized to external team channels as part of this project.

## Delivery modes

Preserve the current user-wide default delivery mode and per-title override concept, but per-title overrides must become team-title scoped so two translations of the same work can be configured independently.

A per-team delivery-mode override is **not yet approved** and should not be added unless the UX discussion explicitly decides it is needed.

## Historical data and migration safety

Migration must be additive and backward-compatible where practical.

Requirements:

- seed Дом Некроманта as the primary team;
- associate existing known translation state with Дом Некроманта without losing archived rows/history;
- migrate `all_titles=1` into the Дом Некроманта whole-team subscription;
- migrate existing explicit subscriptions, exclusions, and title delivery overrides into Дом Некроманта team-title scope;
- preserve delivered/outbox history so migration cannot resend old notifications;
- initial sync of a newly added team establishes a silent baseline and must not emit its historical chapters as new releases;
- deployment must be safe if migration and new Worker code overlap briefly.

## Failure and recovery UX

Admin team sync failures must be visible from the team-management screen with a retry action and a short safe error summary.

User-facing behavior should fail closed for unavailable new data but fail open for already stored settings:

- RanobeLib outage does not delete or rewrite subscriptions;
- Telegram recommendation-channel lookup failure does not block onboarding;
- one broken team must not prevent scanning or notifications for other teams;
- one broken work must not block unrelated works;
- pausing/resuming a team must be idempotent.

## Testing requirements

Implementation should use TDD and add focused tests for at least:

- old `all_titles` migration to Дом Некроманта;
- team follow + title exclusion precedence;
- explicit team-title subscriptions;
- same work translated by multiple teams;
- joint branch deduplication;
- two independent branches producing distinct releases;
- initial team baseline producing no historical notifications;
- per-team discovery removal not globally archiving a shared work;
- paused team preserving subscriptions;
- recommendation membership influencing first onboarding only;
- recommendation lookup failure fallback;
- onboarding rollout: existing subscribed users are not interrupted, existing unsubscribed users are offered onboarding;
- publication-channel isolation and prohibition of writes to external recommendation channels;
- existing publication/download membership behavior remaining unchanged;
- delivery-mode migration and team-title scoping;
- notification outbox deduplication/idempotency.

## Approved decisions summary

- Architecture: normalized work → team translation → branch/release model.
- Only admins add teams, through the Telegram bot.
- New teams are hidden after initial sync and require explicit admin publication.
- Pausing a team preserves subscriptions/history.
- Whole-team subscriptions and individual team-title subscriptions are both supported.
- Whole-team subscription supports per-title exclusions.
- Old global `all_titles` migrates to whole-team Дом Некроманта only.
- `Мои новеллы` shows only manually selected title translations.
- Search groups duplicate works only when multiple teams translate them.
- Joint branch involving multiple teams is one release/one user notification.
- Independent team branches remain distinct releases.
- Дом Некроманта is the primary team in first `/start` onboarding.
- Optional external Telegram channels personalize first onboarding only.
- Channel membership never silently changes subscriptions later.
- External team channels are completely isolated from publication/channel-write infrastructure.
- New onboarding is shown to new users and existing users with no notification subscriptions; existing subscribed users skip it.

## Open decisions before the final implementation plan

1. Exact onboarding completion semantics: what action marks onboarding complete and how `Назад`/abandon/retry behaves.
2. Whether a whole-team subscription should allow a team-wide delivery-mode override, or only global default + team-title override.
3. Exact admin flow for attaching/verifying an optional Telegram recommendation channel (`@username`, numeric chat ID, forwarded channel message, or supported combination).
4. Exact status semantics for a team translation when RanobeLib's title-level `scanlateStatus` is not team-specific; completion must not be falsely attributed to every team without evidence.
5. Stable RanobeLib branch identity: use a native branch ID if reliably exposed; otherwise define and test a stable fingerprint.
6. How completed translations appear in the multi-team user catalog and whether completed titles are shown by default inside a team's page.
7. Whether hidden-but-synced teams are visible to admins only in `/stats` and team management, and what summary metrics are desired.
8. Rollout/deployment sequencing for the schema migration, silent baseline, scanner switch, and notification UX switch.