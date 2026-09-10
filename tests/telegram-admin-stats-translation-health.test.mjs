import assert from 'node:assert/strict';
import test from 'node:test';

async function loadRuntime() {
  return import('../dist-runtime/telegram-admin-stats.js').catch(() => null);
}

function requestFor(update) {
  return new Request('https://example.test/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
}

function callback(data) {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb-health',
      data,
      from: { id: 42 },
      message: { message_id: 55, chat: { id: 42, type: 'private' } },
    },
  };
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = String(query).replace(/\s+/g, ' ').trim();
  }
  bind() { return this; }
  async all() { return { results: this.db.resolve(this.query) }; }
  async first() { return this.db.resolve(this.query)[0] ?? null; }
}

class StatsDB {
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.all());
    return results;
  }
  resolve(query) {
    if (/FROM users/i.test(query)) return [{ total: 1, new_24h: 0, new_7d: 0, new_30d: 0 }];
    if (/FROM telegram_subscription_settings/i.test(query) && /title_subscriptions/i.test(query)) return [{}];
    if (/FROM ranobelib_notification_outbox/i.test(query)) return [{}];
    if (/FROM chapter_proposals/i.test(query)) return [{}];
    if (/FROM publications/i.test(query)) return [{}];
    if (/FROM channel_access_state/i.test(query)) return [{}];
    if (/FROM ranobelib_releases/i.test(query)) return [{}];
    if (/json_group_array/i.test(query) && /ranobelib_titles/i.test(query)) {
      return [{ items: JSON.stringify([
        {
          book_ref: '62387--pokemon-master-of-tactics',
          title: 'Покемон: Мастер тактики',
          unknown: 1,
          has_error: 0,
          sync_error: null,
          failures: 0,
          delay_minutes: 0,
        },
        {
          book_ref: '999--broken-title',
          title: '<Проблемная & новелла>',
          unknown: 0,
          has_error: 1,
          sync_error: 'RanobeLib request failed: 500 <upstream>',
          failures: 3,
          delay_minutes: 9,
        },
      ]) }];
    }
    if (/FROM ranobelib_titles/i.test(query)) {
      return [{
        total: 40,
        active: 24,
        completed: 15,
        unknown_status: 1,
        snapshot_ready: 40,
        with_errors: 1,
        due_now: 6,
        late_5m: 1,
        subscribers: 29,
      }];
    }
    return [{}];
  }
}

async function captureTelegram(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('translation stats distinguish due scans from genuine delay and name problem titles', async () => {
  const runtime = await loadRuntime();
  assert.equal(typeof runtime?.handleTelegramAdminStatsWebhook, 'function');
  const env = { DB: new StatsDB(), TELEGRAM_BOT_TOKEN: 'token', ADMIN_TELEGRAM_IDS: '42' };

  await captureTelegram(async (calls) => {
    const response = await runtime.handleTelegramAdminStatsWebhook(requestFor(callback('stats:translations')), env);
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.url.endsWith('/editMessageText'));
    assert.ok(edit);
    assert.match(edit.body.text, /Ожидают сканирования:\s*<b>6<\/b>/);
    assert.match(edit.body.text, /Задержка &gt;5 мин:\s*<b>1<\/b>/);
    assert.doesNotMatch(edit.body.text, /Просрочены:/);
    assert.match(edit.body.text, /Проблемные тайтлы/);
    assert.match(edit.body.text, /Покемон: Мастер тактики/);
    assert.match(edit.body.text, /без статуса/);
    assert.match(edit.body.text, /Проблемная &amp; новелла/);
    assert.match(edit.body.text, /ошибка ×3/);
    assert.match(edit.body.text, /задержка 9 мин/);
    assert.match(edit.body.text, /RanobeLib request failed: 500 &lt;upstream&gt;/);
  });
});
