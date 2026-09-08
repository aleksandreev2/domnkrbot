# Text Bot UX v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Telegram text-bot navigation with the approved UX v2: a neutral root menu, safe Back/Home/Delete semantics, resumable proposal drafts with five visible phases and field-level editing, a filtered proposal cabinet, and a notification dashboard with search, title cards, explicit toggles, stack progress, and recoverable errors.

**Architecture:** Keep the existing webhook ordering and durable D1 models. Extract pure Telegram payload builders into focused UI modules while leaving DB/network mutations in the existing proposal and notification runtimes. Add one forward-only UX migration for proposal edit-return state and notification search state. Preserve existing callback/deep-link compatibility by routing old callbacks to equivalent v2 screens/actions rather than deleting handlers.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Telegram Bot API, Node test runner, GitHub Actions, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-08-text-bot-ux-v2-design.md`

## Global Constraints

- No skull emoji in the new Telegram UX, including legacy list builders that remain reachable.
- `↩️ Назад` never deletes data.
- `🏠 Главное меню` never deletes an unfinished proposal draft.
- Only explicit destructive actions delete drafts/subscriptions, with confirmation for destructive bulk actions and meaningful proposal drafts.
- Prefer `editMessageText` for inline navigation. Send a new message only for text/file input or when Telegram cannot edit the source message.
- Do not make ordinary Telegram button callbacks wait for live RanobeLib network calls when D1 already contains the required catalog data.
- Preserve current notification delivery semantics and the D1 outbox as source of truth.
- Keep callback data under Telegram's 64-byte limit.
- Every behavior change follows RED -> minimal GREEN -> refactor only while green.
- Before merging: all migrations local, typecheck, complete test suite, Wrangler dry-run, PR diff review, and Cloudflare preview must be green. Merge to `main` automatically when all checks pass, per project workflow.

---

## Task 1: Add the UX state schema and shared navigation primitives

**Files:**
- Create: `migrations/0017_telegram_text_bot_ux_v2.sql`
- Create: `src/telegram-bot-ui.ts`
- Modify: `src/telegram-notification-settings.ts`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`
- Create: `tests/telegram-text-bot-ux-schema.test.mjs`
- Create: `tests/telegram-bot-ui.test.mjs`

### State model

`0017` adds:

```sql
ALTER TABLE telegram_proposal_sessions
  ADD COLUMN return_to_review INTEGER NOT NULL DEFAULT 0 CHECK (return_to_review IN (0, 1));

CREATE TABLE telegram_notification_search_state (
  user_telegram_id TEXT PRIMARY KEY,
  query TEXT NOT NULL DEFAULT '',
  page INTEGER NOT NULL DEFAULT 0,
  return_scope TEXT NOT NULL DEFAULT 'home'
    CHECK (return_scope IN ('home', 'mine', 'all')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_telegram_notification_search_expiry
  ON telegram_notification_search_state(expires_at);
```

Runtime schema repair must mirror the new search table and tolerate a duplicate `return_to_review` column, because older production entry points already self-heal notification schema.

`telegram-bot-ui.ts` owns only shared pure UI primitives:

```ts
export type TelegramButton = { text: string; callback_data?: string; url?: string };
export type TelegramPayload = {
  text: string;
  parse_mode?: 'HTML';
  reply_markup: { inline_keyboard: TelegramButton[][] };
};

export function buildMainMenu(origin: string): TelegramPayload;
export function mainMenuButton(): TelegramButton;
export function backButton(callbackData: string): TelegramButton;
export function destructiveButton(text: string, callbackData: string): TelegramButton;
```

`buildMainMenu` renders exactly the neutral v2 root hierarchy and contains no skull character.

### TDD steps

- [ ] Add migration tests asserting `0017` is forward-only, adds `return_to_review`, creates `telegram_notification_search_state`, constrains return scope, and contains no destructive `DROP`/rename operations.
- [ ] Add pure UI tests asserting the root menu text/buttons and asserting the rendered payload does not contain the skull character.
- [ ] Add tests for runtime schema repair of the search table and duplicate-column tolerance.
- [ ] Run only the new tests and confirm RED for missing migration/module/runtime helpers.
- [ ] Implement the migration, `telegram-bot-ui.ts`, search-state helpers/schema repair, and runtime-test/package wiring minimally.
- [ ] Run the new tests and the existing notification settings tests to GREEN.
- [ ] Commit: `feat: add text bot UX v2 navigation state`.

