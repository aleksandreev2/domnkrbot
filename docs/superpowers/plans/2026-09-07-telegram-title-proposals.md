# Telegram Title Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete Telegram-native title proposal wizard with RanobeLib/external branches, RAW file intake, deduplication, user proposal tracking, status notifications, and a richer moderation UI without breaking existing subscriptions, website flows, publishing, or RanobeLib sync.

**Architecture:** Keep `chapter_proposals` as the canonical proposal entity and extend it with source metadata and a stable RanobeLib link. Add a small server-side Telegram conversation-state table with TTL, a focused Telegram proposal handler wired before the subscription handler, and reuse `proposal_raw_uploads` for completed Telegram RAW attachments. Extend the existing admin APIs/UI instead of introducing a second moderation system.

**Tech Stack:** Cloudflare Workers, TypeScript 5.8, D1/SQLite, R2, Telegram Bot API, existing vanilla JS admin frontend, Node `node:test` runtime tests.

**Spec:** `docs/superpowers/specs/2026-09-07-telegram-title-proposals-design.md`

## Global Constraints

- Telegram is the primary proposal submission interface; the website proposal flow must continue working.
- The wizard must support both `ranobelib` and `external` sources.
- RAW means an uploaded Telegram document/file, not a URL requirement.
- Existing `/subscriptions`, `/notifications`, webhook secret validation, Telegram Login, publishing, RanobeLib sync, D1 data, and website proposal APIs must remain compatible.
- D1 changes are forward-only in migration `0013_telegram_title_proposals.sql`.
- Exact immunity must only be displayed when backed by a confirmed source; otherwise show `⚪ Иммунитет: не удалось определить автоматически`.
- Active duplicates must be reused/supported instead of creating another proposal.
- Conversation state must be server-side and expire after 24 hours of inactivity.
- Unexpected input during an active wizard must produce a useful retry prompt instead of being silently swallowed.

---

### Task 1: Proposal schema and conversation-state primitives

**Files:**
- Create: `migrations/0013_telegram_title_proposals.sql`
- Create: `src/telegram-title-proposals.ts`
- Create: `tests/telegram-title-proposals.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `ensureTelegramTitleProposalSchema(env)`, `buildProposalMainMenu(origin)`, `parseProposalCallback(value)`, and `handleTelegramTitleProposalWebhookRequest(request, env)`.
- Conversation steps are exact string values: `choose_source`, `ranobelib_query`, `ranobelib_confirm`, `external_title`, `external_url`, `raw`, `comment`, `review`.

- [ ] **Step 1: Write failing schema/menu/parser tests**

```js
assert.equal(buildProposalMainMenu('https://bot.example').reply_markup.inline_keyboard[0][0].callback_data, 'prop:new');
assert.deepEqual(parseProposalCallback('prop:source:ranobelib'), { kind: 'source', source: 'ranobelib' });
assert.deepEqual(parseProposalCallback('prop:cancel'), { kind: 'cancel' });
```

Add a fake-D1 assertion that schema initialization issues `CREATE TABLE IF NOT EXISTS telegram_proposal_sessions` and attempts to add `source_kind` / `ranobelib_book_ref` to `chapter_proposals` only through migration-compatible runtime guards.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build:runtime-test && node --test tests/telegram-title-proposals.test.mjs`

Expected: FAIL because the new module does not exist.

- [ ] **Step 3: Add migration and minimal module**

Migration shape:

```sql
ALTER TABLE chapter_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE chapter_proposals ADD COLUMN ranobelib_book_ref TEXT;
ALTER TABLE chapter_proposals ADD COLUMN status_notified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_chapter_proposals_ranobelib_active
  ON chapter_proposals(ranobelib_book_ref, status);

CREATE TABLE IF NOT EXISTS telegram_proposal_sessions (
  user_telegram_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  step TEXT NOT NULL,
  source_kind TEXT,
  ranobelib_book_ref TEXT,
  title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  raw_file_id TEXT,
  raw_file_unique_id TEXT,
  raw_file_name TEXT,
  raw_file_size INTEGER,
  raw_mime_type TEXT,
  comment TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

The module exports a main menu with buttons `📚 Предложить новеллу`, `🔔 Уведомления`, `🗂 Мои заявки`, `🌐 Сайт`, plus callback parsing for the `prop:` namespace.

- [ ] **Step 4: Run focused tests**

Run: `npm run build:runtime-test && node --test tests/telegram-title-proposals.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0013_telegram_title_proposals.sql src/telegram-title-proposals.ts tests/telegram-title-proposals.test.mjs tsconfig.runtime-test.json package.json
git commit -m "feat: add Telegram proposal state foundation"
```

---

### Task 2: `/start`, `/propose`, source choice, and state transitions

**Files:**
- Modify: `src/telegram-title-proposals.ts`
- Modify: `src/entry.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `tests/telegram-title-proposals.test.mjs`
- Modify: `tests/telegram-subscription-webhook.test.mjs`
- Modify: `tests/telegram-subscription-wiring.test.mjs`

