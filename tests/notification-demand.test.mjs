import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadDemand() {
  return import('../dist-runtime/notification-demand.js');
}

class CaptureStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
    db.calls.push(this);
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/RETURNING\s+notification_subscriber_count/i.test(this.query)) {
      return { notification_subscriber_count: this.db.nextCount };
    }
    return null;
  }
  async all() { return { results: [] }; }
  async run() { return { meta: { changes: 1 } }; }
}

class CaptureDB {
  constructor(nextCount = 0) { this.nextCount = nextCount; this.calls = []; }
  prepare(query) { return new CaptureStatement(this, query); }
}

test('title demand uses effective all-title/exclusion/explicit semantics and excludes blocked users', async () => {
  const demand = await loadDemand();
  const db = new CaptureDB(3);
  const count = await demand.refreshTitleNotificationDemand({ DB: db }, '77--fast-book');

  assert.equal(count, 3);
  assert.equal(db.calls.length, 1, 'title demand refresh should be one atomic statement');
  const call = db.calls[0];
  assert.match(call.query, /telegram_subscription_settings/i);
  assert.match(call.query, /all_titles\s*=\s*1/i);
  assert.match(call.query, /title_subscription_exclusions/i);
  assert.match(call.query, /title_subscriptions/i);
  assert.match(call.query, /telegram_delivery_reachability/i);
  assert.match(call.query, /blocked/i);
  assert.match(call.query, /UNION/i);
  assert.ok(call.values.filter((value) => value === '77--fast-book').length >= 2);
});

test('demand transition SQL wakes 0→positive titles and idles positive→0 titles for 180 minutes', async () => {
  const demand = await loadDemand();
  const db = new CaptureDB(1);
  await demand.refreshTitleNotificationDemand({ DB: db }, '88--wake-me');

  const query = db.calls[0].query;
  assert.match(query, /notification_subscriber_count\s*=\s*0[\s\S]*CURRENT_TIMESTAMP/i);
  assert.match(query, /notification_subscriber_count\s*>\s*0[\s\S]*180\s+minutes/i);
  assert.match(query, /scan_priority[\s\S]*\+\s*10/i);
  assert.match(query, /subscriber_count_updated_at\s*=\s*CURRENT_TIMESTAMP/i);
});

test('full demand refresh is bounded to active titles and applies the same reachability semantics', async () => {
  const demand = await loadDemand();
  const db = new CaptureDB();
  await demand.refreshAllNotificationDemand({ DB: db });

  assert.equal(db.calls.length, 1);
  const query = db.calls[0].query;
  assert.match(query, /UPDATE\s+ranobelib_titles/i);
  assert.match(query, /WHERE\s+is_active\s*=\s*1/i);
  assert.match(query, /telegram_delivery_reachability/i);
  assert.match(query, /title_subscription_exclusions/i);
  assert.match(query, /title_subscriptions/i);
  assert.match(query, /180\s+minutes/i);
});

test('reachability helpers persist blocked and active states without changing subscription rows', async () => {
  const demand = await loadDemand();
  const db = new CaptureDB();

  await demand.markTelegramUserBlocked({ DB: db }, '123');
  await demand.markTelegramUserReachable({ DB: db }, '123');

  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].query, /INSERT\s+INTO\s+telegram_delivery_reachability/i);
  assert.match(db.calls[0].query, /blocked/i);
  assert.match(db.calls[0].query, /blocked_at/i);
  assert.deepEqual(db.calls[0].values, ['123']);
  assert.match(db.calls[1].query, /INSERT\s+INTO\s+telegram_delivery_reachability/i);
  assert.match(db.calls[1].query, /active/i);
  assert.match(db.calls[1].query, /last_success_at/i);
  assert.deepEqual(db.calls[1].values, ['123']);
  for (const call of db.calls) {
    assert.doesNotMatch(call.query, /DELETE\s+FROM\s+title_subscriptions/i);
    assert.doesNotMatch(call.query, /UPDATE\s+telegram_subscription_settings/i);
  }
});

test('migration 0015 is forward-only, adds demand/reachability state, and initializes effective demand', () => {
  const sql = readFileSync(new URL('../migrations/0015_paid_backend_demand_aware.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN notification_subscriber_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ADD COLUMN subscriber_count_updated_at TEXT/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_delivery_reachability/i);
  assert.match(sql, /CHECK\s*\(\s*state\s+IN\s*\(\s*'active'\s*,\s*'blocked'\s*\)\s*\)/i);
  assert.match(sql, /title_subscription_exclusions/i);
  assert.match(sql, /title_subscriptions/i);
  assert.match(sql, /telegram_subscription_settings/i);
  assert.match(sql, /telegram_delivery_reachability/i);
  assert.match(sql, /UPDATE ranobelib_titles/i);
  assert.match(sql, /subscriber_count_updated_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|TRIGGER)/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+(users|ranobelib_titles|title_subscriptions|telegram_subscription_settings)/i);
});