---

## Task 2: Replace proposal root navigation with safe draft resume/back/home/delete semantics

**Files:**
- Create: `src/telegram-title-proposal-ui.ts`
- Modify: `src/telegram-title-proposals.ts`
- Modify: `tsconfig.runtime-test.json`
- Modify: `tests/telegram-title-proposals.test.mjs`
- Modify: `tests/telegram-title-proposal-external.test.mjs`
- Modify: `tests/telegram-title-proposal-ranobelib.test.mjs`
- Add focused cases to: `tests/telegram-title-proposal-submit.test.mjs`

### Pure proposal UI boundary

Move proposal payload composition into `telegram-title-proposal-ui.ts` without moving D1/R2/RanobeLib mutations. Export focused builders, including:

```ts
export type ProposalUiSession = { /* only fields builders need */ };
export function proposalPhase(step: string): 1 | 2 | 3 | 4 | 5;
export function buildProposalSourceChoice(): TelegramPayload;
export function buildProposalResume(): TelegramPayload;
export function buildProposalDeleteConfirmation(): TelegramPayload;
export function buildProposalInputPrompt(step: string, session: ProposalUiSession): TelegramPayload;
export function buildProposalRawPrompt(session: ProposalUiSession): TelegramPayload;
export function buildProposalRawAdded(session: ProposalUiSession): TelegramPayload;
export function buildProposalCommentPrompt(session: ProposalUiSession): TelegramPayload;
export function buildProposalReview(session: ProposalUiSession): TelegramPayload;
export function buildProposalRanobeLibCandidates(...): TelegramPayload;
export function buildProposalRanobeLibConfirmation(...): TelegramPayload;
```

### Navigation callbacks

Introduce explicit v2 callbacks:

```text
prop:home
prop:resume
prop:back
prop:cancel
prop:cancel:confirm
prop:cancel:keep
```

Semantics:
- `prop:home`: render root menu, preserve session.
- `prop:new`: if a fresh/meaningful session exists, render resume screen; otherwise initialize `choose_source`.
- `/propose`: same behavior as `prop:new`.
- `prop:resume`: render the current session step without resetting it.
- `prop:back`: derive the previous logical step from current `step`/`source_kind`; update only the step necessary to return there.
- `prop:cancel`: if draft has meaningful data, show confirmation without deleting; empty phase-1 draft may return home directly.
- `prop:cancel:confirm`: delete session and render root.
- `prop:cancel:keep`: render current step again.

The five visible phases are fixed:
- `choose_source` -> 1/5
- `ranobelib_query`, `ranobelib_confirm`, `external_title`, `external_url` -> 2/5
- `raw` -> 3/5
- `comment` -> 4/5
- `review` -> 5/5

### Content fixes

- Remove the skull from `/start` and any proposal navigation text.
- Remove `Иммунитет: не удалось определить автоматически` from RanobeLib confirmation.
- RanobeLib search shows at most 6 candidate buttons at once. Keep compact index callbacks.
- RAW prompt explains 20 MB and file requirement; successful upload shows filename + human-readable size before continuing.
- Input/error prompts include useful Back/Home actions instead of generic cancellation.

### TDD steps

- [ ] Update `/start` test to require the neutral v2 menu and no skull.
- [ ] Add RED tests for `prop:home` preserving a session, `/propose`/`prop:new` offering resume, `prop:resume`, and non-destructive `prop:back`.
- [ ] Add RED tests for destructive cancellation confirmation and confirmed deletion only.
- [ ] Add RED tests for five-phase headers in both RanobeLib and external branches.
- [ ] Update RanobeLib tests to require the immunity placeholder to be absent and candidate page size <= 6.
- [ ] Add RAW-added card assertions (filename, formatted size, Continue/Replace/Back).
- [ ] Run the proposal-focused test files and confirm failures are only the new UX expectations.
- [ ] Implement pure builders and minimal runtime routing.
- [ ] Run all proposal tests to GREEN.
- [ ] Commit: `feat: add safe proposal navigation and draft resume UX`.

---

## Task 3: Add field-level proposal editing and actionable proposal errors

