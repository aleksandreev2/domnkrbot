import assert from 'node:assert/strict';
import test from 'node:test';
import { RanobeLibAuthProvider } from '../dist-runtime/ranobelib-auth.js';

const KEY = 'unit-test-encryption-key-with-enough-entropy';
const TELEGRAM = '123456:telegram-secret-used-for-legacy-migration';
const ACCESS = 'access-secret-value';
const REFRESH = 'refresh-secret-value';
const NOW = new Date('2026-09-11T12:00:00.000Z');
const ADDITIONAL_DATA = 'domnkrbot:ranobelib-auth:v1';
const encoder = new TextEncoder();

function memoryDb(initialRow = null) {
  let row = initialRow ? { ...initialRow } : null;
  return {
    get row() { return row; },
    set row(value) { row = value ? { ...value } : null; },
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async first() { return /SELECT/i.test(sql) && row ? { ...row } : null; },
        async all() { return { results: [] }; },
        async run() {
          if (/DELETE FROM ranobelib_auth_credentials/i.test(sql)) row = null;
          else if (/INSERT INTO ranobelib_auth_credentials/i.test(sql)) {
            const keyVersion = Number(/VALUES\s*\(1\s*,\s*\?\s*,\s*\?\s*,\s*(\d+)/i.exec(sql)?.[1] ?? 1);
            row = {
              singleton_id: 1,
              ciphertext: values[0], iv: values[1], key_version: keyVersion,
              access_expires_at: values[2], state: values[3],
              last_validated_at: values[4], last_refreshed_at: values[5],
              refresh_failures: values[6] ?? 0, last_refresh_failure_at: values[7] ?? null,
              last_error: values[8] ?? null, updated_at: NOW.toISOString(),
            };
          } else if (/UPDATE ranobelib_auth_credentials/i.test(sql) && row) {
            row.state = values[0];
            row.last_error = values[1];
            row.refresh_failures = Number(row.refresh_failures ?? 0) + 1;
            row.last_refresh_failure_at = NOW.toISOString();
            row.updated_at = NOW.toISOString();
          }
          return { success: true };
        },
      };
    },
  };
}

function provider(db, options = {}) {
  return new RanobeLibAuthProvider(
    {
      DB: db,
      ...(options.key === null ? {} : { RANOBELIB_TOKEN_ENCRYPTION_KEY: options.key ?? KEY }),
      ...(options.telegram ? { TELEGRAM_BOT_TOKEN: options.telegram } : {}),
    },
    { fetchImpl: options.fetchImpl, now: () => options.now ?? NOW },
  );
}

async function deriveKey(namespace, secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${namespace}\n${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function legacyRow(bundle) {
  const key = await deriveKey('domnkrbot:ranobelib-auth:telegram-fallback:v1', TELEGRAM);
  const iv = new Uint8Array(12).fill(7);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(ADDITIONAL_DATA) },
    key,
    encoder.encode(JSON.stringify(bundle)),
  );
  return {
    singleton_id: 1,
    ciphertext: b64(new Uint8Array(ciphertext)),
    iv: b64(iv),
    key_version: 2,
    access_expires_at: bundle.expiresAt,
    state: 'active',
    last_validated_at: NOW.toISOString(),
    last_refreshed_at: null,
    refresh_failures: 0,
    last_refresh_failure_at: null,
    last_error: null,
    updated_at: NOW.toISOString(),
  };
}

test('dedicated-key encrypted persistence round-trips while D1 fields contain neither token', async () => {
  const db = memoryDb();
  const auth = provider(db);
  const bundle = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' };
  await auth.store(bundle, { validatedAt: NOW.toISOString() });
  assert.ok(db.row);
  assert.equal(db.row.key_version, 1);
  assert.notEqual(db.row.ciphertext, ACCESS);
  assert.doesNotMatch(JSON.stringify(db.row), new RegExp(`${ACCESS}|${REFRESH}`));
  assert.deepEqual(await auth.load(), bundle);
  assert.equal((await auth.health()).encryptionState, 'dedicated');
});

