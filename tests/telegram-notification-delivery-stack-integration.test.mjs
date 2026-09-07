import assert from 'node:assert/strict';
import test from 'node:test';

async function loadDelivery() {
  return import('../dist-runtime/telegram-notification-delivery.js');
}

const NOW = Date.parse('2026-09-08T12:00:00Z');

function row(userId, overrides = {}) {
  return {
    release_id: `release-${userId}-1`,
    user_telegram_id: String(userId),
    status: 'pending',
    attempts: 0,
    available_at: '2026-09-08 08:00:00',
    created_at: '2026-09-08 08:00:00',
    claim_token: null,
    claim_expires_at: null,
    book_ref: '77--fast-book',
    ranobelib_id: 77,
    title: 'Fast Book',
    url: 'https://ranobelib.me/ru/book/77--fast-book',
    chapter_count: 1,
    first_volume: '1',
    first_number: '1',
    last_volume: '1',
    last_number: '1',
    summary: 'Chapter 1',
    eligible: 1,
    ...overrides,
  };
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() { return null; }
  async all() {
    if (/WITH notification_groups AS/i.test(this.query)) {
      this.db.readyGroupSelects.push(this.query);
      const limit = Number(this.values.at(-1)) || 20;
      return { results: this.db.readyGroups().slice(0, limit) };
    }
    if (/FROM ranobelib_notification_outbox o/i.test(this.query) && /o\.claim_token\s*=\s*\?/i.test(this.query)) {
      const token = String(this.values[0]);
      return { results: this.db.rows.filter((item) => item.claim_token === token) };
    }
    // Old row-oriented worker compatibility: leave the old select empty so these tests fail
    // on the missing grouped claim/send semantics rather than on mock implementation details.
    if (/FROM ranobelib_notification_outbox o/i.test(this.query)) return { results: [] };
    return { results: [] };
  }
  async run() {
    this.db.queries.push({ query: this.query, values: [...this.values] });
    if (/UPDATE ranobelib_notification_outbox/i.test(this.query) && /SET claim_token\s*=\s*\?/i.test(this.query) && /json_each/i.test(this.query)) {
      const token = String(this.values[0]);
      const keys = JSON.parse(String(this.values[1] || '[]'));
      const wanted = new Set(keys.map((key) => `${key.userTelegramId}\u0000${key.bookRef}`));
      const claimed = [];
      for (const item of this.db.rows) {
        const key = `${item.user_telegram_id}\u0000${item.book_ref}`;
        if (!wanted.has(key)) continue;
        if (item.status !== 'pending' && item.status !== 'retry') continue;
        if (item.claim_token) continue;
        if (Date.parse(item.available_at.replace(' ', 'T') + 'Z') > NOW) continue;
        item.claim_token = token;
        item.claim_expires_at = '2026-09-08 12:10:00';
        claimed.push(item);
      }
      return { results: claimed.map((item) => ({ release_id: item.release_id, user_telegram_id: item.user_telegram_id })), meta: { changes: claimed.length } };
    }
    if (/UPDATE ranobelib_notification_outbox/i.test(this.query) && /status='sent'/i.test(this.query)) {
      this.db.applyGroupStatus(this.values, 'sent');
    } else if (/UPDATE ranobelib_notification_outbox/i.test(this.query) && /status='disabled'/i.test(this.query)) {
      this.db.applyGroupStatus(this.values, 'disabled');
    } else if (/UPDATE ranobelib_notification_outbox/i.test(this.query) && /status='retry'/i.test(this.query)) {
      this.db.applyGroupStatus(this.values, 'retry');
    } else if (/DELETE FROM ranobelib_notification_outbox/i.test(this.query)) {
      this.db.deleteClaimedGroup(this.values);
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor(rows, options = {}) {
    this.rows = rows.map((item) => ({ ...item }));
    this.global = options.global ?? { mode: 'instant', stackSize: null };
    this.titleSettings = new Map(Object.entries(options.titleSettings ?? {}));
    this.readyGroupSelects = [];
    this.queries = [];
  }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    const output = [];
    for (const statement of statements) output.push(await statement.run());
    return output;
  }
  readyGroups() {
    const groups = new Map();
    for (const item of this.rows) {
      if (item.status !== 'pending' && item.status !== 'retry') continue;
      const key = `${item.user_telegram_id}\u0000${item.book_ref}`;
      const group = groups.get(key) ?? {
        user_telegram_id: item.user_telegram_id,
        book_ref: item.book_ref,
        eligible: Number(item.eligible ?? 1),
        pending_chapters: 0,
        oldest_pending_at: item.created_at,
        retry_blocked: 0,
        live_claimed: 0,
      };
      group.pending_chapters += Number(item.chapter_count) || 1;
      if (String(item.created_at) < String(group.oldest_pending_at)) group.oldest_pending_at = item.created_at;
      if (item.status === 'retry' && Date.parse(item.available_at.replace(' ', 'T') + 'Z') > NOW) group.retry_blocked = 1;
      if (item.claim_token && item.claim_expires_at && Date.parse(item.claim_expires_at.replace(' ', 'T') + 'Z') > NOW) group.live_claimed = 1;
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => {
      if (group.live_claimed) return false;
      if (!group.eligible) return true;
      if (group.retry_blocked) return false;
      const override = this.titleSettings.get(`${group.user_telegram_id}:${group.book_ref}`);
      const setting = override ?? this.global;
      if (setting.mode !== 'stack' || !Number.isInteger(setting.stackSize) || setting.stackSize < 2 || setting.stackSize > 100) return true;
      if (group.pending_chapters >= setting.stackSize) return true;
      return NOW - Date.parse(group.oldest_pending_at.replace(' ', 'T') + 'Z') >= 7 * 24 * 60 * 60 * 1000;
    });
  }
  applyGroupStatus(values, status) {
    const claimToken = String(values.at(-1));
    for (const item of this.rows) {
      if (item.claim_token !== claimToken) continue;
      item.status = status;
      item.claim_token = null;
      item.claim_expires_at = null;
    }
  }
  deleteClaimedGroup(values) {
    const claimToken = String(values.at(-1));
    this.rows = this.rows.filter((item) => item.claim_token !== claimToken);
  }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function telegramOk() {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    headers: { 'content-type': 'application/json' },
  });
}

