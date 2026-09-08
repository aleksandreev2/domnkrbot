# Text Bot UX v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Telegram text-bot navigation with the approved UX v2: a neutral root menu, safe Back/Home/Delete semantics, resumable proposal drafts with five visible phases and field-level editing, a filtered proposal cabinet, and a notification dashboard with search, title cards, explicit toggles, stack progress, and recoverable errors.

**Architecture:** Keep the existing webhook ordering and durable D1 models. Extract pure Telegram payload builders into focused UI modules while leaving DB/network mutations in the existing proposal and notification runtimes. Add one forward-only UX migration plus one focused runtime schema-repair module. Preserve existing callback/deep-link compatibility by routing old callbacks to equivalent v2 screens/actions rather than deleting handlers.

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

## Task 1: Add UX state schema and shared navigation primitives

**Files:**
- Create: `migrations/0017_telegram_text_bot_ux_v2.sql`
- Create: `src/telegram-text-bot-ux-schema.ts`
- Create: `src/telegram-bot-ui.ts`
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

`telegram-text-bot-ux-schema.ts` owns runtime repair for only these v2 additions:

```ts
export type TelegramTextBotUxSchemaEnv = { DB: D1DatabaseLike };
export async function ensureTelegramTextBotUxSchema(env: TelegramTextBotUxSchemaEnv): Promise<void>;
```

The repair:
- attempts `ALTER TABLE telegram_proposal_sessions ADD COLUMN return_to_review ...` and ignores only duplicate-column errors;
- creates `telegram_notification_search_state` and its expiry index with `IF NOT EXISTS`;
- does not mutate notification delivery triggers.

`telegram-bot-ui.ts` owns shared pure UI primitives:

```ts
export type TelegramButton = { text: string; callback_data?: string; url?: string };
export type TelegramPayload = {
  text: string;
  parse_mode?: 'HTML';
  reply_markup: { inline_keyboard: TelegramButton[][] };
};

export function buildMainMenu(origin: string): TelegramPayload;
export function mainMenuButton(callbackData?: string): TelegramButton;
export function backButton(callbackData: string): TelegramButton;
export function destructiveButton(text: string, callbackData: string): TelegramButton;
```

`buildMainMenu` renders the neutral v2 root hierarchy and contains no skull character.

### TDD steps

- [ ] Add migration tests asserting `0017` is forward-only, adds `return_to_review`, creates `telegram_notification_search_state`, constrains return scope, and contains no destructive `DROP`/rename operations.
- [ ] Add pure UI tests asserting the root menu text/buttons and asserting the rendered payload does not contain the skull character.
- [ ] Add schema-repair tests for table creation and duplicate `return_to_review` tolerance.
- [ ] Run only the new tests and confirm RED for missing migration/modules.
- [ ] Implement the migration and the two focused modules minimally; add them to runtime-test/package wiring.
- [ ] Run the new tests to GREEN.
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
- Modify: `tests/telegram-title-proposal-submit.test.mjs`

### Pure proposal UI boundary

Move payload composition into `telegram-title-proposal-ui.ts`; keep D1/R2/RanobeLib mutations in `telegram-title-proposals.ts`.

```ts
export type ProposalUiSession = {
  step: string;
  source_kind: string | null;
  ranobelib_book_ref: string | null;
  title: string;
  original_title: string;
  source_url: string;
  raw_file_id: string | null;
  raw_file_name: string | null;
  raw_file_size: number | string | null;
  comment: string;
  return_to_review: number | string | null;
};

export type ProposalCandidateUi = { index: number; title: string };
export type RanobeLibConfirmationUi = {
  title: string;
  url: string;
  status: string;
  teamNames: string[];
  uploaded: number;
  latestNumber: string;
  latestName: string | null;
};

export function proposalPhase(step: string): 1 | 2 | 3 | 4 | 5;
export function buildProposalSourceChoice(): TelegramPayload;
export function buildProposalResume(session: ProposalUiSession): TelegramPayload;
export function buildProposalDeleteConfirmation(): TelegramPayload;
export function buildProposalInputPrompt(step: string, session: ProposalUiSession): TelegramPayload;
export function buildProposalRawPrompt(session: ProposalUiSession): TelegramPayload;
export function buildProposalRawAdded(session: ProposalUiSession): TelegramPayload;
export function buildProposalCommentPrompt(session: ProposalUiSession): TelegramPayload;
export function buildProposalReview(session: ProposalUiSession): TelegramPayload;
export function buildProposalRanobeLibCandidates(candidates: ProposalCandidateUi[], page: number, totalPages: number): TelegramPayload;
export function buildProposalRanobeLibConfirmation(detail: RanobeLibConfirmationUi): TelegramPayload;
```

