# Telegram Notification Delivery Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global and per-title Telegram notification delivery modes: instant or stacked at 5/10/20/custom 2–100 chapters, with a 7-day safety flush and no duplicate/lost notifications.

**Architecture:** Keep `ranobelib_notification_outbox` as the only durable pending-delivery source. Add normalized delivery-setting helpers plus per-title overrides, change the v3 worker from row delivery to ready `(user_telegram_id, book_ref)` group delivery, and share one Queue wake-up helper between scanners and settings mutations. Telegram callbacks only persist settings and wake the normal outbox path.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Cloudflare Queues, Telegram Bot API, Node `node:test`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-08-telegram-notification-delivery-modes-design.md`

## Global Constraints

- Existing users default to `instant` and keep no intentional delivery delay.
- Presets are exactly 5 / 10 / 20; custom stack values are integers 2–100.
- Per-title overrides win over the global default and survive global-mode changes.
- Stack count is `SUM(ranobelib_releases.chapter_count)` per `(user, title)`.
- Crossing a threshold sends the entire accumulated group, including overflow.
- Partial stacks flush 7 days after the oldest pending member; later chapters never reset that clock.
- Switching to `instant` or lowering a threshold below the pending count makes the full pending group ready immediately.
- Raising a threshold never flushes early.
- One aggregated chapter uses a direct reader URL when metadata is sufficient; 2+ aggregated chapters use the title page.
- Existing v3 retry, 403 disable, reachability, Queue wake-up, cron fallback, and lease behavior remain authoritative.
- `DELIVERY_BATCH_LIMIT = 20` means at most 20 Telegram messages/groups per drain, not 20 release rows.
- Migration `0016` is the authoritative production schema change; runtime schema repair remains non-destructive.

---

## File Structure

- Create `migrations/0016_telegram_notification_delivery_modes.sql` — production D1 schema.
- Create `src/telegram-notification-settings.ts` — normalized setting types, validation, DB reads/writes, custom-input state, and readiness probes after settings changes.
- Create `src/telegram-notification-wakeup.ts` — reusable `{"kind":"drain"}` Queue producer with safe fallback semantics.
- Modify `src/telegram-subscriptions.ts` — global/title mode UI, callback parsing, settings writes, custom-size text handling.
- Modify `src/telegram-subscription-webhook.ts` — route custom numeric replies before generic private-message acknowledgement while letting slash commands pass through normally.
- Modify `src/telegram-notification-delivery.ts` — ready-group selection, leasing, aggregation, Telegram send, grouped persistence, links.
- Modify `src/telegram-subscription-delivery-schema.ts` — legacy/test self-healing for new tables/column without trigger mutation.
- Modify `src/live-entry-v2.ts` — import and use the shared Queue wake-up helper.
- Modify `tsconfig.runtime-test.json` — include the two new TypeScript modules.
- Modify `tests/telegram-subscriptions.test.mjs`, `tests/telegram-notifications-v2-runtime.test.mjs`, `tests/telegram-subscription-webhook.test.mjs`, `tests/telegram-notification-delivery-v3.test.mjs`, and `tests/telegram-notification-v3-wiring.test.mjs`.

---

### Task 1: Add schema and normalized delivery settings

**Files:**
- Create: `migrations/0016_telegram_notification_delivery_modes.sql`
- Create: `src/telegram-notification-settings.ts`
- Modify: `src/telegram-subscription-delivery-schema.ts`
- Modify: `tsconfig.runtime-test.json`
- Test: `tests/telegram-subscriptions.test.mjs`
- Test: `tests/telegram-notifications-v2-runtime.test.mjs`

**Interfaces:**
- Produces `DeliverySetting = { mode:'instant'; stackSize:null } | { mode:'stack'; stackSize:number }`.
- Produces `normalizeDeliverySetting(mode, stackSize)`, `validateCustomStackSize(value)`, `deliverySettingLabel(setting)`.
- Produces async DB helpers `getGlobalDeliverySetting`, `getTitleDeliverySetting`, `setGlobalDeliverySetting`, `setTitleDeliverySetting`, `clearTitleDeliverySetting`.
- Produces custom-input helpers `beginNotificationCustomInput`, `getNotificationCustomInput`, `clearNotificationCustomInput`.

- [ ] **Step 1: Write failing normalization tests**

Add cases:

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

- [ ] **Step 2: Verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-notifications-v2-runtime.test.mjs
```

Expected: FAIL because the new runtime module/schema is absent.

- [ ] **Step 3: Add migration `0016`**

Use:

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
  CHECK ((delivery_mode='instant' AND stack_size IS NULL)
      OR (delivery_mode='stack' AND stack_size BETWEEN 2 AND 100))
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

