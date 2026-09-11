import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { handleRanobeLibAuthAdmin } from '../dist-runtime/ranobelib-auth-admin.js';
import { handleWebAuth } from '../dist-runtime/web-auth.js';

const ORIGIN = 'https://domnkr.test';
const TELEGRAM_TOKEN = '123456:admin-test-token';
const TOKEN_BUNDLE = {
  accessToken: 'admin-access-secret', refreshToken: 'admin-refresh-secret',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function db() {
  let row = null;
  return { prepare(sql) { let values = []; return {
    bind(...next) { values = next; return this; },
    async first() { return /SELECT/i.test(sql) && row ? { ...row } : null; },
    async all() { return { results: [] }; },
    async run() {
      if (/INSERT INTO ranobelib_auth_credentials/i.test(sql)) {
        const keyVersion = Number(/VALUES\s*\(1\s*,\s*\?\s*,\s*\?\s*,\s*(\d+)/i.exec(sql)?.[1] ?? 1);
        row = {
          ciphertext: values[0], iv: values[1], key_version: keyVersion, access_expires_at: values[2],
          state: values[3], last_validated_at: values[4], last_refreshed_at: values[5],
          last_error: values[6], updated_at: '2026-09-11T12:00:00.000Z',
        };
      }
      if (/DELETE FROM ranobelib_auth_credentials/i.test(sql)) row = null;
      return { success: true };
    },
  }; } };
}

async function adminCookie() {
  const fields = { id: '424242', first_name: 'Admin', auth_date: String(Math.floor(Date.now() / 1000)) };
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHash('sha256').update(TELEGRAM_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const url = new URL('/auth/telegram/callback', ORIGIN);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  url.searchParams.set('hash', hash);
  const response = await handleWebAuth(new Request(url), baseEnv(db()));
  return response.headers.get('set-cookie').split(';', 1)[0];
}

function baseEnv(DB) {
  return {
    DB, TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN, ADMIN_TELEGRAM_IDS: '424242',
    RANOBELIB_TOKEN_ENCRYPTION_KEY: 'admin-encryption-key',
  };
}

async function request(method, body, options = {}) {
  const headers = { cookie: options.cookie ?? await adminCookie() };
  if (method !== 'GET') headers.origin = options.origin ?? ORIGIN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}/api/admin/ranobelib/auth`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('credential endpoints reject missing admin session and cross-origin mutations', async () => {
  const env = baseEnv(db());
  const unauthenticated = await handleRanobeLibAuthAdmin(new Request(`${ORIGIN}/api/admin/ranobelib/auth`), env);
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await handleRanobeLibAuthAdmin(await request('PUT', TOKEN_BUNDLE, { origin: 'https://evil.test' }), env);
  assert.equal(crossOrigin.status, 403);
});

test('validated import returns health metadata without echoing token values', async () => {
  const env = baseEnv(db());
  const response = await handleRanobeLibAuthAdmin(await request('PUT', TOKEN_BUNDLE), env, {
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN_BUNDLE.accessToken}`);
      return Response.json({ data: { id: 11931299 } });
    },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /admin-access-secret|admin-refresh-secret|accessToken|refreshToken/);
  assert.equal(JSON.parse(text).auth.state, 'active');
});

test('validated import uses Telegram bot secret when dedicated encryption key is absent', async () => {
  const env = baseEnv(db());
  delete env.RANOBELIB_TOKEN_ENCRYPTION_KEY;
  const response = await handleRanobeLibAuthAdmin(await request('PUT', TOKEN_BUNDLE), env, {
    fetchImpl: async () => Response.json({ data: { id: 11931299 } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).auth.state, 'active');
});

test('malformed bundles fail without storing or exposing submitted secrets', async () => {
  const env = baseEnv(db());
  const response = await handleRanobeLibAuthAdmin(await request('PUT', {
    accessToken: TOKEN_BUNDLE.accessToken, refreshToken: TOKEN_BUNDLE.refreshToken, expiresAt: 'not-a-date',
  }), env);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /admin-access-secret|admin-refresh-secret/);
});

test('deletion is idempotent and health becomes missing', async () => {
  const env = baseEnv(db());
  await handleRanobeLibAuthAdmin(await request('PUT', TOKEN_BUNDLE), env, {
    fetchImpl: async () => Response.json({ data: { id: 11931299 } }),
  });
  const removed = await handleRanobeLibAuthAdmin(await request('DELETE'), env);
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).auth.state, 'missing');
  const removedAgain = await handleRanobeLibAuthAdmin(await request('DELETE'), env);
  assert.equal((await removedAgain.json()).auth.state, 'missing');
});
