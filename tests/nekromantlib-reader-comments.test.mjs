import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('reader chapter comments migration preserves Telegram identity, reply topology and native votes', async () => {
  const sql = await read('../migrations/0032_reader_chapter_comments.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reader_chapter_comments/i);
  assert.match(sql, /id TEXT PRIMARY KEY/i);
  assert.match(sql, /book_ref TEXT NOT NULL/i);
  assert.match(sql, /chapter_id INTEGER NOT NULL/i);
  assert.match(sql, /author_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /parent_comment_id TEXT/i);
  assert.match(sql, /deleted_at TEXT/i);
  assert.match(sql, /FOREIGN KEY \(author_telegram_id\) REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
  assert.match(sql, /FOREIGN KEY \(parent_comment_id\) REFERENCES reader_chapter_comments\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reader_chapter_comment_votes/i);
  assert.match(sql, /PRIMARY KEY \(comment_id, voter_telegram_id\)/i);
  assert.match(sql, /CHECK\s*\(value IN \(-1,\s*1\)\)/i);
  assert.match(sql, /FOREIGN KEY \(comment_id\) REFERENCES reader_chapter_comments\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /FOREIGN KEY \(voter_telegram_id\) REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
});

test('reader comments handler uses established Telegram session and same-origin mutation security', async () => {
  const source = await read('../src/web-reader-comments.ts');
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /isAdminUser\(env, user\)/);
  assert.match(source, /INSERT INTO users/i);
  assert.match(source, /INSERT INTO reader_chapter_comments/i);
  assert.match(source, /UPDATE reader_chapter_comments[\s\S]*deleted_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(source, /INSERT INTO reader_chapter_comment_votes/i);
  assert.match(source, /DELETE FROM reader_chapter_comment_votes/i);
  assert.match(source, /SUM\(v\.value\)/i);
  assert.match(source, /parent_comment_id/i);
  assert.match(source, /COMMENT_MAX\s*=\s*3000/);
});

test('reader comments routes are chapter-scoped and reject unknown entities', async () => {
  const source = await read('../src/web-reader-comments.ts');
  assert.match(source, /\/api\/reader\/comments/);
  assert.match(source, /ranobelib_titles/i);
  assert.match(source, /ranobelib_chapters/i);
  assert.match(source, /book_ref\s*=\s*\?/i);
  assert.match(source, /chapter_id\s*=\s*\?/i);
  assert.match(source, /parent_comment_id/i);
  assert.match(source, /request\.method === 'GET'/);
  assert.match(source, /request\.method === 'POST'/);
  assert.match(source, /request\.method === 'DELETE'/);
  assert.match(source, /request\.method === 'PUT'/);
  assert.match(source, /value !== -1 && value !== 0 && value !== 1/);
});

test('live v2 routes native reader comments before falling through to the base worker', async () => {
  const source = await read('../src/live-entry-v2.ts');
  assert.match(source, /handleWebReaderCommentsApi/);
  assert.match(source, /WebReaderCommentsEnv/);
  assert.match(source, /handleWebReaderCommentsApi\(request, env\)/);
  assert.match(source, /if \(readerCommentsResponse\) return readerCommentsResponse/);
});
