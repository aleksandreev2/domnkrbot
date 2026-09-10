# Multi-Team RanobeLib Notifications — Final Design

Status: **Approved / ready for implementation planning**

This document is the consolidated implementation-facing design for multi-team RanobeLib notifications. It supersedes the active discussion file `docs/superpowers/specs/2026-09-10-multi-team-notifications-design.md` as the source of truth for implementation. The earlier file remains as decision history.

## Goal

Turn the existing single-team RanobeLib notification system into a first-class multi-team system while preserving current users, notification history, delivery modes, demand-aware scanning, and the existing `Дом Некроманта` publication subsystem.

The system must be flexible enough to support independent translations, joint branches, future teams, completed translations, temporary upstream ambiguity, and rollout/rollback without losing subscriptions or sending historical duplicate notifications.

Correctness takes priority over aggressive deduplication. If the system lacks enough stable evidence to prove that two upstream objects are the same branch/release, it must keep them separate rather than merge them and suppress a legitimate notification.

## Hard invariants

1. `Дом Некроманта` remains the primary team of the bot.
2. Existing `all_titles=1` means “follow all translations from Дом Некроманта”, never “follow every team”.
3. A subscription to a title is scoped to `(user, team, work)`, not merely `(user, work)`.
4. A joint branch is one release even when several followed teams participate in it.
5. Two independent branches of the same chapter remain two releases.
6. The existing publication channel, download membership gate, blacklist/ban subsystem, and publishing lifecycle remain isolated from external team recommendation channels.
7. Initial synchronization of any newly added team is silent: historical chapters never become fresh notifications.
8. Work-level RanobeLib status must never falsely mark every team translation as completed.
9. Migration is additive and forward-only. No destructive cleanup is part of the initial rollout.
10. Existing outbox/delivery history remains authoritative enough to prevent re-sending old releases.

## Domain model

Use four layers.

### 1. Work

`ranobelib_titles` remains the canonical work-level entity and keeps data shared by all translations:

- `book_ref` / RanobeLib work ID and slug;
- title, summary, cover, URL;
- work-level metadata;
- work-level scanner scheduling where useful.

A work is not globally “active/inactive because Team X disappeared”. Team presence is modeled separately.

### 2. Team

Add a first-class `ranobelib_teams` registry with at least:

- stable internal `id`;
- RanobeLib team ID/ref;
- display name;
- `is_primary`;
- lifecycle state;
- optional recommendation Telegram channel metadata;
- sync timestamps/error summary;
- created/updated timestamps.

Lifecycle states are conceptually:

- `hidden` — synchronized but not user-visible;
- `published` — visible and subscribable;
- `paused` — not user-visible and not independently creating scanner demand, while subscriptions/history remain stored;
- `error` — synchronization/validation needs admin attention.

Transient syncing can be represented separately or as state metadata; persistence details may follow existing project patterns.

### 3. Team translation

Add `ranobelib_team_translations` keyed by `(team_id, book_ref)`.

It owns team-specific state such as:

- whether this team currently exposes the work;
- active/dormant/completed/unknown semantic status;
- last seen / last synchronized timestamps;
- silent-baseline state;
- completion evidence/source;
- team-specific demand if materialized;
- sync error if the relationship itself fails.

A team disappearing from its catalog changes only this relationship. It does not deactivate the work for other teams.

### 4. Branch / release

Chapter identity must become branch-aware.

Add branch-aware storage such as `ranobelib_chapter_branches`, plus a mapping from each branch instance to participating teams. The exact table names can follow implementation conventions, but persisted identity must distinguish:

- work;
- chapter;
- branch identity;
- participating team set;
- branch release timestamp where available.

`ranobelib_releases` remains the durable release ledger, but each chapter release must be associated with a stable branch key and a participating team set. A mapping table such as `ranobelib_release_teams` is preferred to denormalized comma-separated team IDs.

## Stable branch identity

Current RanobeLib chapter payloads expose branch objects and native `branch_id` values. The implementation must preserve this information instead of reducing a chapter to only `chapter.id`.

### Primary identity

When a non-null native `branch_id` is available and structurally valid, use it as the primary upstream branch identifier for that chapter branch.

Store the native ID rather than deriving identity from mutable display names.

The internal branch key should be namespaced/versioned, for example conceptually `native:<branch_id>`, and persisted together with the work/chapter context and sorted participating team IDs.

Do not assume more cross-chapter/global stability than RanobeLib actually guarantees. The code should preserve the observed native ID and team set and base release identity on the concrete branch data returned for the chapter/release.

### Fallback identity

