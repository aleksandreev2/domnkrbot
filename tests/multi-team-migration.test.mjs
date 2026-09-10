import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const normalize = (value) => value.replace(/\s+/g, ' ').trim();

async function migrationSql() {
  return readFile(new URL('../migrations/0023_multi_team_notifications.sql', import.meta.url), 'utf8');
}

test('0023 is additive and keeps the legacy delivery path available for rollback', async () => {
  const sql = await migrationSql();
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranobelib_teams/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranobelib_team_translations/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranobelib_chapter_branches/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranobelib_release_teams/i);
  assert.doesNotMatch(sql, /CREATE\s+TRIGGER\s+trg_ranobelib_release_notifications/i);
});

test('0023 seeds exactly the Дом Некроманта identity used by the current production scanner', async () => {
  const sql = normalize(await migrationSql());
  assert.match(sql, /11969--dom-nekromanta/);
  assert.match(sql, /'Дом Некроманта'/);
  assert.match(sql, /is_primary INTEGER NOT NULL DEFAULT 0 CHECK \(is_primary IN \(0, 1\)\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ranobelib_one_primary_team ON ranobelib_teams\(is_primary\) WHERE is_primary = 1/i);
  assert.match(sql, /VALUES \( 11969, '11969--dom-nekromanta', 'Дом Некроманта', 1, 'published' \)/i);
});

test('legacy all_titles migrates only into a primary-team subscription', async () => {
  const sql = normalize(await migrationSql());
  assert.match(sql, /INSERT OR IGNORE INTO telegram_team_subscriptions \(user_telegram_id, team_id, created_at\)/i);
  assert.match(sql, /FROM telegram_subscription_settings s CROSS JOIN ranobelib_teams p WHERE p\.is_primary = 1 AND s\.all_titles = 1/i);
  assert.doesNotMatch(sql, /telegram_team_subscriptions[\s\S]{0,500}WHERE\s+s\.all_titles\s*=\s*1\s*;[\s\S]{0,100}INSERT[\s\S]*lifecycle_state\s*=\s*'published'/i);
});

test('legacy title subscriptions, exclusions and delivery overrides become team-title scoped', async () => {
  const sql = normalize(await migrationSql());
  assert.match(sql, /INSERT OR IGNORE INTO telegram_team_title_subscriptions/i);
  assert.match(sql, /FROM title_subscriptions s CROSS JOIN ranobelib_teams p JOIN ranobelib_team_translations tt ON tt\.team_id = p\.id AND tt\.book_ref = s\.book_ref WHERE p\.is_primary = 1/i);
  assert.match(sql, /INSERT OR IGNORE INTO telegram_team_title_exclusions/i);
  assert.match(sql, /FROM title_subscription_exclusions e CROSS JOIN ranobelib_teams p JOIN ranobelib_team_translations tt ON tt\.team_id = p\.id AND tt\.book_ref = e\.book_ref WHERE p\.is_primary = 1/i);
  assert.match(sql, /INSERT OR IGNORE INTO telegram_team_title_delivery_settings/i);
  assert.match(sql, /FROM telegram_title_delivery_settings d CROSS JOIN ranobelib_teams p JOIN ranobelib_team_translations tt ON tt\.team_id = p\.id AND tt\.book_ref = d\.book_ref WHERE p\.is_primary = 1/i);
});

test('team-title delivery settings preserve instant and stack constraints without adding team-wide mode', async () => {
  const sql = normalize(await migrationSql());
  assert.match(sql, /delivery_mode TEXT NOT NULL CHECK \(delivery_mode IN \('instant', 'stack'\)\)/i);
  assert.match(sql, /delivery_mode = 'stack' AND stack_size BETWEEN 2 AND 100/i);
  assert.doesNotMatch(sql, /telegram_team_delivery_settings/i);
});

test('rollout switches default to fully disabled and are independent', async () => {
  const sql = normalize(await migrationSql());
  for (const key of [
    'ranobelib_multi_team_shadow',
    'ranobelib_multi_team_delivery',
    'ranobelib_multi_team_ui',
  ]) {
    assert.match(sql, new RegExp(`'${key}', '0'`));
  }
});

test('onboarding persistence only accepts explicit successful completion reasons', async () => {
  const sql = normalize(await migrationSql());
  assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_notification_onboarding/i);
  assert.match(sql, /completion_reason IN \('team_selected', 'not_now'\)/i);
  assert.match(sql, /completed_at IS NULL AND completion_reason IS NULL/i);
  assert.match(sql, /completed_at IS NOT NULL AND completion_reason IS NOT NULL/i);
});

test('branch storage has branch-aware identity and normalized team mapping', async () => {
  const sql = normalize(await migrationSql());
  assert.match(sql, /PRIMARY KEY \(book_ref, chapter_id, branch_key\)/i);
  assert.match(sql, /identity_confidence IN \('native', 'fallback', 'ambiguous'\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranobelib_chapter_branch_teams/i);
  assert.match(sql, /PRIMARY KEY \(book_ref, chapter_id, branch_key, team_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranobelib_release_teams/i);
  assert.match(sql, /PRIMARY KEY \(release_id, team_id\)/i);
});
