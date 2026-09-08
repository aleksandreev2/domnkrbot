import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadSchema() {
  return import('../dist-runtime/telegram-text-bot-ux-schema.js');
}

const normalize = (value) => value.replace(/\s+/g, ' ').trim();

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
  }
  bind() { return this; }
  async run() {
    this.db.queries.push(this.query);
    if (this.db.duplicateReturnColumn && /ALTER TABLE telegram_proposal_sessions ADD COLUMN return_to_review/i.test(this.query)) {
      throw new Error('duplicate column name: return_to_review');
    }
    return { meta: { changes: 0 } };
  }
}

class DB {
  constructor({ duplicateReturnColumn = false } = {}) {
    this.queries = [];
    this.duplicateReturnColumn = duplicateReturnColumn;
  }
  prepare(query) { return new Statement(this, query); }
}

test('0017 is forward-only and adds proposal review-return plus notification search state', async () => {
  const sql = await readFile(new URL('../migrations/0017_telegram_text_bot_ux_v2.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE telegram_proposal_sessions ADD COLUMN return_to_review INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /CREATE TABLE telegram_notification_search_state/i);
  assert.match(sql, /return_scope TEXT NOT NULL DEFAULT 'home'/i);
  assert.match(sql, /CHECK \(return_scope IN \('home', 'mine', 'all'\)\)/i);
  assert.match(sql, /CREATE INDEX idx_telegram_notification_search_expiry/i);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+(?:TABLE|COLUMN|TO)\b/i);
});

test('runtime UX schema repair creates search state without touching delivery triggers', async () => {
  const { ensureTelegramTextBotUxSchema } = await loadSchema();
  const db = new DB();
  await ensureTelegramTextBotUxSchema({ DB: db });
  assert.ok(db.queries.some((query) => /ALTER TABLE telegram_proposal_sessions ADD COLUMN return_to_review/i.test(query)));
  assert.ok(db.queries.some((query) => /CREATE TABLE IF NOT EXISTS telegram_notification_search_state/i.test(query)));
  assert.ok(db.queries.some((query) => /CREATE INDEX IF NOT EXISTS idx_telegram_notification_search_expiry/i.test(query)));
  assert.equal(db.queries.some((query) => /TRIGGER/i.test(query)), false);
});

test('runtime UX schema repair tolerates an already-existing return_to_review column', async () => {
  const { ensureTelegramTextBotUxSchema } = await loadSchema();
  const db = new DB({ duplicateReturnColumn: true });
  await assert.doesNotReject(() => ensureTelegramTextBotUxSchema({ DB: db }));
  assert.ok(db.queries.some((query) => /CREATE TABLE IF NOT EXISTS telegram_notification_search_state/i.test(query)));
});
