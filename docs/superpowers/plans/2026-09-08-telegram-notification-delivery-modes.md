# Telegram Notification Delivery Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global and per-title Telegram notification delivery modes: instant or stacked at 5/10/20/custom 2–100 chapters, with a 7-day safety flush and no duplicate/lost notifications.

**Architecture:** Keep `ranobelib_notification_outbox` as the only durable pending-delivery source. Add normalized delivery-setting helpers plus per-title overrides, then change the v3 delivery worker from claiming individual rows to claiming ready `(user_telegram_id, book_ref)` groups. Telegram settings callbacks only persist settings and wake the existing delivery path; they do not bypass the outbox.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Cloudflare Queues, Telegram Bot API, Node `node:test`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-08-telegram-notification-delivery-modes-design.md`

## Global Constraints

- Existing users default to `instant` and must keep no intentional delivery delay.
- Stack presets are exactly 5 / 10 / 20; custom values are integers 2–100.
- Per-title overrides win over the global default and survive later global-mode changes.
- Stack count is `SUM(ranobelib_releases.chapter_count)` per `(user, title)`.
- Crossing a threshold sends the entire accumulated group, including overflow.
- Partial stacks flush 7 days after the oldest pending member; later chapters never reset that clock.
- Switching to `instant` or lowering a threshold below the pending count makes the existing group ready immediately.
- One aggregated chapter uses a direct reader URL when metadata is sufficient; 2+ aggregated chapters use the title page.
- Existing v3 retry, 403 disable, reachability, Queue wake-up, cron fallback, and lease behavior remain authoritative.
- `DELIVERY_BATCH_LIMIT = 20` means at most 20 Telegram messages/groups per drain, not 20 release rows.
- Migration `0016` is the authoritative production schema change; runtime schema repair must remain non-destructive.

---

## File Structure

- Create `migrations/0016_telegram_notification_delivery_modes.sql` — production D1 schema for stack size, title overrides, custom-input state, and indexes.
- Create `src/telegram-notification-settings.ts` — normalized delivery-setting types, validation, effective-setting reads/writes, custom-input state helpers, and a reusable “does this change make pending work ready?” query/wake contract.
- Modify `src/telegram-subscriptions.ts` — global/title mode UI, callback parsing, custom-size prompt/input handling, and notification-center state.
- Modify `src/telegram-subscription-webhook.ts` if needed to route ordinary text messages through custom-size handling before other text flows.
- Modify `src/telegram-notification-delivery.ts` — ready-group selection, group lease claiming, aggregation, send, grouped persistence, direct/title URL choice.
- Modify `src/telegram-subscription-delivery-schema.ts` — ensure the new non-destructive runtime tables/columns exist for legacy/test entry points.
- Modify `src/live-entry-v2.ts` / `src/worker.ts` only if needed to expose the existing Queue wake-up helper to settings mutations without duplicating Queue semantics.
- Modify `package.json` / `tsconfig.runtime-test.json` only if a new source/test file must be included in the runtime-test build/test list.
- Modify `tests/telegram-subscriptions.test.mjs` — callback parsing/UI/pure settings behavior.
- Modify `tests/telegram-notifications-v2-runtime.test.mjs` and/or `tests/telegram-subscription-webhook.test.mjs` — DB mutation and custom-input runtime behavior.
- Modify `tests/telegram-notification-delivery-v3.test.mjs` — grouped delivery, threshold/timeout/retry/concurrency/link semantics.
- Modify `tests/telegram-notification-v3-wiring.test.mjs` — Queue/cron/settings wake-up wiring and migration-owned schema expectations.

---

### Task 1: Add delivery-mode schema and normalization primitives

**Files:**
- Create: `migrations/0016_telegram_notification_delivery_modes.sql`
- Create: `src/telegram-notification-settings.ts`
- Modify: `src/telegram-subscription-delivery-schema.ts`
- Modify: `tsconfig.runtime-test.json`
- Test: `tests/telegram-subscriptions.test.mjs`
- Test: `tests/telegram-notifications-v2-runtime.test.mjs`

**Interfaces:**
- Produces:
  - `export type DeliverySetting = { mode: 'instant'; stackSize: null } | { mode: 'stack'; stackSize: number }`
  - `export function normalizeDeliverySetting(mode: unknown, stackSize: unknown): DeliverySetting`
  - `export function validateCustomStackSize(value: unknown): number | null`
  - `export function deliverySettingLabel(setting: DeliverySetting): string`
  - `export async function getGlobalDeliverySetting(env, userId): Promise<DeliverySetting>`
  - `export async function getTitleDeliverySetting(env, userId, bookRef): Promise<{ setting: DeliverySetting; inherited: boolean }>`
  - `export async function setGlobalDeliverySetting(env, userId, setting): Promise<void>`
  - `export async function setTitleDeliverySetting(env, userId, bookRef, setting): Promise<void>`
  - `export async function clearTitleDeliverySetting(env, userId, bookRef): Promise<void>`

- [ ] **Step 1: Write failing pure-function tests**

Add cases equivalent to:

```js
const settings = await import('../dist-runtime/telegram-notification-settings.js');
assert.deepEqual(settings.normalizeDeliverySetting('instant', 10), { mode: 'instant', stackSize: null });
assert.deepEqual(settings.normalizeDeliverySetting('stack', 5), { mode: 'stack', stackSize: 5 });
assert.deepEqual(settings.normalizeDeliverySetting('stack', 100), { mode: 'stack', stackSize: 100 });
assert.deepEqual(settings.normalizeDeliverySetting('stack', 1), { mode: 'instant', stackSize: null });
assert.equal(settings.validateCustomStackSize('2'), 2);
assert.equal(settings.validateCustomStackSize('100'), 100);
assert.equal(settings.validateCustomStackSize('1'), null);
assert.equal(settings.validateCustomStackSize('101'), null);
assert.equal(settings.validateCustomStackSize('2.5'), null);
assert.equal(settings.validateCustomStackSize('abc'), null);
```

- [ ] **Step 2: Run targeted test and verify RED**

Run:

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-notifications-v2-runtime.test.mjs
```

