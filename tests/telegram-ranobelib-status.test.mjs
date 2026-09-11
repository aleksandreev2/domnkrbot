import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTelegramWebhookUpdate } from '../dist-runtime/telegram-webhook-routing.js';
import { handleTelegramRanobeLibAuthWebhook } from '../dist-runtime/telegram-ranobelib-auth.js';

function update(text, userId = 42) {
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

class Statement {
  constructor(db, sql) { this.db = db; this.sql = String(sql).replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.db.first(this.sql, this.values); }
  async all() { return { results: this.db.all(this.sql, this.values) }; }
  async run() { return { success: true }; }
}

class StatusDb {
  constructor() { this.calls = []; }
  prepare(sql) { const statement = new Statement(this, sql); this.calls.push(statement); return statement; }
  first(sql) {
    if (/FROM ranobelib_auth_credentials/i.test(sql)) return null;
    if (/FROM ranobelib_titles/i.test(sql) && /WHERE book_ref=\?/i.test(sql)) return {
      book_ref: '247881--test-book', ranobelib_id: 247881, title: 'Тестовый тайтл', chapter_count: 123,
      latest_volume: '4', latest_number: '123', latest_name: 'Финал',
      last_synced_at: '2026-09-11 18:00:00', next_check_at: '2026-09-11 18:05:00',
      sync_error: null, consecutive_failures: 0,
    };
    if (/FROM ranobelib_releases/i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) return {
      release_kind: 'chapters', chapter_count: 2, first_volume: '4', first_number: '122',
      last_volume: '4', last_number: '123', summary: '122–123', created_at: '2026-09-11 17:59:00',
    };
    if (/FROM ranobelib_notification_outbox/i.test(sql)) return {
      pending: 2, retry: 1, sent: 90, disabled: 3, due_unleased: 1, leased: 1,
    };
    return null;
  }
  all(sql) {
    if (/FROM ranobelib_team_translations/i.test(sql)) return [{
      display_name: 'Дом Некроманта', ranobelib_team_id: 11969, lifecycle_state: 'published',
      presence_state: 'active', semantic_status: 'active', baseline_ready: 1,
      notification_subscriber_count: 14, last_synced_at: '2026-09-11 18:00:00', sync_error: null,
    }];
    return [];
  }
}

async function capture(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ ok: true, result: { message_id: 99 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('router sends /ranobelib_status with and without args to RanobeLib admin handler', () => {
  assert.equal(classifyTelegramWebhookUpdate(update('/ranobelib_status 247881')), 'ranobelib-auth');
  assert.equal(classifyTelegramWebhookUpdate(update('/ranobelib_status')), 'ranobelib-auth');
});

test('/ranobelib_status renders operational title diagnostics without credentials', async () => {
  const db = new StatusDb();
  const env = {
    DB: db,
    ADMIN_TELEGRAM_IDS: '42',
    TELEGRAM_BOT_TOKEN: '123456:telegram-secret-that-must-not-appear',
    RANOBELIB_TOKEN_ENCRYPTION_KEY: 'dedicated-secret-that-must-not-appear',
  };
  const request = new Request('https://example.test/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update('/ranobelib_status 247881')),
  });

  await capture(async (calls) => {
    const response = await handleTelegramRanobeLibAuthWebhook(request, env);
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.url.endsWith('/sendMessage'));
    assert.ok(send);
    const text = send.body.text;
    assert.match(text, /Тестовый тайтл/);
    assert.match(text, /Последняя известная глава:.*т\.4 гл\.123.*Финал/);
    assert.match(text, /Health:.*missing/);
    assert.match(text, /Дом Некроманта.*published\/active\/active.*baseline.*ready.*demand.*14/);
    assert.match(text, /Следующая проверка/);
    assert.match(text, /Последний release/);
    assert.match(text, /pending.*2.*retry.*1.*sent.*90.*disabled.*3/);
    assert.match(text, /due без lease.*1.*active lease.*1/);
    assert.doesNotMatch(text, /telegram-secret-that-must-not-appear|dedicated-secret-that-must-not-appear|access_token|refresh_token/i);
  });
});

test('/ranobelib_status is silent for non-admin users', async () => {
  const env = {
    DB: { prepare() { throw new Error('non-admin must not touch D1'); } },
    ADMIN_TELEGRAM_IDS: '99', TELEGRAM_BOT_TOKEN: 'token', RANOBELIB_TOKEN_ENCRYPTION_KEY: 'key',
  };
  const request = new Request('https://example.test/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update('/ranobelib_status 247881', 42)),
  });
  await capture(async (calls) => {
    const response = await handleTelegramRanobeLibAuthWebhook(request, env);
    assert.equal(response?.status, 200);
    assert.equal(calls.length, 0);
  });
});
