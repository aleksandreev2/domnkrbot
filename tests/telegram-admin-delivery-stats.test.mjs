import assert from 'node:assert/strict';
import test from 'node:test';

async function loadRuntime() {
  return import('../dist-runtime/telegram-admin-stats.js');
}

function callback(data, userId = 42) {
  return {
    update_id: 3,
    callback_query: {
      id: 'cb-delivery-stats',
      data,
      from: { id: userId, first_name: 'Admin' },
      message: {
        message_id: 77,
        chat: { id: userId, type: 'private' },
        text: '📊 Статистика бота',
      },
    },
  };
}

class DeliveryStatsDB {
  constructor() { this.queries = []; }
  prepare(query) {
    this.queries.push(String(query).replace(/\s+/g, ' ').trim());
    return { bind() { return this; } };
  }
  async batch() {
    const row = (value) => ({ results: [value] });
    return [
      row({ total: 1, new_24h: 0, new_7d: 0, new_30d: 0 }),
      row({ users_enabled: 1, legacy_users_enabled: 1, all_titles_users: 1, explicit_subscriptions: 0, instant_users: 1, stack_users: 0, title_overrides: 0 }),
      row({ total: 1, active: 1, completed: 0, archived: 0, unknown_status: 0, snapshot_ready: 1, with_errors: 0, due_now: 0, late_5m: 0, subscribers: 1 }),
      row({
        pending: 9,
        retry: 4,
        sent: 100,
        disabled: 2,
        sent_24h: 8,
        sent_7d: 50,
        ready_now: 2,
        coalescing: 3,
        stack_waiting: 4,
        retry_blocked: 5,
        in_lease: 6,
        stale_ineligible: 7,
        oldest_ready_minutes: 65,
      }),
      row({ total: 0, new_24h: 0, new_7d: 0, pending: 0, approved: 0, rejected: 0, other: 0, votes: 0 }),
      row({ publications: 0, published: 0, deliveries: 0, delivery_errors: 0, unique_readers: 0, reader_events: 0, thanks: 0 }),
      row({ tracked: 0, members: 0, left_users: 0, blacklisted: 0, bans_done: 0, bans_pending: 0, appeals_pending: 0, appeals_approved: 0, appeals_rejected: 0 }),
      row({ releases_24h: 0, releases_7d: 0, last_release_at: null, last_sync_at: null, failures: 0, due_scans: 0 }),
      row({ items: '[]' }),
      row({ teams_published: 1, teams_hidden: 0, teams_paused: 0, teams_error: 0, teams_sync_errors: 0, teams_stale: 0, branches_native: 1, branches_fallback: 0, branches_ambiguous: 0, primary_effective_users: 1, rollout_shadow: 1, rollout_delivery: 1, rollout_ui: 1 }),
    ];
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

test('/stats delivery separates truly ready, coalescing, stack, retry, lease and stale groups', async () => {
  const runtime = await loadRuntime();
  const db = new DeliveryStatsDB();
  const env = { DB: db, TELEGRAM_BOT_TOKEN: 'token', ADMIN_TELEGRAM_IDS: '42' };
  const request = new Request('https://example.test/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(callback('stats:delivery')),
  });

  await captureTelegram(async (calls) => {
    const response = await runtime.handleTelegramAdminStatsWebhook(request, env);
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.url.endsWith('/editMessageText'));
    assert.ok(edit, 'delivery section must edit the current stats screen');
    assert.match(edit.body.text, /Готовы прямо сейчас:\s*<b>2<\/b>/);
    assert.match(edit.body.text, /Ждут coalescing:\s*<b>3<\/b>/);
    assert.match(edit.body.text, /Ждут размер стака:\s*<b>4<\/b>/);
    assert.match(edit.body.text, /Retry заблокирован до available_at:\s*<b>5<\/b>/);
    assert.match(edit.body.text, /Удерживаются lease:\s*<b>6<\/b>/);
    assert.match(edit.body.text, /Устарели \/ подписка больше не подходит:\s*<b>7<\/b>/);
    assert.match(edit.body.text, /Возраст старейшей реально готовой: 1 ч 5 мин/);
  });

  const deliveryQuery = db.queries.find((query) => query.includes("delivery_bucket='ready_now'"));
  assert.ok(deliveryQuery, 'stats must use the delivery-state classification query');
  assert.match(deliveryQuery, /claim_expires_at>CURRENT_TIMESTAMP/);
  assert.match(deliveryQuery, /status='retry' AND c\.available_at>CURRENT_TIMESTAMP/);
  assert.match(deliveryQuery, /team\.lifecycle_state='published'/);
  assert.match(deliveryQuery, /oldest_pending_at<=datetime\('now','-30 seconds'\)/);
  assert.match(deliveryQuery, /pending_chapters>=stack_size/);
  assert.match(deliveryQuery, /eligible=0 THEN 'stale_ineligible'/);
});