Expected: FAIL because `telegram-notification-settings.js` / new schema behavior does not exist.

- [ ] **Step 3: Add migration `0016`**

Use forward-only SQL:

```sql
ALTER TABLE telegram_subscription_settings ADD COLUMN stack_size INTEGER;

CREATE TABLE telegram_title_delivery_settings (
  user_telegram_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('instant','stack')),
  stack_size INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  CHECK (
    (delivery_mode='instant' AND stack_size IS NULL)
    OR
    (delivery_mode='stack' AND stack_size BETWEEN 2 AND 100)
  )
);

CREATE TABLE telegram_notification_input_state (
  user_telegram_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','title')),
  book_ref TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  CHECK ((scope='global' AND book_ref IS NULL) OR (scope='title' AND book_ref IS NOT NULL))
);

CREATE INDEX idx_telegram_title_delivery_book
  ON telegram_title_delivery_settings(book_ref, user_telegram_id);
CREATE INDEX idx_telegram_notification_input_expiry
  ON telegram_notification_input_state(expires_at);
```

Do not rebuild `telegram_subscription_settings`; existing `delivery_mode='instant'` rows remain valid and `stack_size` starts NULL.

- [ ] **Step 4: Implement normalized setting module**

Normalization rules:

```ts
export function normalizeDeliverySetting(mode: unknown, stackSize: unknown): DeliverySetting {
  if (mode !== 'stack') return { mode: 'instant', stackSize: null };
  const size = Number(stackSize);
  if (!Number.isInteger(size) || size < 2 || size > 100) return { mode: 'instant', stackSize: null };
  return { mode: 'stack', stackSize: size };
}
```

Writes use `INSERT ... ON CONFLICT DO UPDATE` for global/title settings; `clearTitleDeliverySetting()` performs a DELETE so inheritance remains explicit.

- [ ] **Step 5: Extend runtime schema repair non-destructively**

