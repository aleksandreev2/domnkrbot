import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('BotFather configuration exposes the complete Telegram command surface with /start as the main menu', async () => {
  const configure = await read('scripts/configure-bot.mjs');
  for (const command of ['start', 'propose', 'subscriptions', 'notifications', 'site', 'help']) {
    assert.match(configure, new RegExp(`command:\\s*['\"]${command}['\"]`), `missing /${command}`);
  }
  assert.match(configure, /command:\s*'start'[^\n]+(?:Главн|меню)/i);
  assert.match(configure, /allowed_updates:\s*\['message',\s*'callback_query',\s*'chat_member'\]/);
});

test('README documents Telegram proposal wizard, document RAW limits, and the website fallback', async () => {
  const readme = await read('README.md');
  assert.match(readme, /\/start[^\n]*(?:главн|меню)/i);
  assert.match(readme, /\/propose/i);
  assert.match(readme, /RanobeLib/i);
  assert.match(readme, /внешн/i);
  assert.match(readme, /RAW/i);
  assert.match(readme, /20\s*MiB/i);
  for (const ext of ['.epub', '.txt', '.zip', '.fb2', '.docx']) assert.ok(readme.includes(ext), `README must mention ${ext}`);
  assert.match(readme, /сайт/i);
});

test('proposal migration 0013 is forward-only and contains no destructive schema statements', async () => {
  const migration = await read('migrations/0013_telegram_title_proposals.sql');
  assert.match(migration, /ALTER TABLE chapter_proposals ADD COLUMN source_kind/);
  assert.match(migration, /ALTER TABLE chapter_proposals ADD COLUMN ranobelib_book_ref/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS telegram_proposal_sessions/);
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(migration, /\bRENAME\s+(?:TABLE|COLUMN|TO)\b/i);
});