### Navigation callbacks

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
- `prop:new` and `/propose`: if a fresh meaningful session exists, render resume screen; otherwise initialize `choose_source`.
- `prop:resume`: render current session step without resetting it.
- `prop:back`: derive previous logical step from current `step`/`source_kind` and preserve entered fields.
- `prop:cancel`: meaningful draft -> confirmation; empty phase-1 draft -> root without destructive copy.
- `prop:cancel:confirm`: delete session and render root.
- `prop:cancel:keep`: render current step again.

Five visible phases:
- `choose_source` -> 1/5
- `ranobelib_query`, `ranobelib_confirm`, `external_title`, `external_url` -> 2/5
- `raw` -> 3/5
- `comment` -> 4/5
- `review` -> 5/5

### Content fixes

- Remove skull from `/start` and proposal navigation.
- Remove `Иммунитет: не удалось определить автоматически`.
- RanobeLib result page shows at most 6 candidates and uses compact candidate-index callbacks.
- RAW prompt explains the 20 MB document limit; successful upload shows filename and human-readable size before the user continues.
- Input/error screens expose Back/Home rather than using generic destructive cancellation as navigation.

### TDD steps

- [ ] Update `/start` test for neutral v2 menu and no skull.
- [ ] Add RED tests for `prop:home` preserving session, `/propose`/`prop:new` resume, `prop:resume`, and non-destructive `prop:back`.
- [ ] Add RED tests for cancellation confirmation and deletion only on `prop:cancel:confirm`.
- [ ] Add RED phase-header tests in both RanobeLib and external branches.
- [ ] Update RanobeLib tests: immunity placeholder absent; max 6 candidate buttons/page.
- [ ] Add RAW-added card assertions: filename, formatted size, Continue/Replace/Back.
- [ ] Run proposal-focused tests and confirm RED only on new UX expectations.
- [ ] Implement builders and minimal runtime routing.
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

```text
prop:edit:title
prop:edit:source
prop:edit:raw
prop:edit:comment
prop:raw:replace
prop:raw:clear
```

Use `return_to_review` to reuse existing input steps:
- entering an edit sets `return_to_review = 1` and moves to the required existing step;
- successful edited input returns to `review` and clears the flag;
- Back while `return_to_review = 1` returns to review;
- editing RAW may replace or explicitly clear RAW metadata;
- RanobeLib title/source edit re-enters RanobeLib query/confirmation; external edit uses external title/source steps.

Review card contains Submit, four field buttons, Back, Delete.

### Error recovery callbacks

```text
prop:retry:ranobelib
prop:query:again
prop:start:again
```

RanobeLib network/detail failure renders Retry / Change query / Back / Home and preserves draft. Stale/expired sessions render Start again / Home rather than only a toast.

### TDD steps

- [ ] Add RED test: review has all four field-edit buttons and no generic-only `prop:edit` path.
- [ ] Add RED external edit tests: title -> input -> review; source -> input -> review; comment -> input -> review; Back from edit -> review.
- [ ] Add RED RAW replace/clear/return-to-review tests.
- [ ] Add RED RanobeLib edit test that re-selects a title and returns to review.
- [ ] Add RED network failure test for actionable recovery keyboard and unchanged draft.
- [ ] Add RED stale-session test for Start again/Home.
- [ ] Implement flag mutations and recovery routes minimally.
- [ ] Run all proposal tests to GREEN.
- [ ] Commit: `feat: add proposal field editing and recovery UX`.

---

## Task 4: Turn My proposals into a filtered cabinet with stable card navigation

**Files:**
- Modify: `src/telegram-title-proposal-ui.ts`
- Modify: `src/telegram-title-proposals.ts`
- Create: `tests/telegram-title-proposal-cabinet.test.mjs`
- Modify: `tests/telegram-title-proposal-submit.test.mjs`
- Modify: `package.json`

### Callback model

```text
prop:mine
prop:mine:a:<page>
prop:mine:d:<page>
prop:mine:x:<page>
prop:view:<id>:<filter>:<page>
```