`ensureTelegramSubscriptionDeliverySchema()` must ensure `stack_size` exists and create the two new tables/indexes with `IF NOT EXISTS`; duplicate-column errors are tolerated exactly like existing `delivery_mode` self-healing. It must not recreate/drop the release trigger.

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run:

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-notifications-v2-runtime.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/0016_telegram_notification_delivery_modes.sql src/telegram-notification-settings.ts src/telegram-subscription-delivery-schema.ts tsconfig.runtime-test.json tests/telegram-subscriptions.test.mjs tests/telegram-notifications-v2-runtime.test.mjs
git commit -m "feat: add notification delivery mode settings"
```

---

### Task 2: Add global and per-title Telegram settings UI

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Modify: `src/telegram-notification-settings.ts`
- Test: `tests/telegram-subscriptions.test.mjs`
- Test: `tests/telegram-subscription-webhook.test.mjs`

**Interfaces:**
- Consumes Task 1 setting read/write APIs.
- Produces callback kinds for global/title presets, custom prompt, and inheritance reset.
- Produces `handleNotificationCustomInput(update, env): Promise<boolean>` (name may live in `telegram-subscriptions.ts` if that avoids a circular dependency).

- [ ] **Step 1: Write failing callback/UI tests**

Cover callback strings with compact payloads:

```text
subs:mode:g:i
subs:mode:g:5
subs:mode:g:10
subs:mode:g:20
subs:mode:g:c
subs:mode:t:<titleId>:i
subs:mode:t:<titleId>:5
subs:mode:t:<titleId>:10
subs:mode:t:<titleId>:20
subs:mode:t:<titleId>:c
subs:mode:t:<titleId>:inherit
```

Assert the notification center renders current global mode and override count, while the title panel renders both effective title mode and global mode plus `↩️ Использовать общий режим` when overridden.

- [ ] **Step 2: Run targeted UI tests and verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: FAIL on unknown callbacks/missing buttons.

- [ ] **Step 3: Extend callback parsing and panels**

`buildNotificationCenter()` must include:

```text
Режим по умолчанию: <label>
Индивидуальные настройки: N
[⚡ Мгновенно]
[📦 По 5] [📦 По 10] [📦 По 20]
[⚙️ Кастомный]
```

`buildTitleSettingsPanel()` must show:

```text
Режим: <effective label>
Общий режим: <global label>
```

and the same preset/custom controls. If an override exists, show inheritance reset; if not, mark the title as using the global mode.

- [ ] **Step 4: Add custom-input state helpers and tests**

Store a 10-minute state:

```sql
INSERT INTO telegram_notification_input_state(user_telegram_id,scope,book_ref,expires_at)
VALUES (?,?,?,datetime('now','+10 minutes'))
ON CONFLICT(user_telegram_id) DO UPDATE SET
  scope=excluded.scope,
  book_ref=excluded.book_ref,
  expires_at=excluded.expires_at,
  created_at=CURRENT_TIMESTAMP
```

Ordinary text handling checks an unexpired state first. Integer 2–100 applies the requested global/title setting and deletes the state. Invalid input sends `Введите целое число от 2 до 100.` and leaves the state active. Expired state is deleted/ignored and normal webhook routing continues.

- [ ] **Step 5: Persist preset/inherit callbacks**

Preset callbacks write `{ mode:'instant', stackSize:null }` or `{ mode:'stack', stackSize:N }`. `inherit` deletes the title override row. Changing global settings never touches title override rows.

- [ ] **Step 6: Run targeted tests and verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-subscriptions.ts src/telegram-subscription-webhook.ts src/telegram-notification-settings.ts tests/telegram-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs
git commit -m "feat: add notification delivery mode controls"
```

---

### Task 3: Replace row claiming with ready delivery-group claiming

**Files:**
- Modify: `src/telegram-notification-delivery.ts`
- Test: `tests/telegram-notification-delivery-v3.test.mjs`

**Interfaces:**
- Consumes normalized DB setting semantics from Task 1.
- Produces grouped drain behavior keyed by `(user_telegram_id, book_ref)`.

- [ ] **Step 1: Add failing grouped-readiness tests**

Build DB fixtures with multiple releases for the same user/title and assert:

```text
stack 5, chapter_count 2 + 3 => one Telegram send, both outbox rows sent
stack 10, 8 + 5 => one Telegram send with chapterCount 13, no leftover
stack 10, total 9, oldest <7d => zero sends, rows remain pending
stack 10, total 9, oldest >=7d => one send
instant => ready immediately
```

Also assert two titles for the same user become two groups/messages, and one title subscribed by two users becomes two groups/messages.