**Files:**
- Modify: `src/telegram-title-proposal-ui.ts`
- Modify: `src/telegram-title-proposals.ts`
- Modify: `tests/telegram-title-proposal-external.test.mjs`
- Modify: `tests/telegram-title-proposal-ranobelib.test.mjs`
- Modify: `tests/telegram-title-proposal-submit.test.mjs`

### Review edit callbacks

Replace the generic edit action with:

```text
prop:edit:title
prop:edit:source
prop:edit:raw
prop:edit:comment
```

Use `telegram_proposal_sessions.return_to_review` to reuse existing input steps:
- entering an edit sets `return_to_review = 1` and moves to the required step;
- successful edited input returns directly to `review` and clears the flag;
- Back from an edit returns to review without applying an unrelated destructive reset;
- editing RAW can replace or clear the current RAW metadata;
- for RanobeLib proposals, title/source edit re-enters RanobeLib query/confirmation; for external proposals it uses external title/source steps.

The review card contains four field buttons plus Submit/Back/Delete.

### Error recovery callbacks

Add actionable RanobeLib recovery callbacks:

```text
prop:retry:ranobelib
prop:query:again
```

A RanobeLib network/detail failure renders a message with Retry / Change query / Back / Home and preserves the draft. Stale/expired sessions render Start again / Home instead of only a callback toast.

### TDD steps

- [ ] Add RED test asserting review has four field-edit buttons and no generic-only `prop:edit` path.
- [ ] Add RED external-flow tests: edit title -> input -> review, edit source -> input -> review, edit comment -> input -> review, Back from edit -> review.
- [ ] Add RED RAW tests for replace and return-to-review behavior.
- [ ] Add RED RanobeLib edit test that re-selects a title and returns to review.
- [ ] Add RED network failure test requiring an actionable error keyboard and unchanged draft.
- [ ] Add RED stale-session recovery test requiring Start again/Home.
- [ ] Implement the edit-return flag mutations and recovery routes minimally.
- [ ] Run all proposal tests to GREEN.
- [ ] Commit: `feat: add proposal field editing and recovery UX`.

---

## Task 4: Turn “My proposals” into a filtered cabinet with stable card navigation

**Files:**
- Modify: `src/telegram-title-proposal-ui.ts`
- Modify: `src/telegram-title-proposals.ts`
- Modify: `tests/telegram-title-proposal-submit.test.mjs`
- Optionally create if test isolation is cleaner: `tests/telegram-title-proposal-cabinet.test.mjs`
- Modify `package.json` only if the new isolated test file is created.

### Callback model

Use compact callbacks:

```text
prop:mine                       # landing with counts
prop:mine:a:<page>              # active
prop:mine:d:<page>              # completed
prop:mine:x:<page>              # all
prop:view:<id>:<filter>:<page>   # card with deterministic return context
```

If an old `prop:view:<id>` message is clicked, show the same card with a safe fallback return to the My proposals landing.

Status groups:
- active: `pending`, `approved`, `planned`, `in_progress`
- completed: `done`, `rejected`
- all: all statuses visible to the user.

List queries must be server-paginated (page size 8) rather than loading an unbounded history. Counts for the three landing filters are fetched in one aggregate query when practical.

### Card content

Card shows:
- localized status;
- supporters;
- source link/type;
- submitter comment;
- team/admin note only when the current user owns the proposal;
- created and updated timestamps when present;
- support button for somebody else's active proposal;
- `↩️ К списку` with filter/page context;
- `🏠 Главное меню`.

Success and duplicate cards also gain consistent View / Propose again / Home navigation from the spec.

### TDD steps

- [ ] Add RED landing test for active/completed/all counts and Home button.
- [ ] Add RED list tests for status filtering, page size 8, status icon prefixes, and pagination callbacks.
- [ ] Add RED card test for deterministic Back-to-list context and Home.
- [ ] Add RED compatibility test for old `prop:view:<id>` callback.
- [ ] Add RED success/duplicate tests for the approved navigation buttons and support explanation.
- [ ] Implement filtered/count queries and builders minimally.
- [ ] Run proposal cabinet + existing submit/vote tests to GREEN.
- [ ] Commit: `feat: redesign Telegram proposal cabinet`.

---

## Task 5: Replace the notification landing screen with a dashboard and explicit title cards

