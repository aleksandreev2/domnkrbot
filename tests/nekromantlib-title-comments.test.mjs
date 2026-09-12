import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title comments migration keeps title scope, replies, votes, reports and pin state', async () => {
  const sql = await read('../migrations/0035_web_title_comments.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_comments/i);
  assert.match(sql, /book_ref TEXT NOT NULL/i);
  assert.match(sql, /author_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /parent_comment_id TEXT/i);
  assert.match(sql, /is_pinned INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /deleted_at TEXT/i);
  assert.match(sql, /REFERENCES ranobelib_titles\(book_ref\) ON DELETE CASCADE/i);
  assert.match(sql, /REFERENCES web_title_comments\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_comment_votes/i);
  assert.match(sql, /CHECK\s*\(value IN \(-1,\s*1\)\)/i);
  assert.match(sql, /PRIMARY KEY \(comment_id, voter_telegram_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_comment_reports/i);
  assert.match(sql, /UNIQUE \(comment_id, reporter_telegram_id\)/i);
  assert.doesNotMatch(sql, /chapter_id/i);
});

test('title comments API is title-scoped and protects every mutation', async () => {
  const source = await read('../src/web-title-comments.ts');
  assert.match(source, /handleWebTitleCommentsApi/);
  assert.match(source, /\/api\/title\/comments/);
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /isAdminUser\(env, user\)/);
  assert.match(source, /INSERT INTO users/i);
  assert.match(source, /ranobelib_titles/i);
  assert.match(source, /INSERT INTO web_title_comments/i);
  assert.match(source, /UPDATE web_title_comments[\s\S]*deleted_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(source, /INSERT INTO web_title_comment_votes/i);
  assert.match(source, /DELETE FROM web_title_comment_votes/i);
  assert.match(source, /INSERT INTO web_title_comment_reports/i);
  assert.match(source, /is_pinned/);
  assert.match(source, /parent_comment_id/i);
  assert.match(source, /SUM\(v\.value\)/i);
  assert.match(source, /COMMENT_MAX\s*=\s*3000/);
  assert.match(source, /sort === 'top'/);
  assert.match(source, /value !== -1 && value !== 0 && value !== 1/);
  assert.doesNotMatch(source, /chapter_id/i);
});

test('live v2 routes native title comments before the base worker', async () => {
  const source = await read('../src/live-entry-v2.ts');
  assert.match(source, /handleWebTitleCommentsApi/);
  assert.match(source, /WebTitleCommentsEnv/);
  assert.match(source, /handleWebTitleCommentsApi\(request, env\)/);
  assert.match(source, /if \(titleCommentsResponse\) return titleCommentsResponse/);
});

test('title comments tab exposes captured hierarchy and native interaction hooks', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title.js');
  const css = await read('../public/title.css');

  assert.match(html, /data-title-tab="comments"(?![^>]*disabled)/);
  for (const text of ['Новые','Настройки','Правила','Написать комментарий...']) assert.match(html, new RegExp(text));
  for (const id of ['titleCommentsPanel','titleCommentForm','titleCommentText','titleCommentsList','titleCommentsMessage','titleReplyTarget']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /\/api\/title\/comments\?ref=/);
  assert.match(js, /renderTitleComments/);
  assert.match(js, /parentCommentId/);
  assert.match(js, /myVote/);
  assert.match(js, /canDelete/);
  assert.match(js, /canPin/);
  assert.match(js, /canReport/);
  assert.match(js, /method:'POST'/);
  assert.match(js, /method:'DELETE'/);
  assert.match(js, /method:'PUT'/);
  assert.match(css, /\.title-comments-shell\s*\{/);
  assert.match(css, /\.title-comment-card\s*\{/);
  assert.match(css, /\.title-comment-composer\s*\{/);
  assert.doesNotMatch(js, /Рыцарь в белых доспехах|fox1e|Обитель Лисьих Историй/);
});