test('AES-GCM uses a fresh IV and a wrong dedicated key cannot decrypt the bundle', async () => {
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
    state: 'missing', encryptionState: 'missing', accessExpiresAt: null,
    lastValidatedAt: null, lastRefreshedAt: null, refreshFailures: 0,
    lastRefreshFailureAt: null, lastError: null, updatedAt: null,
  });
  assert.doesNotMatch(JSON.stringify(await auth.health()), /accessToken|refreshToken/);
});

test('validation requires secure local persistence before calling the signed-in identity endpoint', async () => {
  const db = memoryDb();
  let calls = 0;
  const auth = provider(db, {
    key: null,
    telegram: TELEGRAM,
    fetchImpl: async () => { calls += 1; return Response.json({ data: { id: 11931299 } }); },
  });
  await assert.rejects(
    () => auth.validateAndStore({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' }),
    /RANOBELIB_TOKEN_ENCRYPTION_KEY/,
  );
  assert.equal(calls, 0);
  assert.equal(db.row, null);
});

test('validation calls the signed-in identity endpoint before storing dedicated-key credentials', async () => {
  const db = memoryDb();
  const calls = [];
  const auth = provider(db, { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: { id: 11931299 } });
  } });
  await auth.validateAndStore({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' });
  assert.equal(calls[0].url, 'https://api.cdnlibs.org/api/auth/me');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ACCESS}`);
  const health = await auth.health();
  assert.equal(health.state, 'active');
  assert.equal(health.encryptionState, 'dedicated');
});

test('expired access refreshes once for concurrent callers and clears refresh failure diagnostics', async () => {
  const db = memoryDb();
  let refreshCalls = 0;
  const auth = provider(db, { fetchImpl: async (_url, init) => {
    refreshCalls += 1;
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { grant_type: 'refresh_token', client_id: '1', refresh_token: REFRESH, scope: '' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
  } });
  await auth.store({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T12:01:00.000Z' }, {
    refreshFailures: 2, lastRefreshFailureAt: '2026-09-11T11:00:00.000Z', lastError: 'old error',
  });
  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ['rotated-access', 'rotated-access', 'rotated-access']);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(await auth.load(), {
    accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: '2026-09-11T13:00:00.000Z',
  });
  const health = await auth.health();
  assert.equal(health.lastRefreshedAt, NOW.toISOString());
  assert.equal(health.refreshFailures, 0);
  assert.equal(health.lastRefreshFailureAt, null);
  assert.equal(health.lastError, null);
});

test('invalid refresh marks health invalid, increments failure count and never leaks token values', async () => {
  const db = memoryDb();
  const auth = provider(db, { fetchImpl: async () => new Response(`bad ${ACCESS} ${REFRESH}`, { status: 401 }) });
  await auth.store({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T12:01:00.000Z' });
  await assert.rejects(() => auth.getAccessToken(), /refresh failed: 401/i);
  const health = await auth.health();
  assert.equal(health.state, 'invalid');
  assert.equal(health.refreshFailures, 1);
  assert.equal(health.lastRefreshFailureAt, NOW.toISOString());
  assert.doesNotMatch(JSON.stringify(health), new RegExp(`${ACCESS}|${REFRESH}`));
});

test('legacy Telegram-derived credentials migrate once to the dedicated key', async () => {
  const bundle = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' };
  const db = memoryDb(await legacyRow(bundle));
  const auth = provider(db, { telegram: TELEGRAM });
  assert.equal((await auth.health()).encryptionState, 'legacy');
  assert.deepEqual(await auth.load(), bundle);
  assert.equal(db.row.key_version, 1);
  assert.equal((await auth.health()).encryptionState, 'dedicated');
  assert.doesNotMatch(JSON.stringify(db.row), new RegExp(`${ACCESS}|${REFRESH}`));
});

test('legacy credential is unavailable until the dedicated migration key is configured', async () => {
  const bundle = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-09-11T13:00:00.000Z' };
  const db = memoryDb(await legacyRow(bundle));
  const auth = provider(db, { key: null, telegram: TELEGRAM });
  const health = await auth.health();
  assert.equal(health.state, 'unavailable');
  assert.equal(health.encryptionState, 'unavailable');
  await assert.rejects(() => auth.load(), /RANOBELIB_TOKEN_ENCRYPTION_KEY/);
});

test('stateless PKCE OAuth request exchanges an official callback and stores only dedicated-key credentials', async () => {
  const runtime = await import('../dist-runtime/telegram-ranobelib-auth.js').catch(() => null);
  assert.equal(typeof runtime?.createRanobeLibAuthorizationRequest, 'function');
  assert.equal(typeof runtime?.completeRanobeLibAuthorizationFromCallback, 'function');

  const DB = memoryDb();
  const queries = [];
  const originalPrepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const originalRun = statement.run.bind(statement);
    statement.run = async () => { queries.push(String(sql)); return originalRun(); };
    return statement;
  };
  const env = {
    DB,
    TELEGRAM_BOT_TOKEN: '123456:oauth-state-secret',
    RANOBELIB_TOKEN_ENCRYPTION_KEY: KEY,
  };
  const start = await runtime.createRanobeLibAuthorizationRequest(env, '42', {
    now: () => NOW,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => (index + 17) % 256),
  });
  const authorize = new URL(start.authorizeUrl);
  assert.equal(authorize.origin, 'https://auth.lib.social');
  assert.equal(authorize.pathname, '/auth/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), '1');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://ranobelib.me/ru/front/auth/oauth/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorize.searchParams.get('state'), start.state);
  assert.doesNotMatch(start.authorizeUrl, /code_verifier/i);

  const callback = new URL('https://ranobelib.me/ru/front/auth/oauth/callback');
  callback.searchParams.set('code', 'one-time-oauth-code');
  callback.searchParams.set('state', start.state);
  const calls = [];
  const result = await runtime.completeRanobeLibAuthorizationFromCallback(env, '42', callback.toString(), {
    now: () => NOW,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/auth/oauth/token')) {
        const body = JSON.parse(String(init.body));
        assert.equal(body.grant_type, 'authorization_code');
        assert.equal(body.client_id, 1);
        assert.equal(body.redirect_uri, 'https://ranobelib.me/ru/front/auth/oauth/callback');
        assert.equal(body.code, 'one-time-oauth-code');
        assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43,128}$/);
        return Response.json({ access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_in: 3600 });
      }
      assert.equal(String(url), 'https://api.cdnlibs.org/api/auth/me');
      assert.equal(init.headers.Authorization, 'Bearer oauth-access');
      return Response.json({ data: { id: 777 } });
    },
  });

  assert.equal(result.state, 'active');
  assert.equal(result.encryptionState, 'dedicated');
  assert.equal(calls.length, 2);
  assert.equal(DB.row?.key_version, 1);
  assert.doesNotMatch(JSON.stringify(DB.row), /oauth-access|oauth-refresh|one-time-oauth-code/);
  assert.ok(queries.some((sql) => /UPDATE ranobelib_titles/i.test(sql) && /next_check_at\s*=\s*CURRENT_TIMESTAMP/i.test(sql)),
    'successful auth must wake RanobeLib titles for immediate rescan');
});

test('stateless RanobeLib OAuth state is bound to the requesting admin', async () => {
  const runtime = await import('../dist-runtime/telegram-ranobelib-auth.js').catch(() => null);
  const env = { DB: memoryDb(), TELEGRAM_BOT_TOKEN: '123456:oauth-state-user-binding' };
  const start = await runtime.createRanobeLibAuthorizationRequest(env, '42', {
    now: () => NOW,
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
  const callback = new URL('https://ranobelib.me/ru/front/auth/oauth/callback');
  callback.searchParams.set('code', 'unused-code');
  callback.searchParams.set('state', start.state);
  let fetches = 0;
  await assert.rejects(
    () => runtime.completeRanobeLibAuthorizationFromCallback(env, '99', callback.toString(), {
      now: () => NOW,
      fetchImpl: async () => { fetches += 1; return Response.json({}); },
    }),
    /state|admin|user/i,
  );
  assert.equal(fetches, 0);
});