**Files:**
- Create: `src/telegram-notification-ux.ts`
- Modify: `src/telegram-notification-controls.ts`
- Modify: `src/telegram-notification-mode-runtime.ts`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `tsconfig.runtime-test.json`
- Create: `tests/telegram-notification-ux.test.mjs`
- Modify: `tests/telegram-notification-controls.test.mjs`
- Modify: `tests/telegram-notification-controls-webhook.test.mjs`
- Modify: `tests/telegram-subscriptions.test.mjs`
- Modify: `tests/telegram-subscription-webhook.test.mjs`
- Modify: `package.json`

### Notification screen callbacks

Introduce v2 navigation callbacks while retaining existing mode callbacks:

```text
subs:center
subs:mine:<page>
subs:all:<page>
subs:title:<id>:<origin>:<page>      # opens card; no toggle
subs:title:toggle:<id>:<origin>:<page>
subs:title:mode:<id>:<origin>:<page>
subs:mode:home                       # global mode screen
subs:all:clear:confirm
subs:all:clear:yes
subs:home                            # root Telegram menu
```

Because historical `subs:title:<id>:<page>` callbacks already exist, continue parsing that old shape and reinterpret it safely as “open title card from all list”, never as an implicit toggle. Existing release-message callbacks `subs:notify:toggle:*` and `subs:notify:settings:*` remain valid.

### Dashboard

`subs:center` only renders:
- effective subscription count/scope;
- global delivery mode;
- override count;
- My subscriptions;
- Search;
- All translations;
- Delivery mode;
- Home.

It does not expose mode preset buttons directly.

### Lists and title card

- My subscriptions lists only effective subscriptions, page size 8.
- All translations lists active D1 catalog titles, page size 8.
- Selecting either list row opens a title card.
- Toggle is an explicit card button and preserves return origin/page.
- “Disable all” shows a confirmation screen before mutating subscriptions/exclusions/all_titles.
- Remove the existing skull from `Подписаться на все` or any remaining subscription UI.

Title card state contains:

```ts
{
  title,
  enabled,
  inherited,
  effectiveSetting,
  globalSetting,
  pendingChapterCount: number | null,
  returnContext: { origin: 'mine' | 'all' | 'search'; page: number }
}
```

For a stack effective mode, compute `pendingChapterCount` as `SUM(r.chapter_count)` for that user/title over unsent `pending|retry` outbox rows. Do not show a stack counter for instant mode.

### Delivery mode screen

Move global presets to the dedicated global mode screen. Per-title mode screen remains dedicated and has a true Back-to-title-card action. Existing custom input 2–100 and Queue wake-up behavior remain unchanged.

### TDD steps

- [ ] Add pure RED tests for dashboard, list, title-card, confirmation, and mode-screen payloads; assert no skull character.
- [ ] Update callback parser tests for explicit title-card/toggle/navigation forms plus old callback compatibility.
- [ ] Add runtime RED test: `prop:notifications`/`subs:center` opens dashboard, not preset controls.
- [ ] Add RED test: selecting a title does not mutate subscription state; explicit toggle does.
- [ ] Add RED tests for My subscriptions filtering and All translations pagination.
- [ ] Add RED test for destructive “Disable all” confirmation (first click no DB mutation, confirmed click mutates).
- [ ] Add RED stack-progress test and instant-mode omission test.
- [ ] Add RED tests ensuring old release notification controls still work.
- [ ] Implement `telegram-notification-ux.ts` and minimal runtime/query changes.
- [ ] Run all subscription/notification tests to GREEN.
- [ ] Commit: `feat: add notification dashboard and title cards`.

---

## Task 6: Add notification title search with resumable input state