Filter tokens are `a` (active), `d` (completed), `x` (all). Old `prop:view:<id>` remains accepted and falls back to My proposals landing on Back.

Status groups:
- active: `pending`, `approved`, `planned`, `in_progress`
- completed: `done`, `rejected`
- all: all statuses visible to the current user.

Lists use server-side `LIMIT 8 OFFSET ?`. Landing counts use one aggregate query with conditional sums.

Card shows localized status, supporters, source, submitter comment, owner-visible admin note, created/updated dates, optional support/source buttons, deterministic `↩️ К списку`, and Home.

Success/duplicate cards expose View / Propose again / Home and duplicate copy explains what support means.

### TDD steps

- [ ] Create RED cabinet tests for active/completed/all counts and Home.
- [ ] Add RED list tests for status filters, LIMIT 8, status prefixes, and pagination callbacks.
- [ ] Add RED card test for filter/page Back context and Home.
- [ ] Add RED old `prop:view:<id>` compatibility test.
- [ ] Add RED success/duplicate tests for v2 navigation and support explanation.
- [ ] Implement aggregate/list queries and pure builders minimally.
- [ ] Run cabinet plus existing submit/vote tests to GREEN.
- [ ] Commit: `feat: redesign Telegram proposal cabinet`.

---

## Task 5: Replace notification landing with dashboard, explicit title cards, and dedicated mode screens

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

### Callback model

```text
subs:center
subs:mine:<page>
subs:all:<page>
subs:title:<id>:<origin>:<page>
subs:title:toggle:<id>:<origin>:<page>
subs:title:mode:<id>:<origin>:<page>
subs:mode:home
subs:all:clear:confirm
subs:all:clear:yes
subs:home
```

`origin` tokens are `m` (mine), `a` (all), `s` (search), keeping callbacks short.

Historical `subs:title:<id>:<page>` remains accepted and is reinterpreted as “open title card from All translations” rather than implicit toggle. Existing release controls `subs:notify:toggle:*` and `subs:notify:settings:*` remain valid.

### Dashboard

`subs:center` renders only:
- effective subscription scope/count;
- global delivery mode;
- override count;
- My subscriptions;
- Search;
- All translations;
- Delivery mode;
- Home.

It does not render mode presets directly.

### Lists and title card

- My subscriptions: only effective subscriptions, 8/page.
- All translations: active D1 catalog, 8/page.
- Row click opens card; explicit card button performs toggle.
- Disable-all first shows confirmation and mutates only on confirmed callback.
- Remove skull from all remaining subscription UI.

```ts
export type NotificationTitleCardState = {
  title: { ranobelib_id: number; book_ref: string; title: string; url: string };
  enabled: boolean;
  inherited: boolean;
  effectiveSetting: DeliverySetting;
  globalSetting: DeliverySetting;
  pendingChapterCount: number | null;
  returnContext: { origin: 'm' | 'a' | 's'; page: number };
};
```

For stack mode, `pendingChapterCount` is `SUM(r.chapter_count)` joined from unsent `pending|retry` outbox rows for that user/title. Instant mode omits the counter.

Global presets move to `subs:mode:home`. Per-title mode screen has true Back-to-card. Existing custom 2–100 input and Queue wake-up semantics stay unchanged.

### TDD steps

- [ ] Create pure RED tests for dashboard, My/All lists, title card, disable-all confirmation, global mode screen, and per-title mode screen; assert no skull.
- [ ] Update parser RED tests for new compact navigation callbacks and old callback compatibility.
- [ ] Add runtime RED: `prop:notifications`/`subs:center` opens dashboard without preset buttons.
- [ ] Add RED: title row click performs no subscription mutation; explicit toggle does.
- [ ] Add RED My subscriptions and All translations pagination/filter tests.
- [ ] Add RED disable-all confirmation test: first click no mutation, confirmed click mutates.
- [ ] Add RED stack-progress and instant-counter-omission tests.
- [ ] Add RED existing release-control compatibility tests.
- [ ] Implement pure UI/runtime/query changes minimally.
- [ ] Run all subscription/notification tests to GREEN.
- [ ] Commit: `feat: add notification dashboard and title cards`.

---

## Task 6: Add notification title search with resumable input state

