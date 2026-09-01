import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migrationUrl = new URL('../migrations/0012_telegram_notifications_v2.sql', import.meta.url);

test('notifications v2 migration adds delivery mode, exclusions, and exclusion-aware release trigger', () => {
  assert.equal(fs.existsSync(migrationUrl), true, 'migrations/0012_telegram_notifications_v2.sql must exist');
  const sql = fs.readFileSync(migrationUrl, 'utf8');
  assert.match(sql, /ADD\s+COLUMN\s+delivery_mode\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'instant'/i);
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+title_subscription_exclusions/i);
  assert.match(sql, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_ranobelib_release_notifications/i);
  assert.match(sql, /NOT\s+EXISTS[\s\S]*title_subscription_exclusions[\s\S]*NEW\.book_ref/i);
});
