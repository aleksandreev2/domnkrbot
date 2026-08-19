import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import { handlePublishingApi } from '../dist-runtime/publishing-runtime.js';

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
    if (this.query.includes('FROM publications WHERE id=?')) return this.db.publication ? { ...this.db.publication } : null;
    return null;
  }

  async all() {
    if (this.query.includes('FROM publication_assets WHERE publication_id=?')) {
      return { results: this.db.assets.map((asset) => ({ ...asset })) };
    }
    return { results: [] };
  }

  async run() {
    this.db.operations.push({ query: this.query, values: [...this.values] });
    if (this.query.startsWith('INSERT INTO publications ')) {
      this.db.publication = {
        id: 1,
        status: 'draft',
        internal_title: String(this.values[0]),
        body_html: String(this.values[1]),
        add_footer: Number(this.values[2]),
        add_bot_comment: Number(this.values[3]),
        image_key: null,
        image_mime: null,
        image_name: null,
        channel_message_id: null,
        discussion_message_id: null,
        error_text: null,
        created_by: String(this.values[4]),
        created_at: '2026-08-19 10:00:00',
        updated_at: '2026-08-19 10:00:00',
        published_at: null,
      };
      return { meta: { last_row_id: 1 } };
    }
    if (this.query.startsWith('INSERT INTO publication_assets ')) {
      const asset = {
        id: this.db.assets.length + 1,
        publication_id: Number(this.values[0]),
        file_name: String(this.values[1]),
        mime_type: this.values[2] === null ? null : String(this.values[2]),
        r2_key: String(this.values[3]),
        size_bytes: Number(this.values[4]),
        telegram_file_id: null,
        sort_order: Number(this.values[5]),
        created_at: '2026-08-19 10:00:00',
      };
      this.db.assets.push(asset);
      return { meta: { last_row_id: asset.id } };
    }
    return {};
  }
}

class MockDB {
  constructor() {
    this.publication = null;
    this.assets = [];
    this.operations = [];
  }

  prepare(query) {
    return new MockStatement(this, query);
  }
}

class MockBucket {
  constructor() {
    this.puts = [];
    this.deleted = [];
  }

  async put(key, value, options) {
    this.puts.push({ key, value, options });
    return {};
  }

  async get() {
    return null;
  }

  async delete(key) {
    this.deleted.push(key);
  }
}

async function createRequest(file) {
  const form = new FormData();
  form.set('internal_title', 'Глава 10');
  form.set('body', 'Новая глава готова.');
  form.set('add_footer', 'true');
  form.set('add_bot_comment', 'true');
  if (file) form.append('files', file);
  return new Request(`${ORIGIN}/api/admin/publications`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: await adminCookie() },
    body: form,
  });
}

function env(db, files) {
  return {
    DB: db,
    FILES: files,
    TELEGRAM_BOT_TOKEN: TOKEN,
    ADMIN_TELEGRAM_IDS: '424242',
    BOT_USERNAME: 'domnekromanta_bot',
  };
}

test('binary publication fails closed when FILES binding is missing', async () => {
  const db = new MockDB();
  const file = new File(['chapter'], 'chapter.txt', { type: 'text/plain' });
  const response = await handlePublishingApi(await createRequest(file), env(db, undefined));
  assert.ok(response);
  assert.equal(response.status, 503);
  assert.equal(db.publication, null);
  const body = await response.json();
  assert.match(body.error, /R2 FILES binding/);
});

test('binary publication writes the attachment to R2 and stores its D1 metadata', async () => {
  const db = new MockDB();
  const bucket = new MockBucket();
  const file = new File(['chapter'], 'chapter.txt', { type: 'text/plain' });
  const response = await handlePublishingApi(await createRequest(file), env(db, bucket));
  assert.ok(response);
  assert.equal(response.status, 201);
  assert.equal(bucket.puts.length, 1);
  assert.match(bucket.puts[0].key, /^publications\/1\/files\//);
  assert.equal(bucket.puts[0].options.httpMetadata.contentType, 'text/plain');
  assert.equal(db.assets.length, 1);
  assert.equal(db.assets[0].file_name, 'chapter.txt');
  assert.equal(db.assets[0].size_bytes, file.size);
  assert.equal(db.assets[0].r2_key, bucket.puts[0].key);
  const body = await response.json();
  assert.equal(body.publication.id, 1);
  assert.equal(body.publication.assets.length, 1);
});
