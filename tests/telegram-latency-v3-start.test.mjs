import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramTitleProposalV2WebhookRequest } from '../dist-runtime/telegram-title-proposals-v2.js';

const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
  }
  bind() { return this; }
  async run() {
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(this.query)) return { meta: { changes: 0 } };
    const housekeeping = this.query.startsWith('INSERT INTO users')
      || (this.query.includes('UPDATE telegram_proposal_sessions') && this.query.includes('input_active'))
      || this.query.includes('DELETE FROM telegram_notification_search_state')
      || this.query.includes('DELETE FROM telegram_notification_input_state');
    if (housekeeping) {
      this.db.events.push('housekeeping');
      await this.db.housekeepingGate.promise;
    }
    return { meta: { changes: 1 } };
  }
  async first() { return null; }
  async all() { return { results: [] }; }
}

class DB {
  constructor() {
    this.events = [];
    this.housekeepingGate = deferred();
  }
  prepare(query) { return new Statement(this, query); }
}

function startRequest() {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret',
    },
    body: JSON.stringify({
      message: {
        message_id: 1,
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Reader' },
        text: '/start',
      },
    }),
  });
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('/start returns after menu is visible while noncritical housekeeping stays in waitUntil', async () => {
  const db = new DB();
  const background = [];
  const ctx = { waitUntil(promise) { background.push(promise); } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split('/').pop();
    db.events.push(`telegram:${method}`);
    return Response.json({ ok: true, result: { message_id: 2 } });
  };

  try {
    let settled = false;
    const handling = handleTelegramTitleProposalV2WebhookRequest(startRequest(), {
      DB: db,
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    }, ctx).then((response) => {
      settled = true;
      return response;
    });

    await flush();

    assert.ok(db.events.includes('telegram:sendMessage'), `menu send must start immediately; events=${JSON.stringify(db.events)}`);
    assert.ok(db.events.includes('housekeeping'), 'background housekeeping must still start');
    assert.equal(settled, true, 'visible /start screen must not wait for housekeeping when waitUntil is available');
    assert.equal(background.length, 1, 'noncritical housekeeping must be attached to waitUntil');

    const response = await handling;
    assert.equal(response?.status, 200);

    db.housekeepingGate.resolve();
    await Promise.all(background);
  } finally {
    db.housekeepingGate.resolve();
    globalThis.fetch = originalFetch;
  }
});