Existing settings rows remain `instant` with `stack_size=NULL`.

- [ ] **Step 4: Implement normalization and DB helpers**

Core normalization:

```ts
export function normalizeDeliverySetting(mode: unknown, stackSize: unknown): DeliverySetting {
  if (mode !== 'stack') return { mode: 'instant', stackSize: null };
  const size = Number(stackSize);
  if (!Number.isInteger(size) || size < 2 || size > 100) return { mode: 'instant', stackSize: null };
  return { mode: 'stack', stackSize: size };
}
```

Global writes update `delivery_mode` + `stack_size`; title writes use `INSERT ... ON CONFLICT DO UPDATE`; inheritance deletes the title row. Custom input stores `scope`, optional `book_ref`, and `datetime('now','+10 minutes')`.

- [ ] **Step 5: Extend non-destructive runtime schema repair**

`ensureTelegramSubscriptionDeliverySchema()` adds `stack_size` with duplicate-column tolerance and creates both new tables/indexes with `IF NOT EXISTS`. It never drops/recreates `trg_ranobelib_release_notifications`.

- [ ] **Step 6: Verify GREEN**

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

### Task 2: Add global/title controls and custom numeric input

**Files:**
- Modify: `src/telegram-subscriptions.ts`
- Modify: `src/telegram-subscription-webhook.ts`
- Test: `tests/telegram-subscriptions.test.mjs`
- Test: `tests/telegram-subscription-webhook.test.mjs`

**Interfaces:**
- Consumes Task 1 setting/custom-input helpers.
- Produces `handleNotificationCustomInput(update, env): Promise<boolean>` in `telegram-subscriptions.ts`.
- Adds callback variants for global presets/custom and title presets/custom/inherit.

- [ ] **Step 1: Write failing callback/UI tests**

Required callback payloads:

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

Notification center assertions:

```text
Режим по умолчанию: <label>
Индивидуальные настройки: N
[⚡ Мгновенно]
[📦 По 5] [📦 По 10] [📦 По 20]
[⚙️ Кастомный]
```

Title panel assertions:

```text
Режим: <effective label>
Общий режим: <global label>
[↩️ Использовать общий режим]  // only when override exists
```

- [ ] **Step 2: Verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: FAIL on missing callbacks/buttons/handlers.

- [ ] **Step 3: Implement preset and inherit callbacks**

`i` writes instant; `5/10/20` writes stack sizes; `inherit` deletes the override. Global mutation never deletes title override rows. After mutation, redraw the current center/title panel from DB state.

- [ ] **Step 4: Implement custom input**

`c` stores a 10-minute input state and prompts:

```text
📦 Введите размер стака от 2 до 100 глав.
```

`handleNotificationCustomInput()` ignores slash commands, then consumes only private text with an unexpired state. Valid integer 2–100 writes the requested global/title setting, clears state, and confirms. Invalid input replies `Введите целое число от 2 до 100.` and keeps state. Expired state is deleted and returns `false` so normal webhook routing continues.

- [ ] **Step 5: Route custom input in webhook**

In `handleTelegramSubscriptionWebhookRequest()`, after callback handling and private-chat validation but before `/notifications`, `/subscriptions`, and generic acknowledgement, call `handleNotificationCustomInput()`. Slash commands return `false` from that handler and continue through command routing.

- [ ] **Step 6: Verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-subscriptions.ts src/telegram-subscription-webhook.ts tests/telegram-subscriptions.test.mjs tests/telegram-subscription-webhook.test.mjs
git commit -m "feat: add notification delivery mode controls"
```

---

### Task 3: Claim and aggregate ready delivery groups

**Files:**
- Modify: `src/telegram-notification-delivery.ts`
- Test: `tests/telegram-notification-delivery-v3.test.mjs`

**Interfaces:**
- Group key: `(user_telegram_id, book_ref)`.
- `DELIVERY_BATCH_LIMIT` limits selected groups/messages.
- Produces internal `DeliveryGroup` with all claimed members and summed `chapterCount`.

- [ ] **Step 1: Write failing readiness tests**

Cover:

```text
stack 5: 2 + 3 => one send, both rows sent
stack 10: 8 + 5 => one 13-chapter send, no leftover
stack 10: total 9, oldest <7d => no send
stack 10: total 9, oldest >=7d => one send
instant => immediately ready
two titles for one user => two groups
one title for two users => two groups
```

- [ ] **Step 2: Verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs
```

Expected: FAIL because current delivery claims rows.

- [ ] **Step 3: Implement ready-group SQL**

For `pending/retry` rows group by user/title and compute:

