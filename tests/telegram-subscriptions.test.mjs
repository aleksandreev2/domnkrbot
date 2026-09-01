import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubscriptionMenu,
  deliverPendingReleaseNotifications,
  enqueueReleaseNotifications,
  formatReleaseNotification,
  handleTelegramSubscriptionUpdate,
  parseSubscriptionCallback,
} from '../dist-runtime/telegram-subscriptions.js';

const normalize = (query) => query.replace(/\s+/g, ' ').trim();

class MockStatement {
  constructor(db, query) { this.db = db; this.query = normalize(query); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) {
      const value = this.db.settings.get(String(this.values[0]));
      return value === undefined ? null : { all_titles: value };
    }
    if (this.query.includes('SELECT book_ref FROM ranobelib_titles WHERE ranobelib_id = ?')) {
      const row = this.db.titles.find((title) => title.ranobelib_id === Number(this.values[0]) && title.is_active === 1);
      return row ? { book_ref: row.book_ref } : null;
    }
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) {
      return this.db.subscriptions.has(`${this.values[0]}:${this.values[1]}`) ? { subscribed: 1 } : null;
    }
    return null;
  }
  async all() {
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('snapshot_ready = 1')) {
      return { results: this.db.titles.filter((title) => title.is_active === 1 && title.snapshot_ready === 1)
        .map(({ ranobelib_id, book_ref, title }) => ({ ranobelib_id, book_ref, title })) };
    }
    if (this.query.includes('FROM title_subscriptions s JOIN ranobelib_titles t')) {
      const user = String(this.values[0]);
      const results = this.db.titles.filter((title) => this.db.subscriptions.has(`${user}:${title.book_ref}`))
        .map((title) => ({ ranobelib_id: title.ranobelib_id }));
      return { results };
    }
    if (this.query.includes('SELECT user_telegram_id FROM telegram_subscription_settings WHERE all_titles = 1')) {
      return { results: [...this.db.settings.entries()].filter(([, all]) => all === 1).map(([user_telegram_id]) => ({ user_telegram_id })) };
    }
    if (this.query.includes('SELECT user_telegram_id FROM title_subscriptions WHERE book_ref = ?')) {
      const bookRef = String(this.values[0]);
      const results = [...this.db.subscriptions].filter((key) => key.endsWith(`:${bookRef}`))
        .map((key) => ({ user_telegram_id: key.split(':', 1)[0] }));
      return { results };
    }
    if (this.query.includes('FROM ranobelib_notification_outbox o') && this.query.includes("o.status IN ('pending','retry')")) {
      const limit = Number(this.values[0] ?? 40);
      const results = [];
      for (const row of this.db.outbox.values()) {
        if (!['pending', 'retry'].includes(row.status)) continue;
        const release = this.db.releases.get(row.release_id);
        const title = release ? this.db.titles.find((item) => item.book_ref === release.book_ref) : null;
        if (!release || !title) continue;
        results.push({
          ...row,
          title: title.title,
          url: title.url,
          chapter_count: release.chapter_count,
          first_number: release.first_number,
          last_number: release.last_number,
          summary: release.summary,
        });
      }
      return { results: results.slice(0, limit) };
    }
    return { results: [] };
  }
  async run() {
    if (this.query.startsWith('CREATE TABLE') || this.query.startsWith('CREATE INDEX')) return { meta: { changes: 0 } };
    if (this.query.startsWith('INSERT INTO users')) {
      this.db.users.add(String(this.values[0])); return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscriptions')) {
      const key = `${this.values[0]}:${this.values[1]}`;
      const before = this.db.subscriptions.size; this.db.subscriptions.add(key);
      return { meta: { changes: this.db.subscriptions.size - before } };
    }
    if (this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ? AND book_ref = ?')) {
      return { meta: { changes: this.db.subscriptions.delete(`${this.values[0]}:${this.values[1]}`) ? 1 : 0 } };
    }
    if (this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ?')) {
      let changes = 0; const prefix = `${this.values[0]}:`;
      for (const key of [...this.db.subscriptions]) if (key.startsWith(prefix)) { this.db.subscriptions.delete(key); changes += 1; }
      return { meta: { changes } };
    }
    if (this.query.startsWith('INSERT INTO telegram_subscription_settings')) {
      this.db.settings.set(String(this.values[0]), Number(this.values[1])); return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO ranobelib_notification_outbox')) {
      const [releaseId, userId] = this.values.map(String); const key = `${releaseId}:${userId}`;
      if (this.db.outbox.has(key)) return { meta: { changes: 0 } };
      this.db.outbox.set(key, { release_id: releaseId, user_telegram_id: userId, status: 'pending', attempts: 0 });
      return { meta: { changes: 1 } };
    }
    if (this.query.includes("UPDATE ranobelib_notification_outbox SET status='sent'")) {
      const [releaseId, userId] = this.values.map(String); const row = this.db.outbox.get(`${releaseId}:${userId}`);
      if (row) { row.status = 'sent'; row.attempts += 1; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.query.includes("UPDATE ranobelib_notification_outbox SET status='disabled'")) {
      const [error, releaseId, userId] = this.values; const row = this.db.outbox.get(`${releaseId}:${userId}`);
      if (row) { row.status = 'disabled'; row.last_error = String(error); row.attempts += 1; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (this.query.includes("UPDATE ranobelib_notification_outbox SET status='retry'")) {
      const [error, releaseId, userId] = this.values; const row = this.db.outbox.get(`${releaseId}:${userId}`);
      if (row) { row.status = 'retry'; row.last_error = String(error); row.attempts += 1; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    return { meta: { changes: 0 } };
  }
}

class MockDB {
  constructor() {
    this.titles = [];
    this.users = new Set();
    this.settings = new Map();
    this.subscriptions = new Set();
    this.releases = new Map();
    this.outbox = new Map();
  }
  prepare(query) { return new MockStatement(this, query); }
}

function env(db) { return { DB: db, TELEGRAM_BOT_TOKEN: 'unit-test-token', BOT_USERNAME: 'domnekromanta_bot' }; }

async function withTelegram(fn, responder = () => ({ ok: true, result: { message_id: 1 } })) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = String(url).split('/').pop(); const payload = JSON.parse(String(options.body || '{}'));
    calls.push({ method, payload });
    const result = responder(method, payload);
    return new Response(JSON.stringify(result), { status: result.ok === false ? (result.error_code || 500) : 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('builds a paginated Telegram title list directly from synchronized RanobeLib titles', () => {
  const titles = Array.from({ length: 10 }, (_, index) => ({ ranobelib_id: 1000 + index, book_ref: `${1000 + index}--book-${index + 1}`, title: `Книга ${index + 1}` }));
  const menu = buildSubscriptionMenu(titles, { page: 0, pageSize: 8, subscribedIds: new Set([1001]), allTitles: false });
  assert.match(menu.text, /Выберите тайтл/);
  assert.equal(menu.reply_markup.inline_keyboard.length, 12);
  assert.deepEqual(menu.reply_markup.inline_keyboard[0], [{ text: '📖 Книга 1', callback_data: 'subs:title:1000:0' }]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[1], [{ text: '✅ Книга 2', callback_data: 'subs:title:1001:0' }]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[8], [{ text: '1 / 2', callback_data: 'subs:noop' }, { text: '▶️', callback_data: 'subs:list:1' }]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[11], [{ text: '⚙️ Настройки уведомлений', callback_data: 'subs:center' }]);
});

test('parses compact callback data without putting long RanobeLib refs into Telegram callbacks', () => {
  assert.deepEqual(parseSubscriptionCallback('subs:title:271368:4'), { kind: 'title', titleId: 271368, page: 4 });
  assert.deepEqual(parseSubscriptionCallback('subs:list:2'), { kind: 'list', page: 2 });
  assert.deepEqual(parseSubscriptionCallback('subs:all:on'), { kind: 'all', mode: 'on' });
  assert.equal(parseSubscriptionCallback('subs:title:not-a-number:0'), null);
});

test('formats one direct-message notification for a detected team release', () => {
  const notification = formatReleaseNotification({ title: 'Хулиганки захватили мой дом', url: 'https://ranobelib.me/ru/book/123--bully-house', chapterCount: 2, firstNumber: '51', lastNumber: '52', summary: 'Chapters 51–52' });
  assert.match(notification.text, /Новые главы!/);
  assert.match(notification.text, /51–52/);
  assert.deepEqual(notification.reply_markup.inline_keyboard, [[{ text: '📖 Читать на RanobeLib', url: 'https://ranobelib.me/ru/book/123--bully-house' }]]);
});

test('Telegram callback subscribes a user to a synchronized title and redraws the list', async () => {
  const db = new MockDB();
  db.titles.push(
    { ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one', is_active: 1, snapshot_ready: 1 },
    { ranobelib_id: 1001, book_ref: '1001--two', title: 'Книга 2', url: 'https://ranobelib.me/ru/book/1001--two', is_active: 1, snapshot_ready: 1 },
  );
  const update = { callback_query: { id: 'cb-1', from: { id: 42, first_name: 'Reader' }, data: 'subs:title:1000:0', message: { message_id: 7, chat: { id: 42, type: 'private' } } } };

  await withTelegram(async (calls) => {
    assert.equal(await handleTelegramSubscriptionUpdate(update, env(db)), true);
    assert.ok(db.subscriptions.has('42:1000--one'));
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.reply_markup.inline_keyboard[0][0].text, /^✅/);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery'));
  });
});

test('one detected release is enqueued once for all-mode and per-title subscribers then delivered once', async () => {
  const db = new MockDB();
  db.titles.push({ ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one', is_active: 1, snapshot_ready: 1 });
  db.settings.set('42', 1);
  db.subscriptions.add('43:1000--one');
  db.releases.set('release-1', { book_ref: '1000--one', chapter_count: 1, first_number: '8', last_number: '8', summary: 'Chapter 8' });

  assert.equal(await enqueueReleaseNotifications(env(db), 'release-1', '1000--one'), 2);
  assert.equal(await enqueueReleaseNotifications(env(db), 'release-1', '1000--one'), 0);

  await withTelegram(async (calls) => {
    const result = await deliverPendingReleaseNotifications(env(db), 20);
    assert.deepEqual(result, { sent: 2, retried: 0, disabled: 0 });
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 2);
    assert.equal([...db.outbox.values()].every((row) => row.status === 'sent'), true);
    const second = await deliverPendingReleaseNotifications(env(db), 20);
    assert.deepEqual(second, { sent: 0, retried: 0, disabled: 0 });
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 2);
  });
});