**Interfaces:**
- Consumes: `handleTelegramTitleProposalWebhookRequest` from Task 1.
- Produces: exact `/start` main-menu behavior and `/propose` wizard entry.

- [ ] **Step 1: Add failing webhook routing tests**

```js
const response = await handleTelegramTitleProposalWebhookRequest(telegramRequest('/start'), env);
assert.equal(response?.status, 200);
assert.match(send.payload.text, /Дом Некроманта/);
assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:new');
```

Add tests for `/propose`, `prop:new`, `prop:source:ranobelib`, `prop:source:external`, `prop:back`, and `prop:cancel`.

- [ ] **Step 2: Verify failure**

Run: `npm run build:runtime-test && node --test tests/telegram-title-proposals.test.mjs tests/telegram-subscription-webhook.test.mjs tests/telegram-subscription-wiring.test.mjs`

Expected: FAIL because routing is still owned by the subscription/legacy handlers.

- [ ] **Step 3: Wire handler before subscription handler**

`src/entry.ts` order must be:

```ts
const proposalResponse = await handleTelegramTitleProposalWebhookRequest(request, env);
if (proposalResponse) return proposalResponse;
const subscriptionResponse = await handleTelegramSubscriptionWebhookRequest(request, env);
if (subscriptionResponse) return subscriptionResponse;
```

Change the subscription handler so exact `/start` is no longer treated as the subscriptions command; `/subscriptions` remains unchanged and `/start dl_*` remains available to reader delivery.

- [ ] **Step 4: Implement state persistence and TTL**

`/propose` and `prop:new` replace any unfinished session with `step='choose_source'`. `prop:cancel` deletes it. Loading a session older than 24 hours deletes it and returns no active wizard.

- [ ] **Step 5: Run routing tests**

Run the focused command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/entry.ts src/telegram-title-proposals.ts src/telegram-subscription-webhook.ts tests/telegram-title-proposals.test.mjs tests/telegram-subscription-webhook.test.mjs tests/telegram-subscription-wiring.test.mjs
git commit -m "feat: route Telegram proposal wizard"
```

---

### Task 3: RanobeLib lookup, title confirmation, and exact-immunity fallback

**Files:**
- Modify: `src/telegram-title-proposals.ts`
- Modify: `tests/telegram-title-proposals.test.mjs`

**Interfaces:**
- Produces: `findRanobeLibCandidates(env, query, limit=5)` and `formatRanobeLibCandidateDetails(row)`.
- Candidate identity uses `book_ref`; `ranobelib_id` is presentation/search metadata only.

- [ ] **Step 1: Add failing candidate lookup tests**

```js
const matches = await findRanobeLibCandidates(env, 'магл', 5);
assert.equal(matches[0].book_ref, '123--mage');
assert.match(formatRanobeLibCandidateDetails(matches[0]), /Иммунитет: не удалось определить автоматически/);
```

Test both a RanobeLib URL containing `/book/<book_ref>` and plain text search. Plain text search must be case-insensitive over `title` and `slug`, ordered by exact-title match first and then recent sync/title.

- [ ] **Step 2: Verify failure**

Run: `npm run build:runtime-test && node --test tests/telegram-title-proposals.test.mjs`

Expected: FAIL because lookup is not implemented.

- [ ] **Step 3: Implement lookup and confirmation callbacks**

When `step='ranobelib_query'`, accept text only. URL input extracts `book_ref`; text input queries local `ranobelib_titles`. Candidate buttons use callback data `prop:pick:<ranobelib_id>` and resolve back to the row before storing `ranobelib_book_ref`.

Candidate details show title, chapter count, latest chapter number/name when available, URL, and exactly:

```text
⚪ Иммунитет: не удалось определить автоматически
```

unless a future confirmed immunity source is explicitly implemented.

- [ ] **Step 4: Run focused tests**

Run the focused command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram-title-proposals.ts tests/telegram-title-proposals.test.mjs
git commit -m "feat: add RanobeLib proposal lookup"
```