test('stack below threshold stays pending and does not call Telegram', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const db = new DB([
    row('100', { release_id: 'r1', chapter_count: 4, first_number: '1', last_number: '4' }),
  ], { global: { mode: 'stack', stackSize: 5 } });
  let sends = 0;
  const result = await withFetch(async () => { sends += 1; return telegramOk(); }, () =>
    drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));

  assert.equal(sends, 0);
  assert.equal(result.claimed, 0);
  assert.equal(result.hasMoreDue, false);
  assert.equal(db.rows[0].status, 'pending');
  assert.ok(db.readyGroupSelects.length >= 1);
});

test('2+3 at stack five is claimed as one group and sent once', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const db = new DB([
    row('100', { release_id: 'r1', chapter_count: 2, first_number: '1', last_number: '2' }),
    row('100', { release_id: 'r2', chapter_count: 3, first_number: '3', last_number: '5', created_at: '2026-09-08 09:00:00' }),
  ], { global: { mode: 'stack', stackSize: 5 } });
  const payloads = [];
  const result = await withFetch(async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return telegramOk();
  }, () => drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));

  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /5/);
  assert.deepEqual(db.rows.map((item) => item.status), ['sent', 'sent']);
});

test('8+5 at stack ten sends all thirteen with no threshold remainder', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const db = new DB([
    row('100', { release_id: 'r1', chapter_count: 8, first_number: '1', last_number: '8' }),
    row('100', { release_id: 'r2', chapter_count: 5, first_number: '9', last_number: '13', created_at: '2026-09-08 09:00:00' }),
  ], { global: { mode: 'stack', stackSize: 10 } });
  const payloads = [];
  await withFetch(async (_url, init) => { payloads.push(JSON.parse(init.body)); return telegramOk(); }, () =>
    drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));

  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /13/);
  assert.deepEqual(db.rows.map((item) => item.status), ['sent', 'sent']);
});

test('seven-day timeout flushes a partial stack while future retry blocks newer rows', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const expired = new DB([
    row('100', { release_id: 'old', chapter_count: 3, created_at: '2026-09-01 12:00:00', first_number: '1', last_number: '3' }),
  ], { global: { mode: 'stack', stackSize: 10 } });
  let expiredSends = 0;
  await withFetch(async () => { expiredSends += 1; return telegramOk(); }, () =>
    drainNotificationOutbox({ DB: expired, TELEGRAM_BOT_TOKEN: 'token' }));
  assert.equal(expiredSends, 1);

  const blocked = new DB([
    row('200', { release_id: 'retry', status: 'retry', available_at: '2026-09-08 13:00:00', created_at: '2026-09-01 10:00:00' }),
    row('200', { release_id: 'new', chapter_count: 9, created_at: '2026-09-08 11:00:00' }),
  ], { global: { mode: 'stack', stackSize: 5 } });
  let blockedSends = 0;
  const result = await withFetch(async () => { blockedSends += 1; return telegramOk(); }, () =>
    drainNotificationOutbox({ DB: blocked, TELEGRAM_BOT_TOKEN: 'token' }));
  assert.equal(blockedSends, 0);
  assert.equal(result.claimed, 0);
});