If a usable native `branch_id` is absent, derive a versioned fingerprint only from stable observable inputs. Conceptually:

`fp:v1(hash(work identity + chapter identity + sorted team IDs + stable upstream branch fields))`

Mutable display text such as translated team names must not be the sole source of identity.

If too little stable data exists to construct a safe fingerprint, treat the branch as ambiguous/distinct rather than merging it with another branch. False separation may cause an extra notification in a rare ambiguous case; false merging can permanently suppress a real release and is therefore worse.

Tests must cover native IDs, fallback IDs, reordered team arrays, joint branches, two independent branches for the same chapter, missing branch IDs, and ambiguous input.

## Subscription model

### Whole-team subscription

A user can follow an entire team. This includes current and future translations from that team, except explicit per-title exclusions.

### Explicit team-title subscription

A user can follow one specific `(team, work)` translation without following the whole team.

### Team-title exclusion

When a whole team is followed, a user can exclude one `(team, work)` translation.

Effective precedence is:

1. explicit team-title exclusion;
2. whole-team subscription;
3. explicit team-title subscription;
4. no subscription.

The same work translated by two teams therefore has two independent subscription states.

### Legacy migration

Migration is idempotent:

- seed/find the primary `Дом Некроманта` team;
- migrate legacy `all_titles=1` into one whole-team subscription for the primary team;
- migrate legacy explicit `title_subscriptions` into primary-team team-title subscriptions;
- migrate legacy exclusions into primary-team team-title exclusions;
- migrate existing title delivery overrides into primary-team team-title delivery overrides;
- preserve legacy rows during the compatibility window rather than deleting them immediately.

Existing migrated state counts as configured for onboarding rollout.

No existing user is automatically subscribed to a newly added external team.

## Delivery modes

There are exactly two configuration levels:

1. global user default;
2. optional team-title override for `(user, team, work)`.

There is no team-wide delivery-mode override.

A whole-team subscription changes what the user follows, not how an intermediate team-level delivery policy is resolved.

Existing instant/stack behavior, stack thresholds, accumulated progress, and safety flush semantics remain intact. The only scope change is that title overrides become team-title-specific.

## Release eligibility and deduplication

Eligibility is calculated from the release's participating team set.

For a joint release involving Team A + Team B:

- following either participating team can make the user eligible;
- following both still produces one user notification;
- a team-title exclusion affects eligibility through that specific team path;
- if another participating team still makes the user eligible, the joint release remains eligible.

The outbox must deduplicate by the canonical release identity plus user, as it does today conceptually. Eligibility should union all participating-team paths before insertion so a joint release creates at most one outbox row per user.

Two independent branches have different branch/release identities and may create two notifications if the user is eligible for both.

## Scanner and discovery

### Team discovery

Discovery runs per registered team.

- one broken team must not prevent other teams from syncing;
- zero/invalid upstream results must not wipe a previously valid team catalog;
- a missing work relationship becomes dormant/removed for that team only;
- initial sync creates a silent baseline;
- hidden/paused teams do not independently create notification demand.

### Work-level chapter fetching

Avoid fetching identical `/chapters` payloads once per team.

The scheduler should aggregate demand to the work level, fetch a due work once, parse all relevant branches from the response, and fan the result out to team-translation/branch state.

This retains the existing HOT/IDLE concept while avoiding redundant subrequests when multiple teams translate the same work.

### Demand

Effective demand is computed at team-title eligibility level and aggregated to each work for scheduling.

If any published, actionable translation of a work has reachable effective subscribers, the work may be HOT. If no published translation has demand, the work follows IDLE behavior unless it needs bootstrap/finalization/recovery work.

Pausing or hiding a team removes only that team's contribution to demand; it never deletes subscriptions.

## Translation completion semantics

RanobeLib's title-level `scanlateStatus` is work-level context only.

A `(team, work)` translation can be shown as completed only when there is reliable evidence attributable to that team or to a branch explicitly associated with that team. Joint-branch evidence may apply to that branch's participating team set.

Rules:

- never copy work-level completion to all teams;
- disappearance from a team catalog is not proof of completion;
- ambiguous state is `unknown`/non-final rather than false `completed`;
- a confirmed completion may trigger the existing “final successful chapter poll before completion notice” safety behavior, but scoped to the team/branch model;
- late/final chapters discovered during completion finalization must be persisted and released before the completion event.

## Completed translations in user UX

Completed translations remain searchable and manageable; they are not deleted or hidden from history.

Default behavior:

- a team's primary title list shows active/ongoing translations first and does not flood the main list with completed works;
- each team screen exposes a separate `Завершённые` entry/filter with a count when completed translations exist;
- global search can find completed translations and clearly labels them as completed;
- a user's existing explicit subscription to a translation that becomes completed remains visible/manageable until the user changes it;
- completion does not silently rewrite unrelated subscriptions.

The existing UX already has a completed-translations concept, so multi-team UX should preserve that mental model while making completion team-specific.

## User notification center

The root remains compact and team-aware:

```text
🔔 Уведомления

👥 Мои команды
📚 Мои новеллы
🔎 Найти новеллу
🧭 Все команды
⚙️ Режим доставки
```

`Мои команды` shows whole-team follows.

`Мои новеллы` shows manually selected team-title translations from teams the user does not follow wholesale; inherited titles do not flood this screen.

Search groups by work only when more than one published team translates that work. With one translation, open its team-title card directly.

Each title card explains why notifications are enabled/disabled and shows the effective global/team-title delivery mode.

Internal branch mechanics and IDs are never exposed to users.

## First `/start` onboarding

### Who sees it

Show onboarding to:

- genuinely new users;
- existing users with zero effective notification subscriptions at rollout.

Do not interrupt existing users who already have any effective subscription, including migrated legacy `all_titles`, explicit title subscriptions, or equivalent new team/team-title subscriptions.

### Completion

Onboarding is completed only when:

- at least one team selection is successfully persisted; or
- the user explicitly selects `Не сейчас`.

Opening the team catalog, pressing `Назад`, closing Telegram, abandoning selection, timing out, or issuing another `/start` does not complete it. An incomplete flow is offered again on the next normal `/start`.

The completion write is idempotent.

### Primary recommendation

`Дом Некроманта` is always visibly identified as the bot's primary team but is never silently subscribed without a user action.

## Optional Telegram recommendation channels

An external team's Telegram channel is recommendation metadata only.

Admins can attach one by:

- `@username`;
- `t.me/...` link;
- forwarding a message from the target channel when Telegram exposes a resolvable source.

The bot resolves/stores the canonical channel ID and safe display metadata. Raw numeric IDs are not a normal admin-facing input path.

Before using membership for onboarding personalization, the bot verifies that membership lookup is reliable with its current access. Failure only disables personalization; it never breaks RanobeLib notifications or team sync.

Membership is consulted during first onboarding only. Joining/leaving a channel later never silently changes notification subscriptions.

### Strict isolation

Recommendation channel IDs must not flow into:

- `publish_channel_id`;
- publication delivery/edit/delete;
- download membership gates;
- blacklist/ban enforcement;
- notification destination selection;
- any write operation against the external team channel.

Normal chapter notifications always go to the subscribed user's private Telegram chat.

## Admin team management

Only admins add/manage teams.

Adding a team:

1. request RanobeLib team URL/ref;
2. validate against RanobeLib without mutating the active catalog;
3. show preview and warnings;
4. admin confirms;
5. run initial sync silently;
6. leave the team hidden;
7. admin explicitly publishes it when ready.

Pausing is non-destructive and preserves subscriptions/history.

### Hidden team visibility

Hidden/synced teams are never exposed in normal user search, team catalogs, or onboarding.

Admins see all team lifecycle states in `Управление командами`, including hidden, published, paused, and error teams. Each team detail should show enough operational data to act:

- lifecycle state;
- visible/hidden status;
- last successful sync;
- last sync error summary;
- discovered translation count;
- active/completed/unknown counts where trustworthy;
- recommendation-channel readiness;
- actions to sync/retry/publish/pause/edit recommendation channel.

`/stats` should remain compact: aggregate team counts by lifecycle plus error/stale counts. Detailed per-team troubleshooting belongs in team management rather than dumping every hidden team into general stats.

## Failure and recovery

The design fails open for stored user settings and fails closed for uncertain new upstream data.

- RanobeLib outage does not delete subscriptions or catalog history.
- Team discovery failure does not clear a team.
- One broken team/work does not stop unrelated teams/works.
- Unknown branch identity is not aggressively merged.
- Recommendation membership failure does not block onboarding.
- Pausing/resuming/publishing is idempotent.
- Delivery remains D1-outbox-backed; Queue is only a wake-up mechanism.
- Telegram 403 reachability behavior remains compatible with existing demand logic.

## Rollout and rollback

The initial release uses a staged, additive cutover.

### Phase 1 — schema and compatibility

Apply forward-only migrations that create the new team/translation/branch/subscription structures and feature/cutover flags. Do not remove legacy tables or columns.