---

### Task 4: External flow, RAW Telegram document intake, and review screen

**Files:**
- Modify: `src/telegram-title-proposals.ts`
- Modify: `tests/telegram-title-proposals.test.mjs`

**Interfaces:**
- RAW metadata stored in the session: `raw_file_id`, `raw_file_unique_id`, `raw_file_name`, `raw_file_size`, `raw_mime_type`.
- Supported extensions: `.epub`, `.txt`, `.zip`, `.fb2`, `.docx`.
- Maximum Telegram RAW size accepted by the wizard: 20 MiB.

- [ ] **Step 1: Add failing external/RAW tests**

Cover `external_title -> external_url -> raw -> comment -> review`, `prop:raw:skip`, `prop:comment:skip`, unsupported file extension, oversized file, and an unexpected text message while `step='raw'`.

- [ ] **Step 2: Verify failure**

Run: `npm run build:runtime-test && node --test tests/telegram-title-proposals.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement input validation**

External URL must start with `http://` or `https://`. RAW must arrive as `message.document`; no URL is accepted as a RAW substitute. Unsupported/oversized documents keep the session on `raw` and explain the reason.

- [ ] **Step 4: Build deterministic review message**

Review contains source type, title, RanobeLib URL or external URL, RAW attached/not attached, comment, and immunity fallback for the RanobeLib branch. Buttons: `📨 Отправить` (`prop:submit`), `✏️ Изменить` (`prop:edit`), `❌ Отмена` (`prop:cancel`).

- [ ] **Step 5: Run focused tests and commit**

Run the focused command from Step 2; expected PASS.

```bash
git add src/telegram-title-proposals.ts tests/telegram-title-proposals.test.mjs
git commit -m "feat: complete Telegram proposal wizard inputs"
```

---

### Task 5: Deduplication, proposal creation, RAW persistence, and “My proposals”

**Files:**
- Modify: `src/telegram-title-proposals.ts`
- Modify: `tests/telegram-title-proposals.test.mjs`

**Interfaces:**
- Produces: `findActiveDuplicate(env, draft)`, `createProposalFromSession(env, user, session)`, `sendMyProposals(env, user, chatId)`.
- Active statuses for duplicate detection: `pending`, `approved`, `planned`, `in_progress`.

- [ ] **Step 1: Add failing duplicate/create/list tests**

RanobeLib duplicates match `ranobelib_book_ref`. External duplicates match normalized lowercased title plus normalized source host/path where present. A duplicate response offers `prop:support:<proposal_id>` and `prop:view:<proposal_id>` rather than inserting.

- [ ] **Step 2: Verify failure**

Run the focused test file; expected FAIL.

- [ ] **Step 3: Implement creation transaction sequence**

Upsert the Telegram user, create `chapter_proposals` with `proposal_type='title'`, `source_kind`, and `ranobelib_book_ref`, then create/update `title_proposal_details`. If a RAW document is attached and `FILES` is configured, use Telegram `getFile`, download the file, put it under `proposal-raw/<user>/<uuid>/<sanitized-name>`, then create a completed `proposal_raw_uploads` row with `r2_upload_id='telegram:<file_unique_id>'`, `status='ready'`, and attach it through `title_proposal_details.raw_upload_id`.

If R2 is not configured, proposal submission remains possible but the bot explicitly says the RAW could not be persisted and asks the user to submit without RAW or retry later; do not silently discard the file.

- [ ] **Step 4: Implement support/view/my-proposals callbacks**

`prop:mine` lists up to 10 newest proposals. `prop:view:<id>` only reveals proposals visible to the requesting user. `prop:support:<id>` inserts into `proposal_votes` unless the requester is the proposal owner or already voted.

- [ ] **Step 5: Run focused tests and commit**

Run focused tests; expected PASS.

```bash
git add src/telegram-title-proposals.ts tests/telegram-title-proposals.test.mjs
git commit -m "feat: persist and track Telegram proposals"
```

---

### Task 6: Status-change notifications and admin API enrichment

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/title-proposal-admin.ts`
- Create: `tests/title-proposal-admin-v2.test.mjs`
- Modify: `tests/telegram-title-proposals.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- Admin status updates continue using `/api/admin/proposals/:id/status`.
- Status-change notification is sent only after the D1 update succeeds.

