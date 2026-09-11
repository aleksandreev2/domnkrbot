import assert from 'node:assert/strict';
import test from 'node:test';

const NOW = new Date('2026-09-11T12:00:00.000Z');

function memoryDb() {
  let row = null;
  const queries = [];
  return {
    get row() { return row; },
    get queries() { return queries; },
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async first() {
          return /FROM ranobelib_auth_credentials/i.test(sql) && row ? { ...row } : null;
        },
        async all() { return { results: [] }; },
        async run() {
          queries.push({ sql, values: [...values] });
          if (/INSERT INTO ranobelib_auth_credentials/i.test(sql)) {
            const keyVersion = Number(/VALUES\s*\(1\s*,\s*\?\s*,\s*\?\s*,\s*(\d+)/i.exec(sql)?.[1] ?? 1);
            row = {
              ciphertext: values[0], iv: values[1], key_version: keyVersion,
              access_expires_at: values[2], state: values[3], last_validated_at: values[4],
              last_refreshed_at: values[5], refresh_failures: values[6] ?? 0,
              last_refresh_failure_at: values[7] ?? null, last_error: values[8] ?? null,
              updated_at: NOW.toISOString(),
            };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
}

test('direct token bundle import validates, encrypts with dedicated key and wakes RanobeLib scans', async () => {
  const runtime = await import('../dist-runtime/telegram-ranobelib-auth.js').catch(() => null);
  assert.equal(typeof runtime?.importRanobeLibTokenBundle, 'function');

  const db = memoryDb();
  const calls = [];
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123456:telegram-runtime-secret',
    RANOBELIB_TOKEN_ENCRYPTION_KEY: 'direct-import-dedicated-encryption-secret',
  };
  const bundle = {
    token_type: 'Bearer',
    expires_in: 2592000,
    access_token: 'direct-access-secret',
    refresh_token: 'direct-refresh-secret',
    timestamp: NOW.getTime(),
  };

  const health = await runtime.importRanobeLibTokenBundle(env, bundle, {
    now: () => NOW,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      assert.equal(String(url), 'https://api.cdnlibs.org/api/auth/me');
      assert.equal(init.headers.Authorization, 'Bearer direct-access-secret');
      return Response.json({ data: { id: 777 } });
    },
  });

  assert.equal(health.state, 'active');
  assert.equal(health.encryptionState, 'dedicated');
  assert.equal(calls.length, 1);
  assert.equal(db.row?.key_version, 1);
  assert.equal(db.row?.access_expires_at, '2026-10-11T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(db.row), /direct-access-secret|direct-refresh-secret/);
  assert.ok(db.queries.some(({ sql }) => /UPDATE ranobelib_titles/i.test(sql) && /next_check_at\s*=\s*CURRENT_TIMESTAMP/i.test(sql)));
});

test('direct import fails before validation if dedicated encryption key is missing', async () => {
  const runtime = await import('../dist-runtime/telegram-ranobelib-auth.js');
  const db = memoryDb();
  let calls = 0;
  await assert.rejects(
    () => runtime.importRanobeLibTokenBundle({ DB: db, TELEGRAM_BOT_TOKEN: '123456:only-telegram' }, {
      expires_in: 3600,
      access_token: 'a',
      refresh_token: 'b',
      timestamp: NOW.getTime(),
    }, {
      now: () => NOW,
      fetchImpl: async () => { calls += 1; return Response.json({ data: { id: 777 } }); },
    }),
    /RANOBELIB_TOKEN_ENCRYPTION_KEY/,
  );
  assert.equal(calls, 0);
  assert.equal(db.row, null);
});
