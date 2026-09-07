import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadDemand() {
  return import('../dist-runtime/notification-demand.js');
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
    db.calls.push(this);
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/UPDATE\s+telegram_delivery_reachability/i.test(this.query)
      && /RETURNING\s+user_telegram_id/i.test(this.query)) {
      return this.db.wasBlocked ? { user_telegram_id: String(this.values[0]) } : null;
    }
    return null;
  }
  async all() { return { results: [] }; }
  async run() { return { meta: { changes: 1 } }; }
}

class DB {
  constructor(wasBlocked) {
    this.wasBlocked = wasBlocked;
    this.calls = [];
  }
  prepare(query) { return new Statement(this, query); }
}

function telegramRequest(payload, secret = 'secret') {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(payload),
  });
}

test('any valid private /start interaction reactivates a blocked Telegram recipient and refreshes demand once', async () => {
  const demand = await loadDemand();
  const db = new DB(true);
  const changed = await demand.reactivateTelegramUserFromWebhookRequest(
    telegramRequest({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Reader' },
        text: '/start',
      },
    }),
    { DB: db, TELEGRAM_WEBHOOK_SECRET: 'secret' },
  );

  assert.equal(changed, true);
  assert.equal(db.calls.length, 2, 'blocked→active should use one transition write and one bounded demand refresh');
  assert.match(db.calls[0].query, /UPDATE\s+telegram_delivery_reachability/i);
  assert.match(db.calls[0].query, /state\s*=\s*'active'/i);
  assert.match(db.calls[0].query, /state\s*=\s*'blocked'/i);
  assert.match(db.calls[1].query, /UPDATE\s+ranobelib_titles/i);
});

test('already-active or unknown Telegram recipients do not trigger a full demand refresh on every interaction', async () => {
  const demand = await loadDemand();
  const db = new DB(false);
  const changed = await demand.reactivateTelegramUserFromWebhookRequest(
    telegramRequest({
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: 42, first_name: 'Reader' },
        data: 'prop:notifications',
        message: { message_id: 11, chat: { id: 42, type: 'private' } },
      },
    }),
    { DB: db, TELEGRAM_WEBHOOK_SECRET: 'secret' },
  );

  assert.equal(changed, false);
  assert.equal(db.calls.length, 1, 'normal interaction should only probe the blocked→active transition');
  assert.match(db.calls[0].query, /UPDATE\s+telegram_delivery_reachability/i);
});

test('reachability webhook helper ignores invalid Telegram secrets and non-private updates', async () => {
  const demand = await loadDemand();

  const invalidSecretDb = new DB(true);
  const invalid = await demand.reactivateTelegramUserFromWebhookRequest(
    telegramRequest({
      message: { chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Reader' }, text: '/start' },
    }, 'wrong'),
    { DB: invalidSecretDb, TELEGRAM_WEBHOOK_SECRET: 'secret' },
  );
  assert.equal(invalid, false);
  assert.equal(invalidSecretDb.calls.length, 0);

  const channelDb = new DB(true);
  const channel = await demand.reactivateTelegramUserFromWebhookRequest(
    telegramRequest({
      message: { chat: { id: -100, type: 'channel' }, from: { id: 42, first_name: 'Reader' }, text: 'post' },
    }),
    { DB: channelDb, TELEGRAM_WEBHOOK_SECRET: 'secret' },
  );
  assert.equal(channel, false);
  assert.equal(channelDb.calls.length, 0);
});

test('production entry performs reachability reactivation before any Telegram webhook owner can return early', () => {
  const source = readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
  const reachabilityIndex = source.indexOf('reactivateTelegramUserFromWebhookRequest');
  const readerDeliveryIndex = source.indexOf('handlePublicationReaderDeliveryWebhook(request');
  assert.ok(reachabilityIndex >= 0, 'production entry must wire the reachability helper');
  assert.ok(readerDeliveryIndex > reachabilityIndex, 'reachability must run before reader/proposal/subscription webhook routing');
});

test('a blocked result wins over a successful result for the same user inside one concurrent delivery drain', async () => {
  const demand = await loadDemand();
  const db = new DB(false);

  await demand.recordTelegramDeliveryReachability({ DB: db }, [
    { userTelegramId: '42', state: 'blocked' },
    { userTelegramId: '42', state: 'active' },
  ]);

  assert.equal(db.calls.length, 1);
  const payload = JSON.parse(db.calls[0].values[0]);
  assert.deepEqual(payload, [{ userTelegramId: '42', state: 'blocked' }]);
});
