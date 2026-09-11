import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRanobeLibAuthAdminAlert } from '../dist-runtime/ranobelib-auth-alerts.js';

function credential(overrides = {}) {
  return {
    ciphertext: 'opaque-ciphertext', iv: 'opaque-iv', key_version: 1,
    access_expires_at: '2099-01-01T00:00:00.000Z', state: 'active',
    last_validated_at: '2026-09-11T12:00:00.000Z', last_refreshed_at: null,
    refresh_failures: 0, last_refresh_failure_at: null, last_error: null,
    updated_at: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

function db(initialCredential) {
  let alertFingerprint = null;
  return {
    get fingerprint() { return alertFingerprint; },
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async first() {
          if (/FROM ranobelib_auth_credentials/i.test(sql)) return initialCredential ? { ...initialCredential } : null;
          if (/SELECT value FROM app_settings/i.test(sql)) return alertFingerprint ? { value: alertFingerprint } : null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (/INSERT INTO app_settings/i.test(sql)) alertFingerprint = values[1];
          if (/DELETE FROM app_settings/i.test(sql)) alertFingerprint = null;
          return { success: true };
        },
      };
    },
  };
}

function telegramCapture() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  };
}

test('unavailable dedicated credential encryption alerts admins once without exposing secrets', async () => {
  const DB = db(credential());
  const capture = telegramCapture();
  const env = {
    DB,
    TELEGRAM_BOT_TOKEN: '123456:telegram-secret',
    ADMIN_TELEGRAM_IDS: '42, 43',
  };

  const first = await checkRanobeLibAuthAdminAlert(env, capture);
  assert.deepEqual(first, { alerted: true, reason: 'unavailable' });
  assert.equal(capture.calls.length, 2);
  assert.match(capture.calls[0].body.text, /авторизация недоступна/i);
  assert.match(capture.calls[0].body.text, /encryption: <b>unavailable<\/b>/);
  assert.doesNotMatch(capture.calls[0].body.text, /telegram-secret|ciphertext|access_token|refresh_token/i);

  const second = await checkRanobeLibAuthAdminAlert(env, capture);
  assert.deepEqual(second, { alerted: false, reason: 'unavailable' });
  assert.equal(capture.calls.length, 2, 'same alert fingerprint must not spam admins');
});

test('three refresh failures trigger an alert and healthy state clears the dedupe fingerprint', async () => {
  const row = credential({
    refresh_failures: 3,
    last_refresh_failure_at: '2026-09-11T12:15:00.000Z',
    last_error: 'RanobeLib refresh failed: 503',
  });
  const DB = db(row);
  const capture = telegramCapture();
  const env = {
    DB,
    RANOBELIB_TOKEN_ENCRYPTION_KEY: 'dedicated-encryption-key',
    TELEGRAM_BOT_TOKEN: '123456:telegram-secret',
    ADMIN_TELEGRAM_IDS: '42',
  };

  const alert = await checkRanobeLibAuthAdminAlert(env, capture);
  assert.deepEqual(alert, { alerted: true, reason: 'refresh_failures' });
  assert.match(capture.calls[0].body.text, /повторные ошибки refresh: 3/i);
  assert.ok(DB.fingerprint);

  row.refresh_failures = 0;
  row.last_refresh_failure_at = null;
  row.last_error = null;
  const healthy = await checkRanobeLibAuthAdminAlert(env, capture);
  assert.deepEqual(healthy, { alerted: false, reason: null });
  assert.equal(DB.fingerprint, null);
});

test('invalid auth has priority over refresh failure threshold', async () => {
  const DB = db(credential({ state: 'invalid', refresh_failures: 5, last_error: 'RanobeLib refresh failed: 401' }));
  const capture = telegramCapture();
  const env = {
    DB,
    RANOBELIB_TOKEN_ENCRYPTION_KEY: 'dedicated-encryption-key',
    TELEGRAM_BOT_TOKEN: '123456:telegram-secret',
    ADMIN_TELEGRAM_IDS: '42',
  };
  const result = await checkRanobeLibAuthAdminAlert(env, capture);
  assert.deepEqual(result, { alerted: true, reason: 'invalid' });
  assert.match(capture.calls[0].body.text, /авторизация недействительна/i);
});
