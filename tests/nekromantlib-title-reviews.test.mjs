import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title reviews migration keeps one editable review per Telegram user and title with native votes', async () => {
  const sql = await read('../migrations/0036_web_title_reviews.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_reviews/i);
  assert.match(sql, /book_ref TEXT NOT NULL/i);
  assert.match(sql, /author_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /body TEXT NOT NULL/i);
  assert.match(sql, /deleted_at TEXT/i);
  assert.match(sql, /UNIQUE\s*\(book_ref,\s*author_telegram_id\)/i);
  assert.match(sql, /REFERENCES ranobelib_titles\(book_ref\) ON DELETE CASCADE/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_review_votes/i);
  assert.match(sql, /CHECK\s*\(value IN \(-1,\s*1\)\)/i);
  assert.match(sql, /PRIMARY KEY \(review_id, voter_telegram_id\)/i);
});

test('title reviews API is title-scoped, editable by owner and protected by Telegram session', async () => {
  const source = await read('../src/web-title-reviews.ts');
  assert.match(source, /handleWebTitleReviewsApi/);
  assert.match(source, /\/api\/title\/reviews/);
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /isAdminUser\(env, user\)/);
  assert.match(source, /INSERT INTO users/i);
  assert.match(source, /ranobelib_titles/i);
  assert.match(source, /INSERT INTO web_title_reviews/i);
  assert.match(source, /UPDATE web_title_reviews[\s\S]*body\s*=\s*\?/i);
  assert.match(source, /UPDATE web_title_reviews[\s\S]*deleted_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(source, /INSERT INTO web_title_review_votes/i);
  assert.match(source, /DELETE FROM web_title_review_votes/i);
  assert.match(source, /SUM\(v\.value\)/i);
  assert.match(source, /REVIEW_MAX\s*=\s*6000/);
  assert.match(source, /sort === 'top'/);
  assert.match(source, /value !== -1 && value !== 0 && value !== 1/);
});

test('live v2 routes native title reviews before the base worker', async () => {
  const source = await read('../src/live-entry-v2.ts');
  assert.match(source, /handleWebTitleReviewsApi/);
  assert.match(source, /WebTitleReviewsEnv/);
  assert.match(source, /handleWebTitleReviewsApi\(request, env\)/);
  assert.match(source, /if \(titleReviewsResponse\) return titleReviewsResponse/);
});

test('title reviews tab exposes native review composer, filters and interaction hooks without seeded data', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title-reviews.js');
  const css = await read('../public/title-reviews.css');

  assert.match(html, /data-title-tab="reviews"(?![^>]*disabled)/);
  for (const text of ['Отзывы','Написать отзыв','Новые','Лучшие']) assert.match(html, new RegExp(text));
  for (const id of ['titleReviewsPanel','titleReviewForm','titleReviewText','titleReviewsList','titleReviewsMessage']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /\/api\/title\/reviews\?ref=/);
  assert.match(js, /renderTitleReviews/);
  assert.match(js, /myVote/);
  assert.match(js, /isOwn/);
  assert.match(js, /canDelete/);
  assert.match(js, /method:'POST'/);
  assert.match(js, /method:'PATCH'/);
  assert.match(js, /method:'DELETE'/);
  assert.match(js, /method:'PUT'/);
  assert.match(css, /\.title-reviews-shell\s*\{/);
  assert.match(css, /\.title-review-card\s*\{/);
  assert.match(css, /\.title-review-composer\s*\{/);
  assert.doesNotMatch(js, /Рыцарь в белых доспехах|fox1e|Обитель Лисьих Историй/);
});
