# Multi-Team RanobeLib Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable multi-team RanobeLib notifications with team-scoped subscriptions, branch-aware release identity, safe migration of all existing Дом Некроманта users, and a reversible staged rollout.

**Architecture:** Keep `ranobelib_titles` as the work-level catalog, add normalized team/team-translation/branch mappings, aggregate notification demand to the work scheduler, and resolve release eligibility through participating teams before writing the D1 outbox. Preserve the current single-team path during a compatibility window and cut over through D1 feature switches after silent baseline and shadow verification.

**Tech Stack:** TypeScript 5.8+, Cloudflare Workers, D1/SQLite migrations, Cloudflare Queue wake-ups, Telegram Bot API, Node `node:test`, existing RanobeLib REST client.

**Spec:** `docs/superpowers/specs/2026-09-10-multi-team-notifications-final-design.md`

## Global Constraints

- `Дом Некроманта` remains the primary team and existing behavior must survive migration unchanged.
- Existing `all_titles=1` migrates to a whole-team subscription for `Дом Некроманта` only.
- Team-title subscription identity is `(user, team, work)`.
- Release identity is chapter + branch-aware; joint branches dedupe to one release while independent branches remain independent.
- Native RanobeLib `branch_id` is preferred; fallback identity is conservative and versioned.
- Work-level completion must never be copied to every team translation.
- Delivery modes have only two levels: global user default and optional team-title override.
- External recommendation Telegram channels are read-only metadata and may never enter publication/download/blacklist write paths.
- New-team initial sync and migration baseline are silent and must not replay historical releases.
- Migration is additive/forward-only; legacy tables remain during stabilization.
- D1 outbox remains the source of truth; Queue remains wake-up only.
- HOT/IDLE demand-aware scheduling and current Telegram 403 reachability semantics remain supported.
- Multi-team user UX stays hidden until primary-team parity/shadow verification passes.
- No runtime DDL is added for the new multi-team schema; production schema changes come from migrations.

---

## File map and responsibility boundaries

New focused modules:

- `migrations/0023_multi_team_notifications.sql` — additive multi-team schema, primary-team seed/backfill, feature switches.
- `src/integrations/ranobelib/branch-identity.ts` — deterministic native/fallback branch identity only.
- `src/ranobelib-team-registry.ts` — team CRUD/lifecycle and recommendation-channel metadata persistence.
- `src/ranobelib-multi-team-discovery.ts` — team-by-team discovery and team-translation lifecycle.
- `src/ranobelib-multi-team-scanner.ts` — work-level fetch, branch fan-out, silent/shadow/live release persistence.
- `src/multi-team-subscriptions.ts` — team/team-title subscriptions, exclusions, migration-compatible effective eligibility.
- `src/multi-team-notification-demand.ts` — team-aware demand aggregation to work-level scheduling.
- `src/multi-team-rollout.ts` — D1 switch reads and shadow/live cutover decisions.
- `src/telegram-team-catalog.ts` — user team lists/team-title list queries and rendering data.
- `src/telegram-team-onboarding.ts` — first-start onboarding state and recommendation membership personalization.
- `src/telegram-team-admin.ts` — admin team management and recommendation-channel attachment flow.

Existing modules modified at integration boundaries:

- `src/integrations/ranobelib/types.ts` and `client.ts` — preserve branch data without breaking compatibility `getChapters` callers.
- `src/ranobelib-fast-scanner.ts` / `ranobelib-discovery-scheduler.ts` — compatibility delegation while rollout flags are off/on.
- `src/notification-demand.ts` — delegate to team-aware demand after cutover.
- `src/telegram-notification-settings.ts` — team-title delivery-setting scope.
- `src/telegram-notification-ux.ts` / `telegram-notification-ux-runtime.ts` — team-aware dashboard/search/title cards/completed lists.
- `src/telegram-subscriptions.ts` — compatibility wrappers and dynamic team names in release formatting.
- `src/telegram-notification-delivery.ts` / `telegram-notification-delivery-groups.ts` — branch release teams, eligibility, stack grouping.
- `src/telegram-subscription-webhook.ts`, `src/telegram-webhook-routing.ts`, `src/entry.ts`, `src/live-entry-v2.ts` — webhook/cron/cutover wiring.
- `src/telegram-admin-stats.ts` — aggregate team health counters.
- `README.md` — operations, rollout, rollback, feature switches.

---

### Task 1: Add the additive D1 schema and idempotent primary-team migration

**Files:**
- Create: `migrations/0023_multi_team_notifications.sql`
- Create: `tests/multi-team-migration.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces tables `ranobelib_teams`, `ranobelib_team_translations`, `ranobelib_chapter_branches`, `ranobelib_chapter_branch_teams`, `ranobelib_release_teams`, `telegram_team_subscriptions`, `telegram_team_title_subscriptions`, `telegram_team_title_exclusions`, `telegram_team_title_delivery_settings`, `telegram_notification_onboarding`.
- Produces app-setting keys `ranobelib_multi_team_shadow`, `ranobelib_multi_team_delivery`, `ranobelib_multi_team_ui`, all defaulting to `0`.
- Preserves all legacy notification tables and outbox rows.

- [ ] **Step 1: Write the failing migration tests**

Create fixtures for existing users with `all_titles=1`, explicit subscriptions, exclusions, delivery overrides, and delivered outbox history. Assert that applying migration 0023 creates exactly one primary team and mirrors legacy state into primary-team scope without deleting legacy rows.

```js
test('0023 migrates legacy all_titles only to primary team', async () => {
  const db = await migratedLegacyFixture({ allTitles: true });
  const primary = await one(db, `SELECT id FROM ranobelib_teams WHERE is_primary=1`);
  assert.equal(await scalar(db, `SELECT COUNT(*) FROM telegram_team_subscriptions WHERE user_telegram_id='100' AND team_id=?`, primary.id), 1);
  assert.equal(await scalar(db, `SELECT COUNT(*) FROM telegram_team_subscriptions WHERE user_telegram_id='100' AND team_id<>?`, primary.id), 0);
});