- [ ] **Step 1: Add failing tests for enriched admin details and notification**

Admin detail rows must include `source_kind`, `ranobelib_book_ref`, RanobeLib metadata, RAW metadata, vote count, and user identity. Changing status to `planned`, `in_progress`, `done`, or `rejected` with `adminNote` must send a Telegram message to `user_telegram_id`.

- [ ] **Step 2: Verify failure**

Run: `npm run build:runtime-test && node --test tests/title-proposal-admin-v2.test.mjs tests/telegram-title-proposals.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Extend admin data query**

Join `ranobelib_titles`, `title_proposal_details`, `proposal_raw_uploads`, and vote counts in the existing admin title-proposal endpoint. Return the exact stored source type rather than inferring it from title text.

- [ ] **Step 4: Send status notification after successful status update**

Text format:

```text
📚 Статус заявки изменился

«<title>» → <localized status>
<admin note when non-empty>
```

Telegram delivery failure must be logged but must not roll back the already-valid admin status update.

- [ ] **Step 5: Run focused tests and commit**

Run focused tests; expected PASS.

```bash
git add src/worker.ts src/title-proposal-admin.ts tests/title-proposal-admin-v2.test.mjs tests/telegram-title-proposals.test.mjs tsconfig.runtime-test.json package.json
git commit -m "feat: notify proposal owners on status changes"
```

---

### Task 7: Admin moderation queue, detail panel, and external-to-RanobeLib linking

**Files:**
- Modify: `public/admin/admin.js`
- Modify: `public/admin/admin.css`
- Modify: `src/title-proposal-admin.ts`
- Create: `tests/title-proposal-admin-link.test.mjs`
- Modify: `package.json`

**Interfaces:**
- New admin mutation: `POST /api/admin/title-proposals/:id/link-ranobelib` body `{ "bookRef": "..." }`.
- Link operation updates the existing proposal in place; it never recreates it.

- [ ] **Step 1: Add failing API link test**

The endpoint must require admin auth, verify the RanobeLib row exists, update `source_kind='ranobelib'` and `ranobelib_book_ref`, retain proposal id/votes/RAW/status, and reject linking to a title already represented by another active proposal with HTTP 409.

- [ ] **Step 2: Verify failure**

Run: `npm run build:runtime-test && node --test tests/title-proposal-admin-link.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement endpoint**

Keep the implementation in `title-proposal-admin.ts` so title-proposal moderation remains one bounded API unit.

- [ ] **Step 4: Rebuild admin requests UI**

Add tabs `Новые`, `Одобрено`, `В плане`, `В работе`, `Закрытые`, source filters `Все / Есть RanobeLib / Нет RanobeLib`, and title search. List cards are compact and open one detail panel containing metadata, RAW, votes, admin note, status actions, and `🔎 Проверить RanobeLib` / `🔗 Связать` for external proposals.

- [ ] **Step 5: Run API tests and static admin smoke checks**

Run the new API test plus the existing test suite. Check that `public/admin/admin.js` loads without syntax errors through the repository's existing static asset path.

- [ ] **Step 6: Commit**

```bash
git add public/admin/admin.js public/admin/admin.css src/title-proposal-admin.ts tests/title-proposal-admin-link.test.mjs package.json
git commit -m "feat: upgrade proposal moderation workspace"
```

---

### Task 8: Full regression, bot command configuration, and release readiness

**Files:**
- Modify: `scripts/configure-bot.mjs`
- Modify: `README.md`

**Interfaces:**
- Bot command list includes `/start`, `/propose`, `/subscriptions`, `/notifications`, `/site`, `/help`.

- [ ] **Step 1: Update configured bot commands and README**

Document that `/start` opens the main menu, proposals work in Telegram, RAW is accepted as a Telegram document, and the website remains available.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run complete test suite**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 4: Run Worker build/dry-run**

Run: `npm run build:runtime-test && npx wrangler deploy --dry-run`

Expected: PASS without missing bindings or TypeScript errors.

- [ ] **Step 5: Review migration safety**

Confirm migration `0013` is forward-only, does not rename/drop existing columns/tables, and can be applied after `0012`.

- [ ] **Step 6: Commit documentation/config updates**

```bash
git add scripts/configure-bot.mjs README.md
git commit -m "docs: document Telegram proposal workflow"
```

- [ ] **Step 7: Open PR only after all checks pass**

Open a PR from `feat/telegram-title-proposals` to `main` with the spec and test results summarized. Do not merge automatically.