- [ ] **Step 2: Run delivery test and verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs
```

Expected: FAIL because the worker still limits/claims rows rather than ready groups.

- [ ] **Step 3: Implement ready-group SQL**

Use one group-selection query whose logical inputs are all outbox rows in `pending/retry` and whose group key is `(o.user_telegram_id, r.book_ref)`. Compute:

```sql
SUM(r.chapter_count) AS pending_chapters,
MIN(o.created_at) AS oldest_pending_at,
MAX(CASE WHEN o.status='retry' AND o.available_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS retry_blocked
```

Resolve effective mode with `LEFT JOIN telegram_title_delivery_settings td ...` plus `LEFT JOIN telegram_subscription_settings s ...`, using title values when present and global values otherwise. Corrupt/missing modes normalize to instant semantics in SQL or in the candidate projection.

Candidate group readiness is:

```text
eligible subscription
AND reachable != blocked
AND retry_blocked = 0
AND (
  effective_mode = instant
  OR pending_chapters >= effective_stack_size
  OR oldest_pending_at <= datetime('now','-7 days')
)
```

Order by `oldest_pending_at ASC`; `LIMIT ?` limits group keys, not rows.

- [ ] **Step 4: Atomically claim all members of selected groups**

Use one invocation `claimToken`. After selecting at most 20 group keys, claim every currently unleased `pending/retry` row belonging to those keys. Do not apply a release-row LIMIT during the group claim. Preserve the 10-minute lease and `RETURNING release_id,user_telegram_id` ownership evidence.

If another worker claims a member between selection and claim, only send a group if this worker owns the complete currently-sendable group; otherwise release/skip the partial claim so a later drain can recover. The test must cover two concurrent drains and one send per group.

- [ ] **Step 5: Load and aggregate claimed members**

Aggregate in memory per `(user_telegram_id, book_ref)`:

```ts
type DeliveryGroup = {
  userTelegramId: string;
  bookRef: string;
  title: string;
  titleId: number | null;
  titleUrl: string;
  members: DeliveryRow[];
  chapterCount: number;
  firstVolume: string | null;
  firstNumber: string | null;
  lastVolume: string | null;
  lastNumber: string | null;
};
```

`chapterCount` is the sum of release counts. Preserve first/last metadata only when a reliable range can be derived; otherwise format total only.

- [ ] **Step 6: Run delivery tests and verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs
```

Expected: PASS for grouped readiness/claiming plus all pre-existing v3 concurrency/rate-limit tests.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-notification-delivery.ts tests/telegram-notification-delivery-v3.test.mjs
git commit -m "feat: group notification delivery by title"
```

---

### Task 4: Apply grouped outcome persistence, retries, and link formatting

**Files:**
- Modify: `src/telegram-notification-delivery.ts`
- Modify: `src/telegram-subscriptions.ts`
- Test: `tests/telegram-notification-delivery-v3.test.mjs`
- Test: `tests/telegram-notifications-v2.test.mjs`

**Interfaces:**
- Consumes `DeliveryGroup` from Task 3.
- Produces one Telegram payload/outcome per group and mutations for every claimed member.

- [ ] **Step 1: Add failing grouped-outcome tests**

Cover:

```text
success => every claimed group member becomes sent
403 => every member disabled + one blocked reachability observation
429 => every member retry with the same retry_after
500 => every member retry with the same normal backoff
future retry member => newer pending member does not jump ahead
retry due again => old + newer members send together
```

- [ ] **Step 2: Add link/format tests**

Assert exactly one aggregated chapter keeps:

```text
https://ranobelib.me/ru/<book_ref>/read/v<volume>/c<number>
```

while any grouped message with `chapterCount >= 2` uses the title URL. For 13 contiguous chapters render `Накопилось 13 новых глав` plus a reliable range; for ambiguous/cross-volume metadata render only the total.

- [ ] **Step 3: Run tests and verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2.test.mjs
```

Expected: FAIL on grouped outcome semantics/formatting.

- [ ] **Step 4: Implement group-level delivery and persistence**

Call Telegram once per `DeliveryGroup`. Convert one result into one mutation per member (batched through existing `DB.batch`) or one bounded SQL statement that updates all members owned by `claimToken`. Every final mutation must require `claim_token = ?` so ownership is preserved.

`hasMoreDue` must mean “another ready group exists”, not merely “another pending row exists”. Pending stacks below threshold must not spin Queue continuations.

- [ ] **Step 5: Run targeted tests and verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-notification-delivery.ts src/telegram-subscriptions.ts tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2.test.mjs
git commit -m "feat: persist grouped notification outcomes"
```

---

### Task 5: Wake delivery immediately after settings make a group ready

**Files:**
- Modify: `src/telegram-notification-settings.ts`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/live-entry-v2.ts` and/or `src/worker.ts` only if the Queue binding/helper is not already reachable from the Telegram subscription handler.
- Test: `tests/telegram-notification-v3-wiring.test.mjs`
- Test: `tests/telegram-subscription-webhook.test.mjs`

**Interfaces:**
- Produces `pendingDeliveryReadyForUserTitle(env, userId, bookRef?): Promise<boolean>` or equivalent query.
- Produces a single reusable wake operation that sends `{"kind":"drain"}` when Queue is available and safely falls back to cron when it is not.

- [ ] **Step 1: Write failing transition/wake tests**

Cover:

```text
7 pending, title 10 -> instant => wake
7 pending, title 10 -> 5 => wake
3 pending, title 5 -> 10 => no wake
8 pending, title override 20, global 5, remove override => wake
changing global to 5 => wake if any inherited group now qualifies
changing global must not alter title override rows
```

- [ ] **Step 2: Run wiring tests and verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-v3-wiring.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: FAIL because settings writes currently have no readiness wake logic.

- [ ] **Step 3: Add readiness check after settings persistence**

Do not send Telegram from the callback path. After each setting mutation, query whether at least one affected pending group is now ready using the same effective-mode/readiness rules as delivery. If yes, enqueue one `{"kind":"drain"}` wake-up when Queue exists. Queue failure is swallowed/logged because the 5-minute fallback cron remains durable recovery.

- [ ] **Step 4: Verify 7-day cron discovery**

Add a wiring assertion that the fallback cron still calls `drainNotificationOutbox()` without needing a new release/Queue event, so an expired 7-day stack becomes deliverable automatically.

- [ ] **Step 5: Run tests and verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-v3-wiring.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-notification-settings.ts src/telegram-subscriptions.ts src/live-entry-v2.ts src/worker.ts tests/telegram-notification-v3-wiring.test.mjs tests/telegram-subscription-webhook.test.mjs
git commit -m "feat: wake delivery after notification mode changes"
```

---

### Task 6: Harden boundaries and migration compatibility

**Files:**
- Modify: `tests/telegram-notification-delivery-v3.test.mjs`
- Modify: `tests/telegram-notifications-v2-runtime.test.mjs`
- Modify: `tests/telegram-subscription-wiring.test.mjs`
- Modify: `package.json` if new test files were added.

**Interfaces:**
- No new runtime API; this task closes edge cases from the spec.

- [ ] **Step 1: Add boundary/regression tests**

Explicitly cover:

```text
custom 2 and 100 accepted
1, 101, decimal, empty, non-numeric rejected
expired custom-input state ignored
unsubscribed/excluded pending group never sends
blocked reachability never sends
25+ release-row group is one Telegram message despite DELIVERY_BATCH_LIMIT=20
20 ready groups cap at 20 Telegram messages and set hasMoreDue when a 21st ready group exists
below-threshold stacks do not make hasMoreDue true
missing/corrupt delivery mode fails safe to instant
```

- [ ] **Step 2: Run focused tests and verify RED if any gap remains**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2-runtime.test.mjs tests/telegram-subscription-wiring.test.mjs
```

- [ ] **Step 3: Make the minimal fixes required by those failures**

Do not broaden scope beyond delivery modes. Keep subscription-demand, membership, scanner cadence, and proposal systems unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same command; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2-runtime.test.mjs tests/telegram-subscription-wiring.test.mjs package.json src
git commit -m "test: harden notification delivery modes"
```

---

### Task 7: Full verification and PR

**Files:**
- No feature code unless verification exposes a defect.

- [ ] **Step 1: Apply local migrations**

```bash
npm install --no-audit --no-fund
npm run db:local
```

Expected: migrations through `0016_telegram_notification_delivery_modes.sql` apply successfully.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run the complete test suite**

```bash
npm test
```

Expected: all tests pass, zero failures.

- [ ] **Step 4: Run Wrangler dry-run build**

Use the repository CI-equivalent dry-run command from `.github/workflows/ci.yml` (currently Wrangler deploy dry-run/no upload). Expected: exit 0.

- [ ] **Step 5: Review diff against the spec**

Verify every approved rule is represented by tests and that no unrelated files changed. In particular confirm:

```text
global default + per-title override inheritance
5/10/20/custom 2–100
7-day oldest-member flush
threshold overflow sends all
stack -> instant immediate readiness
lower threshold immediate readiness
higher threshold no early flush
single chapter direct URL; multi title URL
group lease duplicate prevention
retry blocks newer members
20-message group limit, not row limit
```

- [ ] **Step 6: Open PR to `main`**

Title:

```text
Add configurable Telegram notification delivery modes
```

Body should summarize schema, UI, grouped outbox delivery, 7-day flush, transition behavior, and verification commands/results.

- [ ] **Step 7: Verify GitHub Actions on the exact PR head SHA**

Do not mark the work complete until CI for the exact head commit is `completed/success`. If CI fails, fix via TDD and repeat verification.
