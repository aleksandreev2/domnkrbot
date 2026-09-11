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
              last_refreshed_at: values[5], last_error: values[6], updated_at: NOW.toISOString(),
            };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
}

test('direct token bundle import validates, encrypts and wakes RanobeLib scans', async () => {
  const runtime = await import('../dist-runtime/telegram-ranobelib-auth.js').catch(() => null);
  assert.equal(typeof runtime?.importRanobeLibTokenBundle, 'function');

  const db = memoryDb();
  const calls = [];
  const env = { DB: db, TELEGRAM_BOT_TOKEN: '123456:direct-import-encryption-secret' };
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
  assert.equal(calls.length, 1);
  assert.equal(db.row?.key_version, 2);
  assert.equal(db.row?.access_expires_at, '2026-10-11T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(db.row), /direct-access-secret|direct-refresh-secret/);
  assert.ok(db.queries.some(({ sql }) => /UPDATE ranobelib_titles/i.test(sql) && /next_check_at\s*=\s*CURRENT_TIMESTAMP/i.test(sql)));
});
