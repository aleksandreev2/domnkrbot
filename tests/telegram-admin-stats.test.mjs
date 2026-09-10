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

function message(text, userId = 42) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: userId, type: 'private' },
      from: { id: userId, first_name: 'Admin' },
      text,
    },
  };
}

function callback(data, userId = 42) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-stats-1',
      data,
      from: { id: userId, first_name: 'Admin' },
      message: {
        message_id: 55,
        chat: { id: userId, type: 'private' },
        text: '📊 Статистика бота',
      },
    },
  };
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = String(query).replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async all() { return { results: this.db.resolve(this.query, this.values) }; }
  async first() { return this.db.resolve(this.query, this.values)[0] ?? null; }
}

class StatsDB {
  constructor() { this.batchCalls = 0; }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    this.batchCalls += 1;
    const results = [];
    for (const statement of statements) results.push(await statement.all());
    return results;
  }
  resolve(query) {
    if (/FROM users/i.test(query)) return [{ total: 120, new_24h: 4, new_7d: 22, new_30d: 71 }];
    if (/FROM telegram_subscription_settings/i.test(query) && /title_subscriptions/i.test(query)) {
      return [{ users_enabled: 33, all_titles_users: 6, explicit_subscriptions: 48, instant_users: 20, stack_users: 13, title_overrides: 9 }];
    }
    if (/FROM ranobelib_notification_outbox/i.test(query)) {
      return [{ pending: 5, retry: 2, sent: 310, disabled: 7, sent_24h: 19, sent_7d: 104, due_now: 3, oldest_due_minutes: 42 }];
    }
    if (/FROM chapter_proposals/i.test(query)) {
      return [{ total: 44, new_24h: 2, new_7d: 11, pending: 8, approved: 15, rejected: 9, other: 12, votes: 77 }];
    }
    if (/FROM publications/i.test(query)) {
      return [{ publications: 26, published: 18, deliveries: 240, delivery_errors: 3, unique_readers: 67, reader_events: 510, thanks: 88 }];
    }
    if (/FROM channel_access_state/i.test(query)) {
      return [{ tracked: 100, members: 73, left_users: 12, blacklisted: 9, bans_done: 8, bans_pending: 1, appeals_pending: 2, appeals_approved: 5, appeals_rejected: 1 }];
    }
    if (/FROM ranobelib_releases/i.test(query)) {
      return [{ releases_24h: 8, releases_7d: 45, last_release_at: '2026-09-10 09:30:00', last_sync_at: '2026-09-10 09:32:00', failures: 2, due_scans: 6 }];
    }
    if (/FROM ranobelib_teams/i.test(query) && /teams_published/i.test(query)) {
      return [{
        teams_published: 3, teams_hidden: 2, teams_paused: 1, teams_error: 1, teams_sync_errors: 1, teams_stale: 2,
        branches_native: 50, branches_fallback: 4, branches_ambiguous: 1,
        legacy_effective_users: 33, primary_effective_users: 33, parity_mismatch: 0,
        rollout_shadow: 1, rollout_delivery: 0, rollout_ui: 0,
      }];
    }
    if (/json_group_array/i.test(query) && /FROM ranobelib_titles/i.test(query)) {
      return [{ items: '[]' }];
    }
    if (/FROM ranobelib_titles/i.test(query)) {
      return [{ total: 95, active: 80, completed: 12, unknown_status: 3, snapshot_ready: 91, with_errors: 2, due_now: 4, late_5m: 1, subscribers: 37 }];
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

test('/stats is completely silent for non-admin users', async () => {
  const runtime = await loadRuntime();
  assert.equal(typeof runtime?.handleTelegramAdminStatsWebhook, 'function', 'admin stats runtime must exist');

  const env = {
    DB: { prepare() { throw new Error('non-admin stats must not touch D1'); } },
    TELEGRAM_BOT_TOKEN: 'token',
    ADMIN_TELEGRAM_IDS: '99',
  };

  await captureTelegram(async (calls) => {
    const response = await runtime.handleTelegramAdminStatsWebhook(requestFor(message('/stats', 42)), env);
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0, 'non-admin /stats must not call Telegram at all');
  });
});

test('admin /stats sends a compact overview with navigable detailed sections', async () => {
  const runtime = await loadRuntime();
  assert.equal(typeof runtime?.handleTelegramAdminStatsWebhook, 'function', 'admin stats runtime must exist');
  const db = new StatsDB();
  const env = { DB: db, TELEGRAM_BOT_TOKEN: 'token', ADMIN_TELEGRAM_IDS: '42 99' };

  await captureTelegram(async (calls) => {
    const response = await runtime.handleTelegramAdminStatsWebhook(requestFor(message('/stats')), env);
    assert.ok(response);
    assert.equal(response.status, 200);
    const send = calls.find((call) => call.url.endsWith('/sendMessage'));
    assert.ok(send, 'admin overview must be sent');
    assert.match(send.body.text, /Статистика бота/);
    assert.match(send.body.text, /Пользователи/);
    assert.match(send.body.text, /Переводы/);
    assert.match(send.body.text, /Очередь/);
    assert.match(send.body.text, /Команды:.*3.*published.*2.*hidden.*1.*paused.*1.*error/);
    assert.match(send.body.text, /stale.*2/);
    const callbacks = JSON.stringify(send.body.reply_markup);
    for (const section of ['users', 'subscriptions', 'translations', 'delivery', 'proposals', 'publications', 'access', 'system']) {
      assert.match(callbacks, new RegExp(`stats:${section}`), `missing ${section} stats button`);
    }
    assert.ok(db.batchCalls >= 1, 'stats overview should batch D1 reads');
  });
});

test('admin stats section callback edits the current screen and exposes translation health', async () => {
  const runtime = await loadRuntime();
  assert.equal(typeof runtime?.handleTelegramAdminStatsWebhook, 'function', 'admin stats runtime must exist');
  const db = new StatsDB();
  const env = { DB: db, TELEGRAM_BOT_TOKEN: 'token', ADMIN_TELEGRAM_IDS: '42' };
  const ctx = { waitUntil(promise) { void promise; } };

  await captureTelegram(async (calls) => {
    const response = await runtime.handleTelegramAdminStatsWebhook(requestFor(callback('stats:translations')), env, ctx);
    assert.ok(response);
    const edit = calls.find((call) => call.url.endsWith('/editMessageText'));
    assert.ok(edit, 'section navigation should edit the current stats screen');
    assert.match(edit.body.text, /📚 Переводы/);
    assert.match(edit.body.text, /Активные:\s*<b>80<\/b>/);
    assert.match(edit.body.text, /Завершённые:\s*<b>12<\/b>/);
    assert.match(edit.body.text, /Без статуса:\s*<b>3<\/b>/);
    assert.match(edit.body.text, /С ошибками:\s*<b>2<\/b>/);
    assert.match(edit.body.text, /Ожидают сканирования:\s*<b>4<\/b>/);
    assert.match(edit.body.text, /Задержка &gt;5 мин:\s*<b>1<\/b>/);
    assert.match(JSON.stringify(edit.body.reply_markup), /stats:home/);
    assert.ok(calls.some((call) => call.url.endsWith('/answerCallbackQuery')), 'callback must be acknowledged');
  });
});

test('system stats expose multi-team branch, migration parity and rollout diagnostics', async () => {
  const runtime = await loadRuntime();
  const db = new StatsDB();
  const env = { DB: db, TELEGRAM_BOT_TOKEN: 'token', ADMIN_TELEGRAM_IDS: '42' };

  await captureTelegram(async (calls) => {
    const response = await runtime.handleTelegramAdminStatsWebhook(requestFor(callback('stats:system')), env);
    assert.ok(response);
    const edit = calls.find((call) => call.url.endsWith('/editMessageText'));
    assert.ok(edit);
    assert.match(edit.body.text, /Branch identity:.*native.*50.*fallback.*4.*ambiguous.*1/);
    assert.match(edit.body.text, /Migration parity:.*legacy.*33.*primary.*33.*mismatch.*0/);
    assert.match(edit.body.text, /Rollout:.*shadow.*ON.*delivery.*OFF.*UI.*OFF/);
  });
});
