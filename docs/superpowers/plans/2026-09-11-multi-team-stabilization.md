# Multi-Team Notification Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove known notification-loss/replay risks in the multi-team rollout and make close chapter releases group safely without merging unrelated branches or teams.

**Architecture:** Keep branch-aware release identity as the source of truth. Baseline state must be evaluated per `(team, work)`, demand refresh must run after every mutation that changes effective subscribers or published relationships, completion remains team-scoped, and delivery may coalesce only rows sharing `book_ref + delivery_scope_key` and effective team scope. Do not merge across branches or unrelated team sets.

**Tech Stack:** TypeScript, Cloudflare Workers/D1, Node test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-10-multi-team-notifications-final-design.md`

## Global Constraints

- Never replay historical chapters when a team/work is first baselined.
- A new team baseline must not suppress fresh releases for an already-baselined team on the same work.
- Hidden/paused teams must not independently create demand or appear in user-facing translator copy.
- Completion must be attributable to a team/branch and final chapter polling must precede completion delivery.
- Grouping must never merge different `delivery_scope_key` values or unrelated team scopes.
- Existing subscriptions and delivered history must remain intact.

---

### Task 1: Baseline safety

**Files:**
- Modify: `src/ranobelib-multi-team-scanner.ts`
- Test: `tests/multi-team-core-invariants.test.mjs`

- [ ] Add failing tests proving a new unbaselined team does not suppress releases for already-baselined teams, and that an empty/unattributed first scan cannot mark baseline complete.
- [ ] Run targeted tests and confirm RED for the intended behavior.
- [ ] Change candidate generation/snapshot advancement so baseline is team-scoped; only teams with trustworthy attributed branches become baselined.
- [ ] Run targeted tests and confirm GREEN.

### Task 2: Demand refresh completeness

**Files:**
- Modify: `src/telegram-team-onboarding.ts`
- Modify: `src/ranobelib-multi-team-discovery.ts`
- Modify: `src/telegram-team-admin.ts`
- Test: `tests/multi-team-core-invariants.test.mjs`

- [ ] Add failing tests/static invariants requiring `refreshAllWorkNotificationDemand` after onboarding team selection, discovery reconciliation, and lifecycle publish/pause/resume.
- [ ] Confirm RED.
- [ ] Add the minimal refresh calls after successful mutations.
- [ ] Confirm GREEN.

### Task 3: Team-scoped completion

**Files:**
- Modify: `src/ranobelib-multi-team-discovery.ts`
- Modify: `src/ranobelib-multi-team-scanner.ts`
- Add migration only if persistence cannot be expressed with existing `semantic_status`, `completion_evidence`, and release tables.
- Test: `tests/completed-translations-lifecycle.test.mjs`
- Test: `tests/multi-team-core-invariants.test.mjs`

- [ ] Add failing tests for attributable active→completed transition, silent initial completed classification, and final chapter release before completion event.
- [ ] Confirm RED.
- [ ] Implement team-scoped completion evidence without copying work-level completion to unrelated teams.
- [ ] Confirm GREEN.

### Task 4: Safe close-release grouping

**Files:**
- Modify: `src/telegram-multi-team-delivery.ts`
- Modify: `src/telegram-notification-delivery-groups.ts` only if grouping metadata requires it.
- Test: `tests/multi-team-delivery.test.mjs`

- [ ] Add a failing reproduction for two immediately adjacent chapter releases (`541`, `542`) with identical work, branch scope, team scope and instant mode: expected one notification `541–542`.
- [ ] Add negative tests proving different branch scopes, team scopes, or a completion boundary are not merged incorrectly.
- [ ] Confirm RED.
- [ ] Implement a short bounded coalescing window at delivery selection, preserving `delivery_scope_key` and team eligibility boundaries.
- [ ] Confirm GREEN.

### Task 5: Hidden-team copy and diagnostics

**Files:**
- Modify: `src/telegram-multi-team-delivery.ts`
- Modify: `src/telegram-admin-stats.ts`
- Test: `tests/multi-team-delivery.test.mjs`
- Test: relevant admin stats tests

- [ ] Add failing tests proving hidden/paused team names are omitted from user-facing translator copy and multi-team stats count partner-only errors/subscriptions correctly.
- [ ] Confirm RED.
- [ ] Filter display names to published effective release teams and update stats to authoritative multi-team sources when rollout is active.
- [ ] Confirm GREEN.

### Task 6: Production verification accuracy

**Files:**
- Modify: production smoke workflow/script containing the stale build marker.

- [ ] Replace static obsolete deployment marker checking with the current build marker/source that changes with production code.
- [ ] Run the complete CI suite.
- [ ] Verify production smoke against the deployed revision and inspect fresh production health/stats.
