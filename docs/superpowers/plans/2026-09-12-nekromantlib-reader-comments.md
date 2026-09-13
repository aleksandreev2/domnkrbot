# NekromantLib Reader Comments Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the saved RanobeLib lower-reader worker/support/comments surface one-for-one in layout and interaction using only native NekromantLib Telegram identities, D1 comments, replies and votes.

**Architecture:** Add one focused D1 migration and one `web-reader-comments` module, route it through `live-entry-v2`, then bind the existing reader page to `/api/auth/session` and the new comments API. Preserve the already verified reader header/text/settings/chapter-list code; only append the lower reader surfaces and their styles.

**Tech Stack:** Cloudflare Workers TypeScript, D1 SQL migrations, plain HTML/CSS/JS, Telegram web-session auth, Node `node:test` source-contract tests.

**Spec:** `docs/superpowers/specs/2026-09-12-nekromantlib-reader-comments-design.md`

## Global Constraints

- Saved RanobeLib captures are the source of truth for measurable layout and control ordering.
- Never copy RanobeLib comments, usernames, streaks, pinned content, scores or other social data.
- Use existing `users.telegram_id TEXT`, `getSessionUser`, `isSameOriginMutation`, and `isAdminUser` auth conventions.
- `Поддержать` points to `https://boosty.to/domnekromanta`.
- Report/settings social controls stay visibly disabled until a real backend contract exists.
- Do not alter scanner, multi-team lifecycle, Telegram notification delivery or already verified reader geometry.
- Every implementation task follows RED -> GREEN and full CI verification before a completion claim.

---

### Task 1: Native chapter-comment persistence and API routing

**Files:**
- Create: `migrations/0032_reader_chapter_comments.sql`
- Create: `src/web-reader-comments.ts`
- Modify: `src/live-entry-v2.ts`
- Test: `tests/nekromantlib-reader-comments.test.mjs`

**Interfaces:**
- Consumes: `getSessionUser(request, env)`, `isSameOriginMutation(request)`, `isAdminUser(env, user)`, `users.telegram_id`, `ranobelib_titles`, `ranobelib_chapters`.
- Produces: `handleWebReaderCommentsApi(request, env): Promise<Response | null>` for GET/POST comments, DELETE comment and PUT vote routes.

- [ ] **Step 1: Write the failing schema/router/API source-contract test**

Require `reader_chapter_comments`, `reader_chapter_comment_votes`, Telegram-id FKs, `CHECK(value IN (-1, 1))`, public list, authenticated same-origin mutation, title/chapter validation, soft delete, admin-or-author deletion, vote upsert/delete, and `handleWebReaderCommentsApi` routing in `live-entry-v2.ts`.

- [ ] **Step 2: Run CI and confirm RED**

Expected: repository typecheck/static checks remain green; Tests fails because migration/module/router do not exist yet.

- [ ] **Step 3: Add migration**

Create UUID TEXT comments keyed by `(book_ref, chapter_id)` with optional `parent_comment_id`, Telegram author FK, soft-delete timestamp and the three indexes defined by the spec. Create a vote table keyed by `(comment_id, voter_telegram_id)` with the ±1 CHECK and cascading FKs.

- [ ] **Step 4: Implement `web-reader-comments.ts`**

Implement:
- strict ref/chapter/comment-id parsing;
- `ensureUser()` using the established collection-comments upsert;
- title/chapter existence validation;
- `listReaderComments()` query with user join, vote SUM and viewer vote;
- `createReaderComment()` with 1..3000 trimmed chars and same-chapter parent validation;
- `deleteReaderComment()` soft delete for author or `isAdminUser`;
- `voteReaderComment()` with `0` delete and ±1 upsert;
- `publicComment()` returning `id`, `parentId`, `body`, `deleted`, author display data, timestamps, score, `myVote`, `isOwn`, `canDelete`.

- [ ] **Step 5: Route through `live-entry-v2.ts`**

Import `handleWebReaderCommentsApi`/env type, include it in `Env`, invoke it immediately after collection API handling and return its non-null response.

- [ ] **Step 6: Run the source-contract tests and full CI**

Expected: Task 1 tests and existing suite green; Wrangler dry-run succeeds.

- [ ] **Step 7: Commit Task 1**

Use focused commits for migration/module/router; preserve branch `feature/nekromantlib-parity-v1` and PR #101.

---

### Task 2: Exact lower-reader parity UI and native interactions

**Files:**
- Modify: `public/reader/index.html`
- Modify: `public/reader.js`
- Modify: `public/reader.css`
- Test: `tests/nekromantlib-reader-comments.test.mjs`

**Interfaces:**
- Consumes: `/api/auth/session`, `/api/reader/comments?ref=&chapter=`, POST `/api/reader/comments`, DELETE `/api/reader/comments/:id`, PUT `/api/reader/comments/:id/vote`.
- Produces: native lower-reader worker/support/comments UI beneath `#readerContent` without changing verified header/settings/chapter-list geometry.

- [ ] **Step 1: Extend the test with failing UI parity requirements**

Require IDs/classes for worker row, support action, comments header, collapsed composer, login host, list/status, comment/reply/vote rendering functions and measured CSS values: 930px worker/comments width, `10px 16px` worker padding, comments `16px` inner padding, composer `12px 0`, placeholder `12px`, 4px radius, 10px comment-body padding, 24px desktop avatar/head column and 1.6 body line-height.

- [ ] **Step 2: Confirm RED in CI**

Expected: API tests remain green; UI parity assertions fail before markup/JS/CSS is added.

- [ ] **Step 3: Add lower-reader markup**

Append below chapter content:
- worker credit row `Над главой работали` / `Дом Некроманта` with team logo;
- real Boosty `Поддержать` action;
- comments surface with `Новые`, disabled `Настройки`, `Правила`, collapsed `Написать комментарий...`, expandable form, Telegram login host, error/status and list containers.

- [ ] **Step 4: Add reader comments client behavior**

At boot fetch session alongside chapter data, then load comments. Implement Telegram widget mount for signed-out users, form expand/cancel/post, inline reply, vote toggling, author/admin delete, nested rendering by `parentId`, relative timestamps, long-text collapse and safe HTML escaping. Keep `жалоба` disabled.

- [ ] **Step 5: Add measured parity CSS**

Mirror the captured lower-reader widths, paddings, foreground background, comment header/body grid, compact controls and mobile collapse without altering `reader-topbar`, `reader-text-column`, chapter popup or settings popup rules.

- [ ] **Step 6: Run full CI + Test Discovery Guard**

Expected: migrations, typecheck, JS syntax, all tests and Wrangler dry-run success; Test Discovery Guard success.

- [ ] **Step 7: Add checkpoint marker and handoff update**

Append `domnkr-build-20260912-nekromantlib-reader-comments1` to `public/build.txt`, update `docs/NEKROMANTLIB_HANDOFF.md` and PR #101 body with the verified run IDs/HEAD.