Seed `Дом Некроманта` and idempotently backfill existing work relationships/subscriptions/exclusions/delivery overrides into primary-team scope.

Old and new Worker code must be safe during a brief deployment overlap: new tables can exist before new code uses them; migration must not require new code to have already run.

### Phase 2 — silent baseline

Populate primary-team team-translation and branch-aware snapshots from existing/current upstream data without generating historical releases.

When adding external teams, baseline them hidden and silent as well.

### Phase 3 — shadow verification

Run branch-aware parsing/detection and new eligibility calculations in shadow mode while the legacy primary-team delivery path remains authoritative.

Compare at least:

- due work selection;
- detected chapter deltas;
- native/fallback branch identity;
- expected eligible recipient counts;
- joint-branch dedupe;
- completion finalization;
- no historical replay.

Shadow mode must not insert user-visible release/outbox rows.

### Phase 4 — primary-team cutover

Switch `Дом Некроманта` notification generation/eligibility to the new model behind a kill switch/feature flag, while preserving the old data for rollback.

Verify production smoke checks and outbox behavior before exposing external-team subscriptions.

### Phase 5 — multi-team exposure

Enable admin team management/addition, publish validated teams, then enable the team-aware user catalog/onboarding.

New teams start hidden, so no accidental user-visible catalog expansion can happen before an admin explicitly publishes them.

### Phase 6 — stabilization

Keep legacy state for a defined stabilization period. Monitor errors, duplicate-suppression metrics, branch ambiguity/fallback usage, outbox retries, and migration parity.

Only after validated zero dependence on the legacy single-team read/write path should a separate future migration remove obsolete columns/tables/triggers. That cleanup is explicitly outside this implementation's initial cutover.

### Rollback principle

Rollback means disabling new read/write switches and returning to the preserved legacy primary-team path; it must not require reversing/destructively undoing the migration. New tables may remain populated but dormant.

## Testing requirements

Implementation is TDD-driven. At minimum cover:

- idempotent primary-team seeding/backfill;
- old `all_titles` → primary whole-team follow;
- legacy explicit subscriptions/exclusions/overrides → primary team-title scope;
- team follow + exclusion precedence;
- explicit team-title subscription;
- global delivery default + team-title override;
- no team-wide delivery mode;
- same work translated by multiple teams;
- native `branch_id` preservation;
- fallback fingerprint stability and versioning;
- reordered joint-team lists producing same identity;
- ambiguous branch data not being falsely merged;
- joint branch → one release / one notification per user;
- independent branches → independent releases;
- work-level completion not propagating to all teams;
- team/branch-specific completion attribution;
- final chapter scan before completion event;
- per-team discovery removal not globally archiving work;
- initial team baseline producing no historical notifications;
- paused/hidden team preserving state and not creating demand;
- completed translations separated from default active list but searchable;
- hidden teams invisible to users and visible to admins;
- recommendation-channel input/resolution/access fallback;
- recommendation membership affecting first onboarding only;
- onboarding rollout for existing subscribed/unsubscribed users;
- onboarding completion vs abandon/retry;
- publication-channel isolation regression tests;
- outbox idempotency/deduplication;
- shadow mode producing no user-visible delivery;
- feature-switch rollback preserving legacy behavior;
- full existing regression suite.

## Observability

Add enough diagnostics to answer operational questions without exposing internal complexity to users:

- teams by lifecycle state;
- teams with stale/error sync;
- works/branches processed per scanner run;
- native branch IDs vs fallback fingerprint usage;
- ambiguous branch observations;
- releases created vs shadow-only detections;
- joint release count and dedupe count;
- eligible recipient count/outbox inserts;
- migration parity counts for legacy vs new primary-team subscriptions;
- onboarding shown/completed/skipped counts if practical without storing unnecessary personal data.

## Non-goals for initial release

Do not add:

- arbitrary user-added teams;
- automatic subscription changes based on later Telegram channel joins/leaves;
- per-team delivery-mode overrides;
- external-team publication channels;
- destructive legacy schema cleanup;
- fuzzy/aggressive branch merging when identity is uncertain.

## Final implementation direction

The implementation should prefer correctness and reversibility over cleverness:

- normalize teams and translations;
- retain work-level fetching for efficiency;
- preserve native RanobeLib branch identity;
- use conservative fallback fingerprints;
- make eligibility team-aware before outbox insertion;
- migrate existing users into the primary team without changing behavior;
- stage the cutover behind reversible switches;
- expose multi-team UX only after silent/shadow validation passes.

There are no remaining product or technical decisions blocking implementation planning.