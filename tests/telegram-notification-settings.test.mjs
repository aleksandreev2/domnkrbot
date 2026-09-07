import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function normalized(query) {
  return query.replace(/\s+/g, ' ').trim();
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalized(query);
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    this.db.reads.push({ query: this.query, values: [...this.values] });
    if (this.query.includes('FROM telegram_subscription_settings')) {
      return this.db.globalSettings.get(String(this.values[0])) ?? null;
    }
    if (this.query.includes('FROM telegram_title_delivery_settings')) {
      return this.db.titleSettings.get(`${this.values[0]}:${this.values[1]}`) ?? null;
    }
    if (this.query.includes('FROM telegram_notification_input_state')) {
      return this.db.inputState.get(String(this.values[0])) ?? null;
    }
    return null;
  }
  async run() {
    this.db.writes.push({ query: this.query, values: [...this.values] });
    if (this.query.startsWith('INSERT INTO telegram_subscription_settings')) {
      const [userId, mode, stackSize] = this.values;
      this.db.globalSettings.set(String(userId), { delivery_mode: mode, stack_size: stackSize });
    } else if (this.query.startsWith('INSERT INTO telegram_title_delivery_settings')) {
      const [userId, bookRef, mode, stackSize] = this.values;
      this.db.titleSettings.set(`${userId}:${bookRef}`, { delivery_mode: mode, stack_size: stackSize });
    } else if (this.query.startsWith('DELETE FROM telegram_title_delivery_settings')) {
      this.db.titleSettings.delete(`${this.values[0]}:${this.values[1]}`);
    } else if (this.query.startsWith('INSERT INTO telegram_notification_input_state')) {
      const [userId, scope, bookRef] = this.values;
      this.db.inputState.set(String(userId), { scope, book_ref: bookRef });
    } else if (this.query.startsWith('DELETE FROM telegram_notification_input_state') && this.query.includes('expires_at <=')) {
      // Expiry evaluation belongs to SQLite in production. The mock records this cleanup query.
    } else if (this.query.startsWith('DELETE FROM telegram_notification_input_state')) {
      this.db.inputState.delete(String(this.values[0]));
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.globalSettings = new Map();
    this.titleSettings = new Map();
    this.inputState = new Map();
    this.reads = [];
    this.writes = [];
  }
  prepare(query) { return new Statement(this, query); }
}

function env(db) { return { DB: db }; }

test('normalizes notification delivery settings and validates custom stack boundaries', async () => {
  const settings = await import('../dist-runtime/telegram-notification-settings.js');

  assert.deepEqual(settings.normalizeDeliverySetting('instant', 10), { mode: 'instant', stackSize: null });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 5), { mode: 'stack', stackSize: 5 });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 100), { mode: 'stack', stackSize: 100 });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 1), { mode: 'instant', stackSize: null });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 101), { mode: 'instant', stackSize: null });
  assert.deepEqual(settings.normalizeDeliverySetting('unknown', 10), { mode: 'instant', stackSize: null });

  assert.equal(settings.validateCustomStackSize('2'), 2);
  assert.equal(settings.validateCustomStackSize('100'), 100);
  assert.equal(settings.validateCustomStackSize(37), 37);
  assert.equal(settings.validateCustomStackSize('1'), null);
  assert.equal(settings.validateCustomStackSize('101'), null);
  assert.equal(settings.validateCustomStackSize('2.5'), null);
  assert.equal(settings.validateCustomStackSize('abc'), null);
  assert.equal(settings.validateCustomStackSize(''), null);
});

test('delivery setting labels distinguish instant and stacked modes', async () => {
  const settings = await import('../dist-runtime/telegram-notification-settings.js');

  assert.equal(settings.deliverySettingLabel({ mode: 'instant', stackSize: null }), '⚡ Мгновенно');
  assert.equal(settings.deliverySettingLabel({ mode: 'stack', stackSize: 5 }), '📦 По 5');
  assert.equal(settings.deliverySettingLabel({ mode: 'stack', stackSize: 37 }), '📦 По 37');
});

test('global and title setting helpers preserve inheritance instead of copying the global value', async () => {
  const settings = await import('../dist-runtime/telegram-notification-settings.js');
  const db = new DB();

  assert.deepEqual(await settings.getGlobalDeliverySetting(env(db), '42'), { mode: 'instant', stackSize: null });
  await settings.setGlobalDeliverySetting(env(db), '42', { mode: 'stack', stackSize: 10 });
  assert.deepEqual(await settings.getGlobalDeliverySetting(env(db), '42'), { mode: 'stack', stackSize: 10 });

  assert.deepEqual(
    await settings.getTitleDeliverySetting(env(db), '42', '77--book'),
    { setting: { mode: 'stack', stackSize: 10 }, inherited: true },
  );

  await settings.setTitleDeliverySetting(env(db), '42', '77--book', { mode: 'stack', stackSize: 5 });
  assert.deepEqual(
    await settings.getTitleDeliverySetting(env(db), '42', '77--book'),
    { setting: { mode: 'stack', stackSize: 5 }, inherited: false },
  );

  await settings.setGlobalDeliverySetting(env(db), '42', { mode: 'stack', stackSize: 20 });
  assert.deepEqual(
    await settings.getTitleDeliverySetting(env(db), '42', '77--book'),
    { setting: { mode: 'stack', stackSize: 5 }, inherited: false },
  );

  await settings.clearTitleDeliverySetting(env(db), '42', '77--book');
  assert.deepEqual(
    await settings.getTitleDeliverySetting(env(db), '42', '77--book'),
    { setting: { mode: 'stack', stackSize: 20 }, inherited: true },
  );
});

test('custom stack input state records global or title scope for ten minutes and can be cleared', async () => {
  const settings = await import('../dist-runtime/telegram-notification-settings.js');
  const db = new DB();

  await settings.beginNotificationCustomInput(env(db), '42', { scope: 'global' });
  assert.deepEqual(await settings.getNotificationCustomInput(env(db), '42'), { scope: 'global', bookRef: null });

  await settings.beginNotificationCustomInput(env(db), '42', { scope: 'title', bookRef: '77--book' });
  assert.deepEqual(await settings.getNotificationCustomInput(env(db), '42'), { scope: 'title', bookRef: '77--book' });

  const beginWrites = db.writes.filter((write) => write.query.startsWith('INSERT INTO telegram_notification_input_state'));
  assert.equal(beginWrites.length, 2);
  assert.match(beginWrites[0].query, /datetime\('now','\+10 minutes'\)/i);
  assert.match(db.reads.at(-1).query, /expires_at > CURRENT_TIMESTAMP/i);
  assert.ok(db.writes.some((write) => /DELETE FROM telegram_notification_input_state[\s\S]*expires_at <= CURRENT_TIMESTAMP/i.test(write.query)));

  await settings.clearNotificationCustomInput(env(db), '42');
  assert.equal(await settings.getNotificationCustomInput(env(db), '42'), null);
});

test('migration 0016 is forward-only and owns delivery-mode production schema', () => {
  const migration = readFileSync(new URL('../migrations/0016_telegram_notification_delivery_modes.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE telegram_subscription_settings ADD COLUMN stack_size INTEGER/i);
  assert.match(migration, /CREATE TABLE telegram_title_delivery_settings/i);
  assert.match(migration, /CREATE TABLE telegram_notification_input_state/i);
  assert.match(migration, /delivery_mode\s*=\s*'stack'[\s\S]*stack_size BETWEEN 2 AND 100/i);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|TRIGGER)/i);
});
