import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import { handlePublishingDiagnostics } from '../dist-runtime/publishing-diagnostics.js';

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
    if (this.query === 'SELECT value FROM app_settings WHERE key=?') {
      const key = String(this.values[0]);
      return Object.prototype.hasOwnProperty.call(this.db.settings, key)
        ? { value: this.db.settings[key] }
        : null;
    }
    return null;
  }

  async run() {
    if (this.query.startsWith('INSERT INTO app_settings ')) {
      this.db.settings[String(this.values[0])] = String(this.values[1]);
    }
    return {};
  }
}

class MockDB {
  constructor() {
    this.settings = {
      publish_channel_id: '-100111',
      discussion_chat_id: '-100222',
    };
  }

  prepare(query) {
    return new MockStatement(this, query);
  }
}

class MockR2Object {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = bytes.byteLength;
  }

  async arrayBuffer() {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

class MockR2 {
  constructor() {
    this.objects = new Map();
    this.puts = 0;
    this.deletes = 0;
  }

  async put(key, value) {
    this.puts += 1;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, bytes.slice());
  }

  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? new MockR2Object(bytes) : null;
  }

  async delete(key) {
    this.deletes += 1;
    this.objects.delete(key);
  }
}

async function request(origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/admin/publishing/diagnostics`, {
    method: 'POST',
    headers: { origin, cookie: await adminCookie() },
  });
}

function env(db, files) {
  return {
    DB: db,
    FILES: files,
    TELEGRAM_BOT_TOKEN: TOKEN,
    ADMIN_TELEGRAM_IDS: '424242',
    BOT_USERNAME: 'domnekromanta_bot',
    PUBLISH_CHANNEL_ID: '@domnekromanta',
  };
}

function telegramOk(result) {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

test('publishing diagnostics verifies R2, Telegram target and private multipart upload without channel publish', async (t) => {
  const db = new MockDB();
  const files = new MockR2();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    calls.push(method);
    if (method === 'getMe') return telegramOk({ id: 999, username: 'domnekromanta_bot' });
    if (method === 'getChat') {
      const payload = JSON.parse(options.body);
      if (String(payload.chat_id) === '-100111') return telegramOk({ id: -100111, type: 'channel', title: 'Дом Некроманта', username: 'domnekromanta', linked_chat_id: -100222 });
      if (String(payload.chat_id) === '-100222') return telegramOk({ id: -100222, type: 'supergroup', title: 'Комментарии Дома Некроманта' });
    }
    if (method === 'getChatMember') {
      const payload = JSON.parse(options.body);
      if (String(payload.chat_id) === '-100111') return telegramOk({ status: 'administrator', can_post_messages: true });
      if (String(payload.chat_id) === '-100222') return telegramOk({ status: 'administrator' });
    }
    if (method === 'sendDocument') {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('chat_id'), '424242');
      const document = options.body.get('document');
      assert.ok(document instanceof Blob);
      return telegramOk({ message_id: 555, document: { file_id: 'BQAC-test', file_name: 'domnkr-publishing-self-test.txt' } });
    }
    throw new Error(`Unexpected Telegram call: ${method}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await handlePublishingDiagnostics(await request(), env(db, files));
  assert.ok(response);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.channelPublished, false);
  assert.equal(body.checks.storage.ok, true);
  assert.equal(body.checks.telegramTarget.ok, true);
  assert.equal(body.checks.telegramUpload.ok, true);
  assert.equal(body.checks.telegramUpload.messageId, 555);
  assert.equal(files.puts, 1);
  assert.equal(files.deletes, 1);
  assert.equal(files.objects.size, 0, 'diagnostic R2 object must be deleted');
  assert.equal(calls.includes('sendMessage'), false);
  assert.equal(calls.filter((method) => method === 'sendDocument').length, 1);
});

test('publishing diagnostics fails closed before Telegram calls when FILES binding is unavailable', async (t) => {
  const db = new MockDB();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should not call Telegram'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await handlePublishingDiagnostics(await request(), env(db, undefined));
  assert.ok(response);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.channelPublished, false);
  assert.match(body.error, /R2 FILES binding/);
  assert.equal(calls, 0);
});

test('publishing diagnostics rejects cross-origin mutations', async () => {
  const db = new MockDB();
  const files = new MockR2();
  const response = await handlePublishingDiagnostics(await request('https://evil.example'), env(db, files));
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal(files.puts, 0);
});
