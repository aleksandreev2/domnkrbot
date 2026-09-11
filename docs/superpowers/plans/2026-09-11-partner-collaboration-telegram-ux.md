# Partner Collaboration Telegram UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram bot visibly remain the official `Дом Некроманта` bot while exposing published partner teams and multi-team subscriptions through a clear catalog-oriented UX.

**Architecture:** Reuse the existing multi-team catalog/runtime instead of inventing a second subscription system. Add one root collaboration entry, extend the multi-team callback grammar with catalog/subscription hubs, add catalog queries that distinguish primary vs partner teams, and keep all public multi-team routing behind the existing UI rollout flag.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Telegram Bot API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-11-partner-collaboration-telegram-ux.md`

## Global Constraints

- `Дом Некроманта` remains the owner/primary brand; external teams are partners.
- Hidden/paused teams never appear publicly.
- Existing subscription precedence and delivery semantics remain unchanged.
- Do not enable `ranobelib_multi_team_shadow`, `ranobelib_multi_team_delivery`, or `ranobelib_multi_team_ui` as part of this change.
- No migration is needed unless an existing persisted callback/state format requires it.
- TDD: each behavioral change starts with a failing test.

---

### Task 1: Root menu branding and collaboration entry

**Files:**
- Modify: `tests/telegram-bot-ui.test.mjs`
- Modify: `src/telegram-bot-ui.ts`

**Interfaces:**
- Produces root callback `subs:mt:partners:0` for `🤝 Сотрудничества`.

- [ ] **Step 1: Write the failing root-menu test** asserting the official-bot copy, partner copy, and `🤝 Сотрудничества` callback while preserving notification/proposal/site actions.
- [ ] **Step 2: Run the targeted UI test and confirm RED.**
- [ ] **Step 3: Update `buildMainMenu()` with the approved copy and button.**
- [ ] **Step 4: Re-run the targeted UI test and confirm GREEN.**
- [ ] **Step 5: Commit the task.**

### Task 2: Multi-team catalog query boundaries

**Files:**
- Modify: `tests/telegram-team-ui.test.mjs` or create focused catalog assertions in an existing multi-team catalog test file.
- Modify: `src/telegram-team-catalog.ts`

**Interfaces:**
- Produces `listPublishedPartnerTeams(env,userId,page,pageSize)` excluding `is_primary=1`.
- Produces `listPublishedTranslations(env,userId,{completed,page,pageSize,primaryOnly?})` for catalog-wide active/completed pages.
- Produces a primary-team lookup/list path based on `is_primary`, not a hard-coded ID.

- [ ] **Step 1: Add failing tests for partner exclusion, primary lookup, active/completed filtering, and hidden-team exclusion.**
- [ ] **Step 2: Run the focused tests and confirm RED.**
- [ ] **Step 3: Implement the minimal D1 queries using existing translation mapping helpers.**
- [ ] **Step 4: Re-run focused tests and confirm GREEN.**
- [ ] **Step 5: Commit the task.**

### Task 3: Notification dashboard and catalog/subscription hubs

**Files:**
- Modify: `tests/telegram-team-ui.test.mjs`
- Modify: `src/telegram-team-notification-ux.ts`

**Interfaces:**
- Extend callback parser with `subscriptions-hub`, `catalog`, `partners`, and catalog translation pages.
- `buildTeamNotificationDashboard()` buttons become `⭐ Мои подписки`, `🧭 Каталог переводов`, `🔎 Поиск`, `⚙️ Настройки уведомлений`, Home.
- Add `buildMySubscriptionsHub()` and `buildTranslationCatalogHub()`.

- [ ] **Step 1: Add failing renderer/parser tests for the approved option-B hierarchy.**
- [ ] **Step 2: Run the focused UI tests and confirm RED.**
- [ ] **Step 3: Implement callback types/parser and pure payload builders.**
- [ ] **Step 4: Re-run focused UI tests and confirm GREEN.**
- [ ] **Step 5: Commit the task.**

### Task 4: Runtime routing for catalog and partners

**Files:**
- Modify: `tests/telegram-text-bot-ux-e2e.test.mjs` and/or `tests/telegram-team-ui.test.mjs`
- Modify: `src/telegram-team-notification-runtime.ts`

**Interfaces:**
- `subs:mt:partners:<page>` renders published non-primary teams.
- Catalog hub routes primary team, partners, all active translations, and all completed translations.
- `⭐ Мои подписки` routes to a hub separating whole-team vs manual team-title subscriptions.

- [ ] **Step 1: Add failing end-to-end routing tests for root collaboration callback, partner list, catalog hub, primary translations, active catalog, completed catalog, and my-subscriptions hub.**
- [ ] **Step 2: Run focused routing tests and confirm RED.**
- [ ] **Step 3: Wire the new catalog functions/builders into `handleTelegramTeamNotification()`.**
- [ ] **Step 4: Re-run focused tests and confirm GREEN.**
- [ ] **Step 5: Commit the task.**

### Task 5: Translation-card path to alternate translations

**Files:**
- Modify: `tests/telegram-team-ui.test.mjs`
- Modify: `src/telegram-team-notification-ux.ts`
- Modify: `src/telegram-team-notification-runtime.ts`

**Interfaces:**
- Concrete team-title cards receive whether other published translations exist.
- When alternatives exist, render `👥 Другие переводы этой новеллы` and route to the existing work translation picker.

- [ ] **Step 1: Add failing tests for showing the alternate-translations button only when useful.**
- [ ] **Step 2: Run focused tests and confirm RED.**
- [ ] **Step 3: Reuse `getWorkGroup()` to calculate alternatives and wire the button back to work picker.**
- [ ] **Step 4: Re-run focused tests and confirm GREEN.**
- [ ] **Step 5: Commit the task.**

### Task 6: Regression and rollout safety verification

**Files:**
- Modify only if verification exposes gaps.

**Interfaces:**
- No rollout flag writes.
- Existing `/start`, proposal flows, notification settings, legacy routing, onboarding, and team admin remain compatible.

- [ ] **Step 1: Run the complete repository test command.**
- [ ] **Step 2: Run typecheck.**
- [ ] **Step 3: Run Wrangler dry-run/build verification.**
- [ ] **Step 4: Inspect the PR diff for accidental rollout-flag changes, DDL, or subscription-semantics changes.**
- [ ] **Step 5: Open PR, wait for GitHub/Cloudflare checks, merge only when green, then verify production smoke/deploy.**
