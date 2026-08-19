import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';

const TOKEN = '123456:test-token-for-unit-tests-only';
const ORIGIN = 'https://domnkr.test';

function telegramLoginUrl(overrides = {}) {
  const fields = {
    id: '424242',
    first_name: 'Necromancer',
    username: 'domnkr_test',
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const url = new URL('/auth/telegram/callback', ORIGIN);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  url.searchParams.set('hash', hash);
  return url;
}

const env = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  ADMIN_TELEGRAM_IDS: '424242,999',
  BOT_USERNAME: 'domnekromanta_bot',
};

test('accepts a valid Telegram Login payload and creates an admin session', async () => {
  const response = await handleWebAuth(new Request(telegramLoginUrl()), env);
  assert.ok(response);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin/');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie ?? '', /__Host-domnkr_session=/);
  assert.match(cookie ?? '', /HttpOnly/);
  assert.match(cookie ?? '', /Secure/);

  const sessionCookie = cookie.split(';', 1)[0];
  const sessionResponse = await handleWebAuth(new Request(`${ORIGIN}/api/auth/session`, {
    headers: { cookie: sessionCookie },
  }), env);
  assert.ok(sessionResponse);
  assert.equal(sessionResponse.status, 200);
  const body = await sessionResponse.json();
  assert.equal(body.user.id, 424242);
  assert.equal(body.user.username, 'domnkr_test');
  assert.equal(body.isAdmin, true);
});

test('rejects a tampered Telegram Login payload', async () => {
  const url = telegramLoginUrl();
  url.searchParams.set('first_name', 'Mallory');
  const response = await handleWebAuth(new Request(url), env);
  assert.ok(response);
  assert.equal(response.status, 401);
});

test('rejects stale Telegram Login payloads', async () => {
  const url = telegramLoginUrl({ auth_date: String(Math.floor(Date.now() / 1000) - 3600) });
  const response = await handleWebAuth(new Request(url), env);
  assert.ok(response);
  assert.equal(response.status, 401);
});

test('rejects cross-origin logout mutations', async () => {
  const response = await handleWebAuth(new Request(`${ORIGIN}/auth/logout`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  }), env);
  assert.ok(response);
  assert.equal(response.status, 403);
});