**Files:**
- Modify: `src/telegram-notification-settings.ts`
- Modify: `src/telegram-notification-ux.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `src/telegram-subscriptions.ts` or add a focused runtime helper if separation is clearer
- Modify: `tests/telegram-notification-ux.test.mjs`
- Modify: `tests/telegram-notification-controls-webhook.test.mjs`
- Modify: `tests/telegram-subscription-webhook.test.mjs`
- Modify: `tests/telegram-text-bot-ux-schema.test.mjs`

### Search-state API

Add helpers:

```ts
export type NotificationSearchReturn = 'home' | 'mine' | 'all';
export async function beginNotificationSearch(env, userId, returnScope): Promise<void>;
export async function getNotificationSearchState(env, userId): Promise<... | null>;
export async function saveNotificationSearchQuery(env, userId, query, page): Promise<void>;
export async function clearNotificationSearch(env, userId): Promise<void>;
```

State expires after 10 minutes. Search input has priority only after custom stack input has had first chance, so entering a stack size can never be mistaken for a title search.

Callbacks:

```text
subs:search:<returnScope>
subs:search:page:<page>
subs:search:again
subs:title:<id>:search:<page>
```

Search SQL uses the local active `ranobelib_titles` catalog and normalized case-insensitive substring matching. Return at most 8 rows/page. Search callbacks must not call the upstream RanobeLib API.

### TDD steps

- [ ] Add RED state-helper tests for begin/save/get/expiry/clear.
- [ ] Add RED webhook test: search button prompts for text and records return scope.
- [ ] Add RED precedence test: active custom-stack input consumes numeric text before search state.
- [ ] Add RED search results test (matching, page size <= 8, pagination, Search again, Back).
- [ ] Add RED test that search result title opens a card and Back returns to search results.
- [ ] Add RED test proving callback/search execution performs no RanobeLib HTTP request.
- [ ] Implement state/query/runtime routing minimally.
- [ ] Run notification + webhook tests to GREEN.
- [ ] Commit: `feat: add Telegram notification title search`.

---

## Task 7: Complete recovery, compatibility, documentation, and end-to-end regression coverage

**Files:**
- Modify: `src/telegram-title-proposals.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `src/telegram-notification-mode-runtime.ts`
- Modify: `README.md`
- Modify: `tests/telegram-title-proposal-release-readiness.test.mjs`
- Modify: `tests/telegram-subscription-wiring.test.mjs`
- Create: `tests/telegram-text-bot-ux-e2e.test.mjs`
- Modify: `package.json`

### End-to-end scenarios

Cover the real handler order used by `entry.ts` and the real callback names:

1. `/start` -> neutral menu -> Notifications -> dashboard -> My subscriptions -> title card -> mode -> Back -> title card -> Home.
2. `/start` -> Propose -> choose external -> title/source -> RAW skip -> comment skip -> review -> edit comment -> review -> submit -> success -> Home.
3. `/start` -> Propose with existing draft -> Resume -> Back -> Home -> reopen -> Resume (draft still present) -> Delete -> confirmation -> delete.
4. RanobeLib query failure -> Retry/Change query/Home recovery without losing session.
5. My proposals -> Active -> card -> Back preserves list page/filter.
6. Notification search -> query -> result card -> Back to results.
7. Historical callbacks (`prop:notifications`, old `subs:title:<id>:<page>`, `subs:notify:settings:*`, `subs:notify:toggle:*`, old `prop:view:<id>`) produce useful v2 behavior rather than errors.

### Release readiness

README must document:
- v2 navigation semantics;
- resumable proposal drafts;
- notification dashboard/search/title cards;
- stack progress meaning;
- no claim that Back/Home deletes drafts.

Add a source-level guard test that new Telegram UX files and the root menu do not contain the skull character.

### TDD and verification steps

- [ ] Add the end-to-end regression file first and confirm RED for any remaining gaps.
- [ ] Fill only the missing integration/recovery behavior until E2E is GREEN.
- [ ] Update README and release-readiness tests.
- [ ] Run `npm run db:local` (or the CI-equivalent local migration job) and verify all 17 migrations apply from a clean local DB.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and require every test to pass.
- [ ] Run `npx wrangler deploy --dry-run`.
- [ ] Commit: `test: verify text bot UX v2 end to end`.

---

## Task 8: PR review, production-preview verification, and automatic merge

**Files:** no planned production code changes unless review discovers a defect.

- [ ] Open/update a single PR `feature/text-bot-ux-v2 -> main` with the approved spec and this plan linked in the body.
- [ ] Review the complete diff for accidental unrelated refactors, callback values over 64 bytes, destructive navigation, live RanobeLib calls on ordinary subscription callbacks, and any skull character in Telegram UX.
- [ ] Run/fetch fresh CI for the exact final head SHA; require migration apply, typecheck, all tests, and Wrangler dry-run success.
- [ ] Verify the Cloudflare branch/commit preview succeeds for the same head.
- [ ] If review finds a defect, add a failing regression test first, fix it, and repeat fresh verification.
- [ ] Mark PR ready when clean.
- [ ] Merge to `main` automatically once the exact final head is green and mergeable.
- [ ] Verify the post-merge `main` CI and production-smoke correspond to the merge commit before claiming the UX is live.
