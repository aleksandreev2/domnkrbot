# Telegram Latency v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce time-to-visible-screen for interactive Telegram flows by removing runtime DDL, adding explicit render strategies, batching D1 UI reads, and instrumenting actual screen readiness.

**Architecture:** Keep the v1/v2 webhook classifier and early callback acknowledgement. Add a reusable screen renderer with `edit|replace|send`, remove schema self-heal from interactive routes, batch read-heavy payloads, use loading screens around external RanobeLib work, and add method-level latency metrics. Smart Placement is enabled only after code-level verification and retained only if production smoke/latency remain healthy.

**Tech Stack:** TypeScript, Cloudflare Workers Paid, D1/SQLite, Telegram Bot API, GitHub Actions, Wrangler, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-09-telegram-latency-v3-design.md`

## Global Constraints
- Interactive production handlers must not execute DDL.
- Durable mutations remain awaited before success UI.
- `replace` must send first and delete old only after successful send.
- Delete failure is non-fatal; send failure must preserve the old message.
- Pagination/toggle updates stay edit-based unless a test proves another strategy is better.
- Long RanobeLib operations show an immediate loading screen.
- Do not weaken moderation, membership, file-delivery or publishing correctness.
- Do not enable D1 read replication/Sessions API in this PR.
- Unique production marker: `domnkr-build-20260909-telegram-perf3`.

---

### Task 1: Add screen-level latency instrumentation
**Files:**
- Modify: `src/telegram-latency-timing.ts`
- Create: `src/telegram-screen-renderer.ts`
- Create: `tests/telegram-screen-renderer.test.mjs`
- Modify: `tests/telegram-latency-timing.test.mjs`
- Modify: `tsconfig.runtime-test.json`
- Modify: `package.json`

**Interfaces:**
- `TelegramRenderStrategy = 'edit' | 'replace' | 'send'`
- `renderTelegramScreen(env, target, payload, options): Promise<{messageId?: number}>`
- renderer records `telegram_started`, `screen_ready`, `telegram_method`, `render_strategy` through optional execution context timing.

- [ ] Write RED tests proving `replace` calls `sendMessage` first, does not start `deleteMessage` before send success, and schedules delete through `waitUntil` only after success.
- [ ] Add RED test proving failed send never deletes the old message.
- [ ] Add RED timing tests for method/strategy/screen-ready fields.
- [ ] Implement minimal renderer and timing extensions.
- [ ] Run focused tests + typecheck to GREEN.

### Task 2: Remove runtime DDL from interactive paths
**Files:**
- Modify: `src/telegram-title-proposals-v2.ts`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-notification-ux-runtime.ts`
- Modify: `src/telegram-notification-settings.ts` only if needed to separate repair from normal reads.
- Modify: `src/telegram-text-bot-ux-schema.ts` only if needed to separate repair from normal reads.
- Create: `tests/telegram-latency-v3-no-runtime-ddl.test.mjs`

- [ ] RED static/runtime tests: `/start`, proposal callback, notification callback, legacy subscription callback must not invoke `ensure*Schema()` or execute `CREATE/ALTER`.
- [ ] Refactor interactive handlers to assume migrations are applied; retain repair helpers only for explicit maintenance/tests.
- [ ] Ensure CI/local migration setup covers every required table/index.
- [ ] Full focused regression suite GREEN.

### Task 3: Make `/start` visible immediately
**Files:**
- Modify: `src/telegram-title-proposals-v2.ts`
- Create/modify: `tests/telegram-latency-v3-start.test.mjs`

- [ ] RED test with indefinitely deferred D1 housekeeping: `sendMessage` must begin immediately and visible-screen promise must not depend on housekeeping start order.
- [ ] Start main-menu send first; move noncritical user-touch/input cleanup to `waitUntil` when execution context exists, while preserving safe fallback without context.
- [ ] Evaluate direct webhook Bot API response in a focused spike test; keep only if semantics are simpler/equivalent.
- [ ] GREEN focused + old `/start` E2E tests.

### Task 4: Hybrid render strategies for notification UI
**Files:**
- Modify: `src/telegram-notification-ux-runtime.ts`
- Modify: `src/telegram-notification-ux.ts` only for loading/stale copy if needed.
- Create: `tests/telegram-latency-v3-notification-render.test.mjs`

- [ ] RED strategy tests: list pagination/toggle => `edit`; dashboard→list/card and card→dashboard/list => `replace`.
- [ ] Replace current generic `respond()` with explicit renderer strategy per route.
- [ ] Preserve early callback ACK and durable mutation ordering.
- [ ] GREEN old notification UX tests plus new strategy tests.

### Task 5: Batch notification dashboard/title-card reads
**Files:**
- Modify: `src/telegram-notification-ux-runtime.ts`
- Create: `tests/telegram-latency-v3-d1-batch.test.mjs`

- [ ] RED tests with D1 mock counting network operations; dashboard and title-card should use `DB.batch()` for independent reads.
- [ ] Extend local D1 type to expose `batch()`.
- [ ] Implement batch payload reads while preserving all-titles/exclusion semantics and delivery settings.
- [ ] GREEN semantic output tests and operation-count tests.

### Task 6: Proposal wizard replace/loading UX
**Files:**
- Modify: `src/telegram-title-proposals-v2.ts`
- Modify: `src/telegram-title-proposal-ui.ts` if loading payload helper is needed.
- Create: `tests/telegram-latency-v3-proposal-render.test.mjs`

- [ ] RED tests: semantic proposal transitions use `replace`; local candidate pagination stays `edit`.
- [ ] RED external-work test: `prop:pick:*`/`prop:retry:ranobelib` must show loading screen before upstream fetch resolves.
- [ ] Implement explicit proposal renderer using shared screen renderer.
- [ ] Loading screen contains no stale action callbacks.
- [ ] GREEN all proposal navigation/editing tests.

### Task 7: Race/error hardening
**Files:**
- Modify: `src/telegram-screen-renderer.ts`
- Modify relevant proposal/notification tests.

- [ ] RED test: `message is not modified` on edit is non-fatal.
- [ ] RED test: failed background delete is non-fatal.
- [ ] RED test: replace never deletes before send success.
- [ ] Implement compact Telegram error normalization without logging token/payload/user content.
- [ ] GREEN renderer + full interaction tests.

### Task 8: Smart Placement measured experiment
**Files:**
- Modify: `wrangler.jsonc`
- Create: `tests/cloudflare-telegram-latency-config.test.mjs`

- [ ] RED config test requiring `placement.mode === 'smart'` and explicitly forbidding read-replication/Sessions config in this PR.
- [ ] Add Smart Placement.
- [ ] Wrangler dry-run GREEN.

### Task 9: Production marker and final verification
**Files:**
- Modify: `public/build.txt`
- Modify: `.github/workflows/ci.yml`

- [ ] Add `domnkr-build-20260909-telegram-perf3` marker and require it in CI/main production smoke.
- [ ] Run full suite: migrations, TypeScript, JS/static guards, `npm test`, Wrangler dry-run.
- [ ] Review complete diff for unrelated cron/scanner/moderation changes; remove any unrelated edits.
- [ ] Require exact-head CI GREEN and no blocking review threads.
- [ ] Mark PR ready and squash-merge.
- [ ] Verify post-merge CI and production smoke on exact merge SHA with perf3 marker.
