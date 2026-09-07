import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

test('notifications v3 uses a six-title fast scan batch and deterministic adaptive cadence', async () => {
  const scanner = await loadScanner();
  assert.equal(scanner.FAST_SCAN_LIMIT, 6);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: true, consecutiveNoChange: 9 }), 1);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 1 }), 3);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 2 }), 3);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 4 }), 10);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 8 }), 20);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 20 }), 30);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, failed: true }), 10);
});

test('selectDueTitles reads only active snapshot-ready due titles with a hard six-title cap', async () => {
  const scanner = await loadScanner();
  const calls = [];
  const rows = Array.from({ length: 8 }, (_, index) => ({
    book_ref: `${index + 1}--book-${index + 1}`,
    url: `https://ranobelib.me/ru/book/${index + 1}--book-${index + 1}`,
    title: `Book ${index + 1}`,
    consecutive_no_change: index,
    last_change_at: null,
    next_check_at: '2026-09-07 08:00:00',
    scan_priority: 0,
  }));
  const env = {
    DB: {
      prepare(query) {
        const state = { query, values: [] };
        calls.push(state);
        return {
          bind(...values) {
            state.values = values;
            return this;
          },
          async all() {
            return { results: rows.slice(0, Number(state.values.at(-1)) || rows.length) };
          },
        };
      },
    },
  };

  const result = await scanner.selectDueTitles(env);
  assert.equal(result.length, 6);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /is_active\s*=\s*1/i);
  assert.match(calls[0].query, /snapshot_ready\s*=\s*1/i);
  assert.match(calls[0].query, /next_check_at\s+IS\s+NULL|next_check_at\s*<=\s*CURRENT_TIMESTAMP/i);
  assert.match(calls[0].query, /ORDER BY[\s\S]*next_check_at[\s\S]*scan_priority/i);
  assert.match(calls[0].query, /LIMIT\s*\?/i);
  assert.equal(calls[0].values.at(-1), 6);
});

test('migration 0014 adds only forward scheduler/outbox indexes and no destructive table operations', () => {
  const sql = readFileSync(new URL('../migrations/0014_telegram_notifications_v3.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN next_check_at TEXT/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN last_change_at TEXT/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN consecutive_no_change INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN scan_priority INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /idx_ranobelib_titles_due_scan/i);
  assert.match(sql, /idx_ranobelib_notification_due_v3/i);
  assert.doesNotMatch(sql, /DROP\s+TABLE|ALTER\s+TABLE[^;]+RENAME/i);
});