test('0023 never rewrites delivered outbox history', async () => {
  const db = await migratedLegacyFixture({ deliveredRelease: 'r1' });
  assert.equal(await scalar(db, `SELECT COUNT(*) FROM ranobelib_notification_outbox WHERE release_id='r1' AND status='sent'`), 1);
});
```

- [ ] **Step 2: Run the new migration test and verify RED**

Run: `node --test tests/multi-team-migration.test.mjs`

Expected: FAIL because migration 0023 and new tables do not exist.

- [ ] **Step 3: Implement migration 0023**

Use normalized foreign keys and unique constraints. Seed the primary team with RanobeLib ref `11969--dom-nekromanta`. Backfill with `INSERT OR IGNORE ... SELECT` so repeated fixture application is safe.

Core subscription schema:

```sql
CREATE TABLE ranobelib_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ranobelib_team_id INTEGER NOT NULL,
  ranobelib_team_ref TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('hidden','published','paused','error')),
  recommendation_chat_id TEXT,
  recommendation_chat_title TEXT,
  recommendation_chat_username TEXT,
  recommendation_membership_capable INTEGER NOT NULL DEFAULT 0 CHECK (recommendation_membership_capable IN (0,1)),
  last_sync_at TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_ranobelib_one_primary_team
ON ranobelib_teams(is_primary) WHERE is_primary=1;

CREATE TABLE telegram_team_subscriptions (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES ranobelib_teams(id) ON DELETE CASCADE
);

CREATE TABLE telegram_team_title_subscriptions (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id, book_ref)
);

CREATE TABLE telegram_team_title_exclusions (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id, book_ref)
);
```

Add foreign keys/indexes for team/work lookups and equivalent team-title delivery-setting columns/checks matching migration 0016 (`instant` or `stack`, stack size 2–100).

- [ ] **Step 4: Run migration tests and existing schema-sensitive tests**

Run:

```bash
node --test tests/multi-team-migration.test.mjs tests/telegram-text-bot-ux-schema.test.mjs tests/telegram-notification-settings.test.mjs tests/telegram-subscriptions.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Add the new test to `npm test` and commit**

```bash
git add migrations/0023_multi_team_notifications.sql tests/multi-team-migration.test.mjs package.json
git commit -m "feat: add multi-team notification schema"
```

---

### Task 2: Preserve RanobeLib branch identity in the client

**Files:**
- Create: `src/integrations/ranobelib/branch-identity.ts`
- Modify: `src/integrations/ranobelib/types.ts`
- Modify: `src/integrations/ranobelib/client.ts`
- Create: `tests/ranobelib-branch-identity.test.mjs`
- Modify: `tests/ranobelib-sync.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `RanobeLibChapterBranch`.
- Produces `buildRanobeLibBranchIdentity(input): RanobeLibBranchIdentity`.
- Produces `RanobeLibClient.getChapterBranches(bookRef): Promise<RanobeLibChapterBranch[]>`.
- Preserves existing `getChapters(bookRef, { teamRef })` behavior for compatibility.

Define the interface exactly:

```ts
export type RanobeLibBranchIdentity = {
  key: string;
  nativeBranchId: number | null;
  confidence: 'native' | 'fallback' | 'ambiguous';
};

export interface RanobeLibChapterBranch {
  chapterId: number;
  volume: string;
  number: string;
  name: string | null;
  branchKey: string;
  nativeBranchId: number | null;
  identityConfidence: RanobeLibBranchIdentity['confidence'];
  teamIds: number[];
  releasedAt: string | null;
}
```

- [ ] **Step 1: Write failing parser/identity tests**

```js
test('native branch_id wins and team order is normalized', () => {
  assert.deepEqual(buildRanobeLibBranchIdentity({
    bookRef: '10--x', chapterId: 500, nativeBranchId: 2251,
    teamIds: [11969, 77], releasedAt: '2026-09-10T10:00:00Z', stableBranchRef: null,
  }), { key: 'native:2251', nativeBranchId: 2251, confidence: 'native' });
});

test('fallback identity is unchanged when teams arrive in another order', () => {
  const a = fallbackIdentity([11969, 77]);
  const b = fallbackIdentity([77, 11969]);
  assert.equal(a.key, b.key);
});

