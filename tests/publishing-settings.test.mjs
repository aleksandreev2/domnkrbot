import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import { handlePublishingSettingsGuard } from '../dist-runtime/publishing-settings-guard.js';

const TOKEN = '123456:test-token-for-unit-tests-only';
const ORIGIN = 'https://domnkr.test';

function telegramLoginUrl() {
  const fields = {
    id: '424242',
    first_name: 'Necromancer',
    username: 'domnkr_test',
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const url = new URL('/auth/telegram/callback', ORIGIN);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  url.searchParams.set('hash', hash);
  return url;
}

async function adminCookie() {
  const response = await handleWebAuth(new Request(telegramLoginUrl()), {
    TELEGRAM_BOT_TOKEN: TOKEN,
    ADMIN_TELEGRAM_IDS: '424242',
    BOT_USERNAME: 'domnekromanta_bot',
  });
  assert.ok(response);
  const raw = response.headers.get('set-cookie');
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

class MockStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return null;
  }

  async run() {
    this.db.operations.push({ query: this.query, values: [...this.values] });
    if (this.query.startsWith('INSERT INTO app_settings ')) {
      this.db.settings[String(this.values[0])] = String(this.values[1]);
    }
    return {};
  }
}

class MockDB {
  constructor() {
    this.settings = {};
    this.operations = [];
  }

  prepare(query) {
    return new MockStatement(this, query);
  }
}

async function adminRequest(payload) {
  return new Request(`${ORIGIN}/api/admin/publishing/settings`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      cookie: await adminCookie(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function env(db) {
  return {
    DB: db,
    FILES: {},
    TELEGRAM_BOT_TOKEN: TOKEN,
    ADMIN_TELEGRAM_IDS: '424242',
    BOT_USERNAME: 'domnekromanta_bot',
  };
}

function telegramOk(result) {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

test('publishing settings validate bot rights and auto-detect linked discussion group', async (t) => {
  const db = new MockDB();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    const payload = JSON.parse(options.body);
    if (method === 'getMe') return telegramOk({ id: 999, username: 'domnekromanta_bot' });
    if (method === 'getChat' && payload.chat_id === '@domnkr_channel') {
      return telegramOk({ id: -100111, type: 'channel', title: 'Дом Некроманта', username: 'domnkr_channel', linked_chat_id: -100222 });
    }
    if (method === 'getChat' && payload.chat_id === -100222) {
      return telegramOk({ id: -100222, type: 'supergroup', title: 'Комментарии Дома Некроманта' });
    }
    if (method === 'getChatMember' && payload.chat_id === -100111) {
      return telegramOk({ status: 'administrator', can_post_messages: true });
    }
    if (method === 'getChatMember' && payload.chat_id === -100222) {
      return telegramOk({ status: 'administrator' });
    }
    throw new Error(`Unexpected Telegram call: ${method} ${JSON.stringify(payload)}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await handlePublishingSettingsGuard(
    await adminRequest({ publishChannelId: 'domnkr_channel', discussionChatId: '' }),
    env(db),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.publishChannelId, '-100111');
  assert.equal(body.settings.discussionChatId, '-100222');
  assert.equal(body.settings.storageReady, true);
  assert.equal(body.telegram.discussionAutoDetected, true);
  assert.equal(db.settings.publish_channel_id, '-100111');
  assert.equal(db.settings.discussion_chat_id, '-100222');
});

test('publishing settings reject a channel where the bot cannot post', async (t) => {
  const db = new MockDB();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    const payload = JSON.parse(options.body);
    if (method === 'getMe') return telegramOk({ id: 999, username: 'domnekromanta_bot' });
    if (method === 'getChat') return telegramOk({ id: -100111, type: 'channel', title: 'Дом Некроманта' });
    if (method === 'getChatMember') return telegramOk({ status: 'administrator', can_post_messages: false });
    throw new Error(`Unexpected Telegram call: ${method} ${JSON.stringify(payload)}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await handlePublishingSettingsGuard(
    await adminRequest({ publishChannelId: '@domnkr_channel', discussionChatId: '' }),
    env(db),
  );
  assert.ok(response);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /не может публиковать/);
  assert.equal(db.settings.publish_channel_id, undefined);
  assert.equal(db.settings.discussion_chat_id, undefined);
});