**Files:**
- Modify: `src/telegram-text-bot-ux-schema.ts`
- Modify: `src/telegram-notification-ux.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `tests/telegram-notification-ux.test.mjs`
- Modify: `tests/telegram-notification-controls-webhook.test.mjs`
- Modify: `tests/telegram-subscription-webhook.test.mjs`
- Modify: `tests/telegram-text-bot-ux-schema.test.mjs`

### Search-state API

```ts
export type NotificationSearchReturn = 'home' | 'mine' | 'all';
export type NotificationSearchState = {
  query: string;
  page: number;
  returnScope: NotificationSearchReturn;
};

export async function beginNotificationSearch(env, userId, returnScope): Promise<void>;
export async function getNotificationSearchState(env, userId): Promise<NotificationSearchState | null>;
export async function saveNotificationSearchQuery(env, userId, query, page): Promise<void>;
export async function clearNotificationSearch(env, userId): Promise<void>;
```

State expires after 10 minutes. Custom stack input gets first chance at ordinary private text; search input is checked second, so a stack size is never mistaken for a title query.

Callbacks:

```text
subs:search:h
subs:search:m
subs:search:a
subs:search:page:<page>
subs:search:again
subs:title:<id>:s:<page>
```

Search uses only active local `ranobelib_titles`, case-insensitive substring matching, 8 rows/page, and no upstream RanobeLib HTTP call.

### TDD steps

- [ ] Add RED helper tests for begin/save/get/expiry/clear.
- [ ] Add RED webhook test: search button prompts and records return scope.
- [ ] Add RED precedence test: active custom-stack input consumes numeric text before search state.
- [ ] Add RED results test for matching, max 8/page, pagination, Search again, Back.
- [ ] Add RED result-card test: Back returns to the same results page.
- [ ] Add RED test proving search callbacks/input make no upstream RanobeLib HTTP request.
- [ ] Implement state/query/runtime routing minimally.
- [ ] Run notification/webhook tests to GREEN.
- [ ] Commit: `feat: add Telegram notification title search`.

---

## Task 7: Complete recovery, compatibility, docs, and end-to-end regression coverage

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

1. `/start` -> Notifications -> dashboard -> My subscriptions -> title card -> mode -> Back -> card -> Home.
2. `/start` -> Propose -> external -> title/source -> RAW skip -> comment skip -> review -> edit comment -> review -> submit -> success -> Home.
3. Existing draft -> Resume -> Back -> Home -> reopen -> Resume -> Delete -> confirmation -> delete.
4. RanobeLib failure -> Retry/Change query/Home without losing draft.
5. My proposals -> Active -> page/card -> Back preserves filter/page.
6. Notification search -> query -> result card -> Back preserves results page.
7. Historical callbacks `prop:notifications`, `subs:title:<id>:<page>`, `subs:notify:settings:*`, `subs:notify:toggle:*`, old `prop:view:<id>` all produce useful v2 behavior.

README documents v2 navigation semantics, resumable drafts, notification dashboard/search/cards, and stack progress. Add a source-level guard asserting Telegram UX/root menu files contain no skull character.

### TDD and verification steps

- [ ] Add the E2E regression file first and confirm RED for remaining gaps.
- [ ] Fill only missing integration/recovery behavior until E2E GREEN.
- [ ] Update README and release-readiness tests.
- [ ] Run clean local migration verification through all 17 migrations (same command used by CI: `npx wrangler d1 migrations apply DB --local`).
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and require every test to pass.
- [ ] Run `npx wrangler deploy --dry-run`.
- [ ] Commit: `test: verify text bot UX v2 end to end`.

---

## Task 8: PR review, production-preview verification, and automatic merge

**Files:** no planned production-code changes unless review discovers a defect.

- [ ] Open/update one PR `feature/text-bot-ux-v2 -> main`, linking the approved spec and this plan.
- [ ] Review complete diff for unrelated refactors, callbacks over 64 bytes, destructive Back/Home behavior, live RanobeLib calls on ordinary subscription callbacks, and skull characters in Telegram UX.
- [ ] Fetch fresh CI for exact final head SHA; require migration apply, typecheck, all tests, and Wrangler dry-run success.
- [ ] Verify Cloudflare branch/commit preview succeeds for that same head.
- [ ] If review finds a defect, add a failing regression test first, fix it, and repeat fresh verification.
- [ ] Mark PR ready when clean.
- [ ] Merge to `main` automatically once exact final head is green and mergeable.
- [ ] Verify post-merge `main` CI and production-smoke correspond to the merge commit before claiming UX is live.
