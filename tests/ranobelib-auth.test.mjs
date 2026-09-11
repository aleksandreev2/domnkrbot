import assert from 'node:assert/strict';
import test from 'node:test';
import { RanobeLibAuthProvider } from '../dist-runtime/ranobelib-auth.js';

const KEY = 'unit-test-encryption-key-with-enough-entropy';
const ACCESS = 'access-secret-value';
const REFRESH = 'refresh-secret-value';
const NOW = new Date('2026-09-11T12:00:00.000Z');

function memoryDb() {
  let row = null;
  return {
    get row() { return row; },
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async first() { return /SELECT/i.test(sql) && row ? { ...row } : null; },
        async all() { return { results: [] }; },
        async run() {
          if (/DELETE FROM ranobelib_auth_credentials/i.test(sql)) row = null;
          else if (/INSERT INTO ranobelib_auth_credentials/i.test(sql)) {
            row = {
              singleton_id: 1, ciphertext: values[0], iv: values[1], key_version: 1,
              access_expires_at: values[2], state: values[3], last_validated_at: values[4],
              last_refreshed_at: values[5], last_error: values[6], updated_at: NOW.toISOString(),
            };
          } else if (/UPDATE ranobelib_auth_credentials/i.test(sql) && row) {
            row.state = values[0];
            row.last_error = values[1];
          }
          return { success: true };
        },
      };
    },
  };
}

function provider(db, options = {}) {
  return new RanobeLibAuthProvider(
    { DB: db, RANOBELIB_TOKEN_ENCRYPTION_KEY: options.key ?? KEY },
    { fetchImpl: options.fetchImpl, now: () => options.now ?? NOW },
  );
}

test('encrypted persistence round-trips while D1 fields contain neither token', async () => {
  const db = memoryDb();
  const auth = provider(db);
  const bundle = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' };
  await auth.store(bundle, { validatedAt: NOW.toISOString() });
  assert.ok(db.row);
  assert.notEqual(db.row.ciphertext, ACCESS);
  assert.doesNotMatch(JSON.stringify(db.row), new RegExp(`${ACCESS}|${REFRESH}`));
  assert.deepEqual(await auth.load(), bundle);
});

test('AES-GCM uses a fresh IV and a wrong key cannot decrypt the bundle', async () => {
  const db = memoryDb();
  const auth = provider(db);
  const bundle = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' };
  await auth.store(bundle);
  const firstIv = db.row.iv;
  await auth.store(bundle);
  assert.notEqual(db.row.iv, firstIv);
  await assert.rejects(() => provider(db, { key: 'different-key' }).load(), /decrypt/i);
});

test('health never exposes secrets and missing credentials remain anonymous', async () => {
  const db = memoryDb();
  const auth = provider(db);
  assert.equal(await auth.getAccessToken(), null);
  assert.deepEqual(await auth.health(), {
    state: 'missing', accessExpiresAt: null, lastValidatedAt: null,
    lastRefreshedAt: null, lastError: null, updatedAt: null,
  });
  assert.doesNotMatch(JSON.stringify(await auth.health()), /accessToken|refreshToken/);
});

test('validation calls the signed-in identity endpoint before storing credentials', async () => {
  const db = memoryDb();
  const calls = [];
  const auth = provider(db, { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: { id: 11931299 } });
  } });
  await auth.validateAndStore({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' });
  assert.equal(calls[0].url, 'https://api.cdnlibs.org/api/auth/me');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCESS}`);
  assert.equal((await auth.health()).state, 'active');
});

test('expired access refreshes once for concurrent callers and persists rotated tokens', async () => {
  const db = memoryDb();
  let refreshCalls = 0;
  const auth = provider(db, { fetchImpl: async (_url, init) => {
    refreshCalls += 1;
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { grant_type: 'refresh_token', client_id: '1', refresh_token: REFRESH, scope: '' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
  } });
  await auth.store({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T12:01:00.000Z' });
  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ['rotated-access', 'rotated-access', 'rotated-access']);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(await auth.load(), {
    accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: '2026-09-11T13:00:00.000Z',
  });
  assert.equal((await auth.health()).lastRefreshedAt, NOW.toISOString());
});

test('invalid refresh marks health invalid without leaking token values', async () => {
  const db = memoryDb();
  const auth = provider(db, { fetchImpl: async () => new Response(`bad ${ACCESS} ${REFRESH}`, { status: 401 }) });
  await auth.store({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T12:01:00.000Z' });
  await assert.rejects(() => auth.getAccessToken(), /refresh failed: 401/i);
  const health = await auth.health();
  assert.equal(health.state, 'invalid');
  assert.doesNotMatch(JSON.stringify(health), new RegExp(`${ACCESS}|${REFRESH}`));
});

test('existing Telegram bot secret can encrypt credentials when the dedicated RanobeLib key is absent', async () => {
  const db = memoryDb();
  const auth = new RanobeLibAuthProvider(
    { DB: db, TELEGRAM_BOT_TOKEN: '123456:telegram-secret-used-only-as-key-material' },
    { now: () => NOW },
  );
  const bundle = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' };
  await auth.store(bundle);
  assert.ok(db.row?.ciphertext);
  assert.doesNotMatch(JSON.stringify(db.row), new RegExp(`${ACCESS}|${REFRESH}`));
  assert.equal((await auth.health()).state, 'active');
});
