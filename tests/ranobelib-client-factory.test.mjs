import assert from 'node:assert/strict';
import test from 'node:test';
import { RanobeLibAuthProvider } from '../dist-runtime/ranobelib-auth.js';
import { createRanobeLibClient } from '../dist-runtime/ranobelib-client-factory.js';

function memoryDb() {
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
          refresh_failures: values[6] ?? 0, last_refresh_failure_at: values[7] ?? null,
          last_error: values[8] ?? null, updated_at: '2026-09-11T12:00:00.000Z',
        };
      }
      return { success: true };
    },
  }; } };
}

test('environment-aware client authenticates restricted API reads from dedicated-key encrypted D1 credentials', async () => {
  const DB = memoryDb();
  const env = { DB, RANOBELIB_TOKEN_ENCRYPTION_KEY: 'factory-test-key' };
  await new RanobeLibAuthProvider(env).store({
    accessToken: 'factory-access', refreshToken: 'factory-refresh', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const headers = [];
  const client = createRanobeLibClient(env, { fetchImpl: async (_url, init) => {
    headers.push(init.headers);
    return Response.json({ data: { scanlateStatus: { id: 1, label: 'В работе' } } });
  } });

  await client.getTranslationStatus('247881--restricted');

  assert.equal(headers[0].Authorization, 'Bearer factory-access');
});

test('Telegram bot secret alone never enables RanobeLib authenticated reads', async () => {
  const headers = [];
  const env = {
    DB: { prepare() { throw new Error('Telegram-only factory must not read encrypted credentials'); } },
    TELEGRAM_BOT_TOKEN: '123456:factory-telegram-secret',
  };
  const client = createRanobeLibClient(env, { fetchImpl: async (_url, init) => {
    headers.push(init.headers);
    return Response.json({ data: { scanlateStatus: { id: 1, label: 'В работе' } } });
  } });

  await client.getTranslationStatus('247881--public');

  assert.equal(headers[0].Authorization, undefined);
});

test('environment-aware client keeps anonymous reads working when no key is configured', async () => {
  const headers = [];
  const client = createRanobeLibClient({ DB: memoryDb() }, { fetchImpl: async (_url, init) => {
    headers.push(init.headers);
    return Response.json({ data: { scanlateStatus: null } });
  } });
  await client.getTranslationStatus('1--public');
  assert.equal(headers[0].Authorization, undefined);
});