test('insufficient branch evidence is marked ambiguous, not merged into another team branch', () => {
  const id = buildRanobeLibBranchIdentity({ bookRef:'10--x', chapterId:500, nativeBranchId:null, teamIds:[], releasedAt:null, stableBranchRef:null });
  assert.equal(id.confidence, 'ambiguous');
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/ranobelib-branch-identity.test.mjs tests/ranobelib-sync.test.mjs`

Expected: FAIL because branch interfaces/parser do not exist.

- [ ] **Step 3: Implement deterministic identity**

`branch-identity.ts` sorts/deduplicates positive team IDs. Use `native:<id>` for valid native IDs. For fallback, generate a versioned canonical key from encoded stable fields; mutable team display names are excluded. When neither teams nor a stable upstream branch field/timestamp can distinguish the branch, return `confidence:'ambiguous'` and a canonical key that includes the full stable scalar signature rather than coalescing it with another branch.

```ts
export function buildRanobeLibBranchIdentity(input: BranchIdentityInput): RanobeLibBranchIdentity {
  if (Number.isSafeInteger(input.nativeBranchId) && Number(input.nativeBranchId) > 0) {
    return { key: `native:${input.nativeBranchId}`, nativeBranchId: Number(input.nativeBranchId), confidence: 'native' };
  }
  const teams = normalizeTeamIds(input.teamIds);
  const evidence = [input.stableBranchRef ?? '', input.releasedAt ?? ''].filter(Boolean);
  const confidence = teams.length || evidence.length ? 'fallback' : 'ambiguous';
  const canonical = JSON.stringify(['v1', input.bookRef, input.chapterId, teams, ...evidence]);
  return { key: `fp:v1:${encodeURIComponent(canonical)}`, nativeBranchId: null, confidence };
}
```

- [ ] **Step 4: Add `getChapterBranches` and preserve old filtered API**

Parse every released branch of every chapter, retain `branch_id`, participating team IDs, and `created_at`. Implement existing `getChapters(...teamRef)` by filtering branch-aware results and projecting back to `RanobeLibChapter`, so old code remains functional until cutover.

- [ ] **Step 5: Run tests and typecheck**

```bash
node --test tests/ranobelib-branch-identity.test.mjs tests/ranobelib-sync.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/ranobelib/branch-identity.ts src/integrations/ranobelib/types.ts src/integrations/ranobelib/client.ts tests/ranobelib-branch-identity.test.mjs tests/ranobelib-sync.test.mjs package.json
git commit -m "feat: preserve RanobeLib branch identity"
```

---

### Task 3: Add team registry and team-scoped discovery lifecycle

**Files:**
- Create: `src/ranobelib-team-registry.ts`
- Create: `src/ranobelib-multi-team-discovery.ts`
- Create: `tests/ranobelib-multi-team-discovery.test.mjs`
- Modify: `src/ranobelib-discovery-scheduler.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `listRunnableRanobeLibTeams(env): Promise<RanobeLibTeamRecord[]>`.
- Produces `discoverRegisteredRanobeLibTeams(env): Promise<MultiTeamDiscoveryResult>`.
- Produces `discoverOneRegisteredTeam(env, team): Promise<TeamDiscoveryResult>`.
- Legacy `discoverRanobeLibTeam` remains authoritative while multi-team delivery flag is off.

```ts
export type RanobeLibTeamRecord = {
  id: number;
  ranobelibTeamId: number;
  ranobelibTeamRef: string;
  displayName: string;
  isPrimary: boolean;
  lifecycleState: 'hidden' | 'published' | 'paused' | 'error';
};
```

- [ ] **Step 1: Write failing discovery tests**

Cover: two teams sharing one work, removal from one team only, empty upstream response not wiping relationships, hidden/paused state persistence, and initial baseline state.

```js
test('removing a work from Team A does not remove Team B relationship', async () => {
  const db = await fixtureWithSharedWork();
  await discoverOneRegisteredTeam(envFor(db, teamAEmptyClient), teamA);
  assert.equal(await relationState(db, teamA.id, '10--x'), 'dormant');
  assert.equal(await relationState(db, teamB.id, '10--x'), 'active');
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/ranobelib-multi-team-discovery.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement team registry reads/lifecycle mutations**

Keep repository writes idempotent. `paused` teams are retained but excluded from runnable discovery/scanner demand. `hidden` teams may sync for baseline/validation but remain user-invisible.

- [ ] **Step 4: Implement per-team discovery**

Upsert `ranobelib_team_translations` without changing global work availability for other teams. Brand-new relationships start `baseline_ready=0`; successful initial data population later marks them ready silently.

Work-level `scanlateStatus` can be stored as context but must not set team completion unless the parser/discovery has attributable team/branch evidence.

- [ ] **Step 5: Keep the legacy scheduler as a compatibility delegate**

`discoverRanobeLibTeam` continues existing primary-team behavior when the multi-team cutover flag is disabled. When shadow/live flags are enabled, `live-entry-v2.ts` will call the new scheduler directly in later tasks; do not silently replace production behavior in this task.

- [ ] **Step 6: Run tests**

```bash
node --test tests/ranobelib-multi-team-discovery.test.mjs tests/ranobelib-discovery-scheduler.test.mjs tests/ranobelib-translation-status.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ranobelib-team-registry.ts src/ranobelib-multi-team-discovery.ts src/ranobelib-discovery-scheduler.ts tests/ranobelib-multi-team-discovery.test.mjs package.json
git commit -m "feat: add team-scoped RanobeLib discovery"
```

---

### Task 4: Build branch-aware work scanner with silent and shadow modes

**Files:**
- Create: `src/ranobelib-multi-team-scanner.ts`
- Create: `tests/ranobelib-multi-team-scanner.test.mjs`
- Modify: `src/ranobelib-fast-scanner.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `scanDueMultiTeamWorks(env, options): Promise<MultiTeamScanResult>`.
- Produces mode `'baseline' | 'shadow' | 'live'`.
- Consumes `getChapterBranches`, `ranobelib_team_translations`, and work-level due scheduling.
- In shadow mode, persists diagnostics/snapshots needed for comparison but never inserts live `ranobelib_releases` or outbox rows.

```ts
export type MultiTeamScanMode = 'baseline' | 'shadow' | 'live';
export type MultiTeamScanOptions = { limit?: number; now?: Date; mode: MultiTeamScanMode };
export type MultiTeamScanResult = {
  selectedWorks: number;
  fetchedWorks: number;
  detectedReleases: number;
  persistedReleases: number;
  ambiguousBranches: number;
  errors: string[];
};
```

- [ ] **Step 1: Write RED tests for branch semantics**

Cover one fetch per shared work, one joint release for two teams, two independent releases for two branches, initial baseline silence, shadow silence, scheduled release recovery, and ambiguous branch isolation.

```js
test('one shared work fetch fans out to both teams', async () => {
  const client = countingClient(sharedWorkPayload);
  await scanDueMultiTeamWorks(env(client), { mode:'shadow', limit:24 });
  assert.equal(client.chapterFetches('10--x'), 1);
});

test('joint branch creates one release in live mode', async () => {
  const result = await scanFixture(jointBranchPayload, 'live');
  assert.equal(result.persistedReleases, 1);
  assert.deepEqual(await releaseTeamIds(result.db), [77,11969]);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/ranobelib-multi-team-scanner.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement branch snapshot persistence**

Upsert branch rows keyed by `(book_ref, chapter_id, branch_key)` and replace/set participating team mappings from the current upstream branch. Keep `first_seen_at` stable and update release timestamp only from trustworthy upstream data.

- [ ] **Step 4: Implement release detection**

Compare current branch-aware keys to stored branch-aware snapshots. A release ID must incorporate work/chapter range plus branch key so independent branches cannot collide.

Conceptually:

```ts
function releaseIdentity(bookRef: string, branchKey: string, chapterIds: number[]): string {
  return `branch-release:v1:${bookRef}:${encodeURIComponent(branchKey)}:${chapterIds.join(',')}`;
}
```

For a joint branch, write one `ranobelib_releases` row and N `ranobelib_release_teams` rows.

- [ ] **Step 5: Implement baseline/shadow/live write boundaries**

`baseline`: update branch snapshots/team baselines, never release.

`shadow`: compute candidate releases and diagnostics, never live release/outbox.

`live`: persist release + release teams transactionally/idempotently.

- [ ] **Step 6: Preserve final-scan-before-completion semantics**

Team/branch-specific completion may only finalize after a successful branch-aware poll. Late chapters persist first; completion event comes afterward and is associated only with the attributable team set.

- [ ] **Step 7: Run targeted and compatibility tests**

```bash
node --test tests/ranobelib-multi-team-scanner.test.mjs tests/ranobelib-fast-scanner.test.mjs tests/ranobelib-fast-scanner-cadence.test.mjs tests/ranobelib-completion-final-scan.test.mjs tests/ranobelib-scheduled-recovery.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ranobelib-multi-team-scanner.ts src/ranobelib-fast-scanner.ts tests/ranobelib-multi-team-scanner.test.mjs package.json
git commit -m "feat: add branch-aware multi-team scanner"
```

---

### Task 5: Implement team-scoped subscriptions and delivery-setting migration compatibility

**Files:**
- Create: `src/multi-team-subscriptions.ts`
- Create: `tests/multi-team-subscriptions.test.mjs`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-notification-settings.ts`
- Modify: `tests/telegram-notification-settings.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `resolveTeamTitleSubscription(state): EffectiveTeamTitleSubscription`.
- Produces `isEffectivelySubscribedToTeamTitle(env, userId, teamId, bookRef): Promise<boolean>`.
- Produces `setTeamSubscription`, `setTeamTitleSubscription`, `setTeamTitleExclusion`.
- Produces `getEffectiveTeamTitleDeliverySetting(env, userId, teamId, bookRef)` resolving team-title override then global default.

```ts
export type EffectiveTeamTitleSubscription = {
  enabled: boolean;
  reason: 'excluded' | 'team' | 'explicit' | 'none';
};

export function resolveTeamTitleSubscription(state: {
  teamFollowed: boolean;
  explicit: boolean;
  excluded: boolean;
}): EffectiveTeamTitleSubscription {
  if (state.excluded) return { enabled:false, reason:'excluded' };
  if (state.teamFollowed) return { enabled:true, reason:'team' };
  if (state.explicit) return { enabled:true, reason:'explicit' };
  return { enabled:false, reason:'none' };
}
```

- [ ] **Step 1: Write RED precedence/migration tests**

Cover exclusion > whole team > explicit > none, same work independently subscribed by two teams, legacy primary-team wrappers, global delivery mode, team-title override, and absence of team-wide mode.

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-team-subscriptions.test.mjs tests/telegram-notification-settings.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement new subscription service**

All writes are idempotent (`INSERT OR IGNORE`, precise deletes). Legacy helper functions in `telegram-subscriptions.ts` continue to map to the primary team while UI cutover is disabled.

- [ ] **Step 4: Scope delivery settings to `(user, team, work)`**

Read `telegram_team_title_delivery_settings` first. If absent, read the existing global setting from `telegram_subscription_settings`. Do not consult a team-wide setting because none exists.

- [ ] **Step 5: Run tests and typecheck**

```bash
node --test tests/multi-team-subscriptions.test.mjs tests/telegram-subscriptions.test.mjs tests/telegram-notification-settings.test.mjs tests/telegram-notification-delivery-v3.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/multi-team-subscriptions.ts src/telegram-subscriptions.ts src/telegram-notification-settings.ts tests/multi-team-subscriptions.test.mjs tests/telegram-notification-settings.test.mjs package.json
git commit -m "feat: add team-scoped notification subscriptions"
```

---

### Task 6: Make demand and outbox eligibility team-aware

**Files:**
- Create: `src/multi-team-notification-demand.ts`
- Create: `tests/multi-team-notification-demand.test.mjs`
- Create: `tests/multi-team-notification-outbox.test.mjs`
- Modify: `src/notification-demand.ts`
- Modify: `src/telegram-notification-delivery.ts`
- Modify: `src/telegram-notification-delivery-groups.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `refreshWorkNotificationDemand(env, bookRef): Promise<number>`.
- Produces `refreshAllWorkNotificationDemand(env): Promise<void>`.
- Delivery queries consume `ranobelib_release_teams` and effective team-title eligibility.
- One release/user remains one outbox row even if several participating teams make the user eligible.

- [ ] **Step 1: Write RED tests**

```js
test('following both teams of a joint release produces one outbox row', async () => {
  const db = await jointReleaseFixture({ followTeams:[77,11969] });
  await enqueueEligibleRecipients(db, 'joint-r1');
  assert.equal(await scalar(db, `SELECT COUNT(*) FROM ranobelib_notification_outbox WHERE release_id='joint-r1'`), 1);
});

test('excluding Team A title still allows a joint release through followed Team B', async () => {
  const result = await effectiveReleaseEligibility(jointFixture({ excludeA:true, followB:true }));
  assert.equal(result, true);
});
```

Also cover paused/hidden team demand exclusion, blocked reachability, explicit title subscription, no subscribers → IDLE, and `0 → positive` immediate wake-up.

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-team-notification-demand.test.mjs tests/multi-team-notification-outbox.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement team-title demand aggregation**

Compute distinct reachable users eligible through published actionable team translations, then update the work-level `ranobelib_titles.notification_subscriber_count` and current HOT/IDLE fields. Hidden/paused/error-only relationships do not create demand.

- [ ] **Step 4: Implement release recipient union before outbox insert**

Use `SELECT DISTINCT user_telegram_id` across participating teams and `INSERT OR IGNORE` into the existing outbox key `(release_id,user_telegram_id)`.

- [ ] **Step 5: Update delivery-time revalidation**

`selectReadyDeliveryGroups` and `loadClaimedDeliveryRows` must re-check current team-aware eligibility so unsubscribes/exclusions after enqueue are honored. Keep blocked-user and retry/lease behavior unchanged.

- [ ] **Step 6: Keep stack grouping stable**

Group pending chapters by `(user, work, effective delivery setting)` as today, but ensure two independent branches are not accidentally collapsed into one logical release before eligibility. Stack aggregation may combine chapter counts for the same title only after each release has independently passed team eligibility.

- [ ] **Step 7: Run tests**

```bash
node --test tests/multi-team-notification-demand.test.mjs tests/multi-team-notification-outbox.test.mjs tests/notification-demand.test.mjs tests/notification-demand-subscription-wiring.test.mjs tests/telegram-notification-delivery-groups.test.mjs tests/telegram-notification-delivery-stack-integration.test.mjs tests/telegram-notification-delivery-v3.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/multi-team-notification-demand.ts src/notification-demand.ts src/telegram-notification-delivery.ts src/telegram-notification-delivery-groups.ts tests/multi-team-notification-demand.test.mjs tests/multi-team-notification-outbox.test.mjs package.json
git commit -m "feat: make notification demand team-aware"
```

---

### Task 7: Render dynamic translator teams without breaking delivery controls

**Files:**
- Create: `tests/multi-team-notification-render.test.mjs`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-translation-completion.ts`
- Modify: `src/telegram-notification-delivery.ts`
- Modify: `src/telegram-notification-delivery-groups.ts`
- Modify: `package.json`

**Interfaces:**
- `formatReleaseNotification` accepts `teamNames: string[]`.
- `formatTranslationCompletionNotification` accepts `teamNames: string[]`.
- Delivery row/group loading exposes the release's participating team names.

- [ ] **Step 1: Write RED rendering tests**

```js
test('joint release names both translator teams once', () => {
  const payload = formatReleaseNotification({
    title:'Книга', url:'https://example', chapterCount:1,
    firstNumber:'10', lastNumber:'10', summary:'Chapter 10',
    teamNames:['Дом Некроманта','Team X'],
  });
  assert.match(payload.text, /Дом Некроманта.*Team X/);
});
```

Cover one team, two teams, safe HTML escaping, completion notification, and no duplicate team labels.

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-team-notification-render.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Pass team names through delivery queries/groups**

Load release-team names from normalized mappings. Sort deterministically with primary team first, then case-insensitive display name.

- [ ] **Step 4: Update renderers**

Keep current buttons/read links/subscription controls. Replace the hard-coded `Перевод команды «Дом Некроманта».` with one-team or multi-team text derived from release data.

- [ ] **Step 5: Run rendering/delivery tests**

```bash
node --test tests/multi-team-notification-render.test.mjs tests/telegram-notifications-v2.test.mjs tests/telegram-notification-delivery-v3.test.mjs tests/telegram-latency-v3-notification-render.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-subscriptions.ts src/telegram-translation-completion.ts src/telegram-notification-delivery.ts src/telegram-notification-delivery-groups.ts tests/multi-team-notification-render.test.mjs package.json
git commit -m "feat: render translator teams in notifications"
```

---

### Task 8: Add team-aware user catalog, search, title cards, and completed translations

**Files:**
- Create: `src/telegram-team-catalog.ts`
- Create: `tests/telegram-team-catalog.test.mjs`
- Modify: `src/telegram-notification-ux.ts`
- Modify: `src/telegram-notification-ux-runtime.ts`
- Modify: `src/telegram-text-bot-ux-schema.ts`
- Modify: `tests/telegram-notification-ux.test.mjs`
- Modify: `tests/telegram-notification-ux-runtime.test.mjs`
- Modify: `tests/telegram-notification-search.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces user screens: `my-teams`, `my-titles`, `all-teams`, `team-active`, `team-completed`, `work-team-picker`, `team-title-card`.
- `NotificationUiTitle` gains team identity for team-title screens.
- Search groups duplicate works only if multiple published team translations exist.

- [ ] **Step 1: Write RED catalog/search tests**

Cover active list default, completed filter/count, completed search badge, one-team direct-open, multi-team chooser, hidden-team invisibility, `Мои новеллы` excluding titles inherited from whole-team follows, and independent subscription state for duplicate work translations.

- [ ] **Step 2: Run RED**

```bash
node --test tests/telegram-team-catalog.test.mjs tests/telegram-notification-search.test.mjs tests/telegram-notification-ux.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement query layer in `telegram-team-catalog.ts`**

Every user query filters teams to `published`. Team pages return active/unknown translations by default; completed translations are fetched separately. Search may include completed rows but labels them.

- [ ] **Step 4: Extend callback parser/renderers**

Use compact callback IDs based on internal numeric team ID + RanobeLib numeric work ID, never long refs/names. Preserve `Назад` origin/page context exactly as current UX v2 does.

Conceptual callback forms:

```text
notif:teams:mine:0
notif:team:77:active:0
notif:team:77:done:0
notif:work:12345:teams:0
notif:tt:77:12345:all:0
```

Keep callback payloads under Telegram limits.

- [ ] **Step 5: Update runtime mutations**

Toggle a concrete team-title or whole-team subscription through Task 5 service functions, then refresh Task 6 work demand. Completed team-title rows remain viewable/manageable; do not silently create new subscriptions to already completed work unless the existing UX intentionally permits that action.

- [ ] **Step 6: Run UX tests**

```bash
node --test tests/telegram-team-catalog.test.mjs tests/telegram-notification-ux.test.mjs tests/telegram-notification-ux-runtime.test.mjs tests/telegram-notification-search.test.mjs tests/telegram-text-bot-ux-e2e.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-team-catalog.ts src/telegram-notification-ux.ts src/telegram-notification-ux-runtime.ts src/telegram-text-bot-ux-schema.ts tests/telegram-team-catalog.test.mjs tests/telegram-notification-ux.test.mjs tests/telegram-notification-ux-runtime.test.mjs tests/telegram-notification-search.test.mjs package.json
git commit -m "feat: add team-aware notification catalog"
```

---

### Task 9: Implement resilient first-start onboarding and recommendation-channel personalization

**Files:**
- Create: `src/telegram-team-onboarding.ts`
- Create: `tests/telegram-team-onboarding.test.mjs`
- Modify: `src/entry.ts`
- Modify: `src/telegram-bot-ui.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `src/telegram-webhook-routing.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `shouldShowTeamOnboarding(env,userId): Promise<boolean>`.
- Produces `completeTeamOnboarding(env,userId,reason:'selection'|'not_now'): Promise<void>`.
- Produces `buildTeamOnboardingRecommendation(env,userId): Promise<OnboardingRecommendation>`.
- Consumes published teams and optional verified recommendation channels.

- [ ] **Step 1: Write RED onboarding tests**

Cover new user, existing zero-subscription user, legacy `all_titles=1`, migrated explicit subscription, selection completion, `Не сейчас`, abandon/back/restart, membership lookup success, lookup failure fallback, multi-channel matches, and no later subscription synchronization from channel membership.

```js
test('abandoning onboarding does not mark it complete', async () => {
  const env = onboardingFixture();
  await openOnboarding(env, '100');
  assert.equal(await onboardingCompleted(env.db, '100'), false);
  assert.equal(await shouldShowTeamOnboarding(env, '100'), true);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/telegram-team-onboarding.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement rollout eligibility**

`shouldShowTeamOnboarding` returns false if onboarding completion exists OR any effective legacy/new notification subscription exists. New/zero-config users return true while `ranobelib_multi_team_ui=1`.

- [ ] **Step 4: Implement recommendation membership checks**

Only channels with `recommendation_membership_capable=1` are queried. Telegram errors/insufficient rights return normal onboarding, never a failed `/start`. Multiple matches render a selector rather than combinatorial buttons.

- [ ] **Step 5: Implement completion semantics**

Write completion only after a successful team subscription transaction or explicit `not_now`. `Назад`, menu exit, timeout, new `/start`, or catalog browsing do not write completion.

- [ ] **Step 6: Wire `/start` without slowing existing configured users**

Check local D1 subscription/onboarding state before external membership calls. Existing configured users must stay on the fast main-menu path. External Telegram membership lookup happens only for users who actually need onboarding.

- [ ] **Step 7: Run latency/regression tests**

```bash
node --test tests/telegram-team-onboarding.test.mjs tests/telegram-latency-v2-start.test.mjs tests/telegram-latency-v3-start.test.mjs tests/telegram-webhook-routing.test.mjs tests/telegram-text-bot-ux-e2e.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/telegram-team-onboarding.ts src/entry.ts src/telegram-bot-ui.ts src/telegram-subscription-webhook.ts src/telegram-webhook-routing.ts tests/telegram-team-onboarding.test.mjs package.json
git commit -m "feat: add multi-team onboarding"
```

---

### Task 10: Add admin team management and safe recommendation-channel attachment

**Files:**
- Create: `src/telegram-team-admin.ts`
- Create: `tests/telegram-team-admin.test.mjs`
- Modify: `src/telegram-admin-stats.ts`
- Modify: `src/telegram-webhook-routing.ts`
- Modify: `src/entry.ts`
- Modify: `package.json`

**Interfaces:**
- Produces admin actions: list teams, add/preview/confirm, retry sync, publish, pause/resume, attach/replace/remove recommendation channel.
- Accepts recommendation channel input as `@username`, `t.me/...`, or forwarded channel message.
- Persists canonical Telegram chat ID only after successful resolution.

- [ ] **Step 1: Write RED admin tests**

Cover non-admin rejection, team URL validation before persistence, silent initial sync, hidden-by-default new team, explicit publish, pause preserving subscriptions, `@username`, `t.me` link, forwarded message source, unresolvable forward fallback, insufficient membership access warning, and publication-setting isolation.

- [ ] **Step 2: Run RED**

Run: `node --test tests/telegram-team-admin.test.mjs tests/telegram-admin-stats.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement admin team state machine**

Keep temporary add/attachment input state server-side with expiry, following current Telegram wizard patterns. Validate RanobeLib team first, show preview, then persist team as `hidden` and trigger silent baseline.

- [ ] **Step 4: Implement recommendation-channel resolver**

Normalize public forms:

```ts
function normalizeRecommendationChannelInput(text: string): string | null {
  const value = text.trim();
  if (/^@[A-Za-z0-9_]{5,}$/.test(value)) return value;
  const match = /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,})\/?$/i.exec(value);
  return match ? `@${match[1]}` : null;
}
```

Resolve with Telegram `getChat`. For forwarded messages, use the source channel ID Telegram supplies; never infer a hidden channel from display text. Probe membership lookup capability using a safe admin/current-user `getChatMember` check and store capability separately from team validity.

- [ ] **Step 5: Enforce isolation in code/tests**

`telegram-team-admin.ts` may write only `ranobelib_teams.recommendation_*` fields. It must not import publication settings mutation helpers. Regression assertions compare `publish_channel_id` and channel-membership-gate config before/after attachment.

- [ ] **Step 6: Add compact `/stats` aggregates**

Show team counts by lifecycle plus error/stale count; detailed per-team sync data remains in `Управление командами`.

- [ ] **Step 7: Run tests**

```bash
node --test tests/telegram-team-admin.test.mjs tests/telegram-admin-stats.test.mjs tests/publishing-settings.test.mjs tests/channel-membership-access.test.mjs tests/channel-membership-appeals.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/telegram-team-admin.ts src/telegram-admin-stats.ts src/telegram-webhook-routing.ts src/entry.ts tests/telegram-team-admin.test.mjs package.json
git commit -m "feat: add admin team management"
```

---

### Task 11: Add reversible shadow/live rollout wiring

**Files:**
- Create: `src/multi-team-rollout.ts`
- Create: `tests/multi-team-rollout.test.mjs`
- Modify: `src/live-entry-v2.ts`
- Modify: `src/ranobelib-runtime.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `getMultiTeamRollout(env): Promise<MultiTeamRolloutState>`.
- Switches are independent: shadow detection, live delivery, user UI.
- Legacy production path remains callable while delivery/UI flags are disabled.

```ts
export type MultiTeamRolloutState = {
  shadow: boolean;
  delivery: boolean;
  ui: boolean;
};
```

- [ ] **Step 1: Write RED rollout tests**

Cover all-off legacy behavior, shadow scanner with no releases/outbox, delivery cutover for primary team, UI disabled while delivery enabled, immediate rollback to legacy read path, and migration tables remaining harmless when flags are off.

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-team-rollout.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement cached D1 flag reads**

Use `app_settings` and a short per-invocation/in-memory cache compatible with Workers. Missing/invalid values mean `false`.

- [ ] **Step 4: Wire scheduled jobs**

`DISCOVERY_CRON`: legacy primary discovery remains authoritative when all flags are off; shadow/live invokes registered-team discovery without allowing one team error to abort all others.

HOT/IDLE: when shadow is on, run branch-aware shadow scan in addition to the legacy primary path; when delivery is on, branch-aware scanner becomes authoritative and legacy release creation is skipped.

Queue/fallback delivery continues to drain the same D1 outbox; only eligibility/release producers change.

- [ ] **Step 5: Wire Telegram UI switch**

When `ui=false`, `/notifications` and `/start` use existing primary-team UX. When `ui=true`, route to team-aware catalog/onboarding. Admin team management may remain accessible to admins before user UI exposure for validation.

- [ ] **Step 6: Emit structured rollout diagnostics**

Log mode, selected/fetched works, detected/persisted releases, ambiguous branch count, and team errors. Do not log private Telegram message content.

- [ ] **Step 7: Run rollout and scheduler regressions**

```bash
node --test tests/multi-team-rollout.test.mjs tests/ranobelib-fast-scanner.test.mjs tests/paid-fast-scanner.test.mjs tests/paid-idle-scanner.test.mjs tests/telegram-subscription-webhook.test.mjs tests/telegram-webhook-routing.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/multi-team-rollout.ts src/live-entry-v2.ts src/ranobelib-runtime.ts src/telegram-subscription-webhook.ts tests/multi-team-rollout.test.mjs package.json
git commit -m "feat: add reversible multi-team rollout"
```

---

### Task 12: Add parity diagnostics, full regression gate, and operations documentation

**Files:**
- Create: `tests/multi-team-shadow-parity.test.mjs`
- Modify: `src/telegram-admin-stats.ts`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Admin diagnostics expose aggregate migration parity and branch-identity health without exposing private subscriber identities.
- README documents exact enable/disable order and rollback procedure.

- [ ] **Step 1: Write RED parity tests**

Test that migrated primary-team effective subscriber counts match the legacy model for representative fixtures; shadow mode detects the same primary-team chapter delta without writing a release; native/fallback/ambiguous branch counters are reported.

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-team-shadow-parity.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Add operational counters**

Expose aggregate counts only:

```text
Teams: published / hidden / paused / error
Sync: stale teams / teams with errors
Branch identity: native / fallback / ambiguous
Migration parity: legacy effective users / primary-team effective users / mismatch
Rollout: shadow / delivery / UI
```

Do not include user IDs in `/stats` output.

- [ ] **Step 4: Document staged production rollout**

README order must be explicit:

```text
1. Deploy migration + code with all switches 0.
2. Verify primary-team migration parity and no outbox replay.
3. Enable ranobelib_multi_team_shadow=1.
4. Observe at least one normal discovery/HOT/IDLE cycle and validate shadow parity/ambiguity counters.
5. Enable ranobelib_multi_team_delivery=1 while UI remains 0.
6. Verify primary-team production notifications/outbox/stack behavior.
7. Add/sync external teams hidden; verify silent baseline.
8. Publish validated teams.
9. Enable ranobelib_multi_team_ui=1.
10. Keep legacy tables/read path during stabilization.
```

Rollback documentation:

```text
Set ranobelib_multi_team_ui=0, ranobelib_multi_team_delivery=0, ranobelib_multi_team_shadow=0.
Do not roll back migration 0023 and do not delete new tables; the preserved legacy primary-team path becomes authoritative again.
```

- [ ] **Step 5: Run the entire repository verification gate**

```bash
npm run typecheck
npm test
```

Expected: both exit 0 with zero failing tests.

- [ ] **Step 6: Inspect migration/branch diff before merge**

```bash
git status --short
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: clean working tree after commits, `git diff --check` exit 0, and only intended multi-team/spec/plan changes in the branch history.

- [ ] **Step 7: Commit docs/diagnostics**

```bash
git add tests/multi-team-shadow-parity.test.mjs src/telegram-admin-stats.ts README.md package.json
git commit -m "docs: add multi-team rollout gate"
```

---

## Final review gate before enabling production switches

After all tasks are implemented, do not enable live flags merely because unit tests pass. Verify all of the following on the implementation branch/PR:

- migration is additive and applies cleanly from a production-shaped legacy fixture;
- primary-team migrated subscription parity has zero unexplained mismatch;
- no historical releases/outbox rows are created by migration or baseline;
- native `branch_id` path works on current RanobeLib payloads;
- fallback/ambiguous paths do not merge independent branches;
- joint branches generate one release and one user outbox row;
- independent branches remain independent;
- completed status is team-specific;
- hidden/paused teams cannot leak into user catalog or demand;
- external recommendation channels cannot mutate publication/download/blacklist configuration;
- `/start` remains fast for already-configured users;
- existing instant/stack/flush semantics pass unchanged;
- Queue failure still leaves D1 outbox recoverable by fallback cron;
- full `npm test` and `npm run typecheck` are green;
- CI is green before any merge/cutover;
- production flags are enabled in the documented order, with rollback switches available throughout stabilization.

No legacy schema cleanup is part of this plan. Cleanup requires a separate follow-up after the new path has proven stable and legacy dependence is demonstrably zero.