```sql
SUM(r.chapter_count) AS pending_chapters,
MIN(o.created_at) AS oldest_pending_at,
MAX(CASE WHEN o.status='retry' AND o.available_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS retry_blocked
```

Resolve effective settings by left joining `telegram_title_delivery_settings` first and `telegram_subscription_settings` second. Apply existing subscription/exclusion and reachability predicates. A group is ready when `retry_blocked=0` and either mode is instant, sum reaches stack size, or oldest pending is at least 7 days old. Corrupt/missing setting data is treated as instant.

Order ready groups by oldest pending time and `LIMIT ?` to 20 groups.

- [ ] **Step 4: Claim every member of selected groups**

Use one `claimToken` and the existing 10-minute lease. Do not row-limit members of selected groups. `RETURNING release_id,user_telegram_id` records ownership. Before sending, verify that no currently-sendable member of the selected group is owned by another live claim; if ownership is incomplete, clear this worker's partial claims for that group and leave it for a later drain.

- [ ] **Step 5: Aggregate claimed rows**

Internal shape:

```ts
type DeliveryGroup = {
  userTelegramId: string;
  bookRef: string;
  titleId: number | null;
  title: string;
  titleUrl: string;
  members: DeliveryRow[];
  chapterCount: number;
  firstVolume: string | null;
  firstNumber: string | null;
  lastVolume: string | null;
  lastNumber: string | null;
};
```

Sum `chapter_count`. Keep range metadata only when safe; ambiguous/cross-volume groups later render total only.

- [ ] **Step 6: Preserve concurrency/rate limits**

Continue fixed Telegram send concurrency 5 and current pacing. Two concurrent drains must produce one send per group, never duplicate a group.

- [ ] **Step 7: Verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs
```

Expected: PASS including existing v3 concurrency tests.

- [ ] **Step 8: Commit**

```bash
git add src/telegram-notification-delivery.ts tests/telegram-notification-delivery-v3.test.mjs
git commit -m "feat: group notification delivery by title"
```

---

### Task 4: Persist grouped outcomes and format grouped notifications

**Files:**
- Modify: `src/telegram-notification-delivery.ts`
- Modify: `src/telegram-subscriptions.ts`
- Test: `tests/telegram-notification-delivery-v3.test.mjs`
- Test: `tests/telegram-notifications-v2.test.mjs`

**Interfaces:**
- Consumes Task 3 `DeliveryGroup`.
- One Telegram result applies to every member owned by the group's `claimToken`.

- [ ] **Step 1: Write failing grouped-outcome tests**

Cover success, 403, 429, transient 500, retry ordering, and retry reunion:

```text
success => every member sent
403 => every member disabled; blocked reachability recorded
429 => every member retry with same retry_after
500 => every member retry with same normal backoff
future retry member => newer pending member cannot jump ahead
retry due => old + newer members send together
```

- [ ] **Step 2: Write link/format tests**

Exactly one aggregated chapter retains direct reader URL. Any `chapterCount >= 2` uses title URL. A reliable contiguous range can show the first/last chapter; unsafe range data shows only the total count and never invents continuity.

- [ ] **Step 3: Verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2.test.mjs
```

- [ ] **Step 4: Implement one-send-per-group and grouped mutations**

Call Telegram once per group. Convert the outcome into claim-owned updates for every member; use existing `DB.batch()` for bounded writes. Every update/delete includes `claim_token = ?`. A failed grouped send gives every member the same retry schedule.

`hasMoreDue` is recomputed from ready groups, not pending rows. A below-threshold stack must not trigger Queue continuation loops.

- [ ] **Step 5: Verify GREEN**

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

### Task 5: Share Queue wake-up and re-evaluate after settings changes

**Files:**
- Create: `src/telegram-notification-wakeup.ts`
- Modify: `src/live-entry-v2.ts`
- Modify: `src/telegram-notification-settings.ts`
- Modify: `src/telegram-subscriptions.ts`
- Modify: `tsconfig.runtime-test.json`
- Test: `tests/telegram-notification-v3-wiring.test.mjs`
- Test: `tests/telegram-subscription-webhook.test.mjs`

**Interfaces:**
- Produces `NotificationWakeupEnv = { NOTIFICATION_QUEUE?: { send(message:{kind:'drain'}): Promise<void> } }`.
- Produces `queueNotificationWakeup(env): Promise<boolean>` in `telegram-notification-wakeup.ts`.
- Produces `hasReadyNotificationGroup(env, userId, bookRef?: string): Promise<boolean>` in `telegram-notification-settings.ts` using the same effective-mode readiness semantics as delivery.

- [ ] **Step 1: Write failing transition/wake tests**

