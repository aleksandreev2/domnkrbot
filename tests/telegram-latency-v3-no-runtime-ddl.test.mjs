import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('trusted Telegram DB absorbs migration DDL before it reaches the real D1 binding', async () => {
  const { withTrustedTelegramMigrations } = await import('../dist-runtime/telegram-migration-trust.js');
  const queries = [];
  const realDb = {
    prepare(query) {
      queries.push(query);
      return {
        bind() { return this; },
        async run() { return { success: true }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
  };
  const env = { DB: realDb, value: 7 };
  const trusted = withTrustedTelegramMigrations(env);

  await trusted.DB.prepare('CREATE TABLE IF NOT EXISTS x (id INTEGER)').run();
  await trusted.DB.prepare('CREATE INDEX IF NOT EXISTS idx_x ON x(id)').run();
  await trusted.DB.prepare('ALTER TABLE x ADD COLUMN name TEXT').run();
  await trusted.DB.prepare('SELECT 1').first();

  assert.deepEqual(queries, ['SELECT 1']);
  assert.equal(trusted.value, 7);
  assert.equal(trusted.DB === realDb, false);
});

test('trusted Telegram DB proxy is stable per real D1 binding so existing schema caches stay warm', async () => {
  const { withTrustedTelegramMigrations } = await import('../dist-runtime/telegram-migration-trust.js');
  const db = { prepare() { throw new Error('unused'); } };
  const first = withTrustedTelegramMigrations({ DB: db });
  const second = withTrustedTelegramMigrations({ DB: db });
  assert.equal(first.DB, second.DB);
});

test('production Telegram dispatcher passes migration-trusted env only to interactive app routes', async () => {
  const source = await read('src/live-entry-v2.ts');
  assert.match(source, /withTrustedTelegramMigrations/);
  assert.match(source, /case 'notifications':[\s\S]*?withTrustedTelegramMigrations\(env\)/);
  assert.match(source, /case 'proposal':[\s\S]*?withTrustedTelegramMigrations\(env\)/);
  assert.match(source, /case 'generic-private-text':[\s\S]*?withTrustedTelegramMigrations\(env\)/);
});

test('production migrations own the schemas that trusted interactive handlers assume exist', async () => {
  const migrations = await Promise.all([
    'migrations/0011_ranobelib_telegram_subscriptions.sql',
    'migrations/0012_telegram_notifications_v2.sql',
    'migrations/0013_telegram_title_proposals.sql',
    'migrations/0016_telegram_notification_delivery_modes.sql',
    'migrations/0017_telegram_text_bot_ux_v2.sql',
  ].map(read));
  const sql = migrations.join('\n');
  for (const required of [
    'telegram_subscription_settings',
    'title_subscriptions',
    'title_subscription_exclusions',
    'telegram_proposal_sessions',
    'telegram_title_delivery_settings',
    'telegram_notification_input_state',
    'telegram_notification_search_state',
    'return_to_review',
    'input_active',
  ]) {
    assert.match(sql, new RegExp(required));
  }
});