Cover:

```text
7 pending, title 10 -> instant => wake
7 pending, title 10 -> 5 => wake
3 pending, title 5 -> 10 => no wake
8 pending, title override 20, global 5, remove override => wake
global -> 5 => wake if an inherited pending group now qualifies
global mutation preserves title override rows
```

- [ ] **Step 2: Verify RED**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-v3-wiring.test.mjs tests/telegram-subscription-webhook.test.mjs
```

- [ ] **Step 3: Extract shared Queue helper**

Move the existing safe wake behavior from `live-entry-v2.ts` into the new module:

```ts
export async function queueNotificationWakeup(env: NotificationWakeupEnv): Promise<boolean> {
  try {
    const send = env.NOTIFICATION_QUEUE?.send({ kind: 'drain' });
    if (!send) return false;
    await send;
    return true;
  } catch (error) {
    console.error('Notification Queue wake-up failed', error);
    return false;
  }
}
```

`live-entry-v2.ts` imports it for fast scan, idle scan, and Queue continuation.

- [ ] **Step 4: Re-evaluate after every setting mutation**

After global/title preset, custom value, or inherit is persisted, call `hasReadyNotificationGroup()` for the affected scope. If true, call `queueNotificationWakeup()`. Do not send Telegram from the callback path. Queue failure is non-fatal because fallback cron remains authoritative.

- [ ] **Step 5: Verify 7-day cron discovery**

Keep `FALLBACK_DELIVERY_CRON = '*/5 * * * *'` calling `drainNotificationOutbox()`. Add a wiring test proving no Queue event/new release is required for the cron to find an expired stack.

- [ ] **Step 6: Verify GREEN**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-v3-wiring.test.mjs tests/telegram-subscription-webhook.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-notification-wakeup.ts src/live-entry-v2.ts src/telegram-notification-settings.ts src/telegram-subscriptions.ts tsconfig.runtime-test.json tests/telegram-notification-v3-wiring.test.mjs tests/telegram-subscription-webhook.test.mjs
git commit -m "feat: wake delivery after notification mode changes"
```

---

### Task 6: Harden boundaries, run full verification, and open PR

**Files:**
- Modify: `tests/telegram-notification-delivery-v3.test.mjs`
- Modify: `tests/telegram-notifications-v2-runtime.test.mjs`
- Modify: `tests/telegram-subscription-wiring.test.mjs`
- Modify runtime files only when a new boundary test exposes a defect.

**Interfaces:**
- No new public runtime API.

- [ ] **Step 1: Add boundary/regression tests**

Cover:

```text
custom 2 and 100 accepted
1, 101, decimal, empty, non-numeric rejected
expired custom-input state ignored
unsubscribed/excluded pending group never sends
blocked reachability never sends
25+ release-row group => one Telegram message despite DELIVERY_BATCH_LIMIT=20
20 ready groups => 20 messages; 21st ready group makes hasMoreDue=true
below-threshold stacks do not make hasMoreDue=true
missing/corrupt settings fail safe to instant
single direct URL; multi title URL
```

- [ ] **Step 2: Run focused tests**

```bash
npm run build:runtime-test && node --test tests/telegram-notification-delivery-v3.test.mjs tests/telegram-notifications-v2-runtime.test.mjs tests/telegram-subscription-wiring.test.mjs
```

Fix only failures caused by delivery-mode behavior and rerun until PASS.

- [ ] **Step 3: Apply local migrations**

```bash
npm install --no-audit --no-fund
npm run db:local
```

Expected: migrations through `0016_telegram_notification_delivery_modes.sql` apply successfully.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 5: Run complete tests**

```bash
npm test
```

Expected: zero failures.

- [ ] **Step 6: Run CI-equivalent Wrangler dry run**

Read `.github/workflows/ci.yml` and run its current Wrangler deploy dry-run command exactly. Expected: exit 0.

- [ ] **Step 7: Spec coverage review**

Confirm tests cover: global default, title overrides, 5/10/20/custom 2–100, oldest-member 7-day flush, threshold overflow, stack→instant, threshold lower/higher transitions, direct-vs-title links, lease duplicate prevention, retry ordering, 20-group message limit, cron safety flush, and no intentional delay in instant mode.

- [ ] **Step 8: Open PR to `main`**

Title:

```text
Add configurable Telegram notification delivery modes
```

PR body summarizes migration, UI, grouped delivery, timeout/transition semantics, and verification results.

- [ ] **Step 9: Verify GitHub Actions on exact PR head SHA**

Do not claim completion until CI for the exact head commit is `completed/success`. If CI fails, add a reproducing test, make the minimal fix, rerun verification, and re-check CI.
