import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title state migration stores one list/rating state per Telegram user and title', async () => {
  const sql = await read('../migrations/0034_web_title_state.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_user_state/i);
  assert.match(sql, /book_ref TEXT NOT NULL/i);
  assert.match(sql, /user_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /list_status TEXT/i);
  for (const status of ['reading','planned','dropped','completed','favorite','other']) assert.match(sql, new RegExp(`'${status}'`));
  assert.match(sql, /rating INTEGER CHECK\(rating BETWEEN 1 AND 10\)/i);
  assert.match(sql, /PRIMARY KEY \(book_ref, user_telegram_id\)/i);
  assert.match(sql, /REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
  assert.match(sql, /REFERENCES ranobelib_titles\(book_ref\) ON DELETE CASCADE/i);
});

test('title state API returns real aggregates and enforces Telegram same-origin mutations', async () => {
  const source = await read('../src/web-title-state.ts');
  assert.match(source, /handleWebTitleStateApi/);
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /INSERT INTO users/i);
  assert.match(source, /ranobelib_titles/i);
  assert.match(source, /web_title_user_state/i);
  assert.match(source, /AVG\(rating\)/i);
  assert.match(source, /COUNT\(\*\)/i);
  assert.match(source, /list_status/);
  assert.match(source, /rating < 1 \|\| rating > 10/);
  assert.match(source, /DELETE FROM web_title_user_state/i);
  assert.match(source, /ON CONFLICT\(book_ref, user_telegram_id\) DO UPDATE SET/i);
});

test('live v2 routes native title state before base worker', async () => {
  const source = await read('../src/live-entry-v2.ts');
  assert.match(source, /handleWebTitleStateApi/);
  assert.match(source, /WebTitleStateEnv/);
  assert.match(source, /handleWebTitleStateApi\(request, env\)/);
  assert.match(source, /if \(titleStateResponse\) return titleStateResponse/);
});

test('title UI progressively enables captured plan and rating controls from native state', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title.js');
  const css = await read('../public/title.css');

  for (const id of ['titlePlanButton','titlePlanMenu','titleRatingValue','titleRatingVotes','titleMyRatingButton','titleRatingPicker','titleListTotal','titleListStats']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const status of ['reading','planned','dropped','completed','favorite','other']) assert.match(html, new RegExp(`data-list-status="${status}"`));
  for (let rating = 1; rating <= 10; rating += 1) assert.match(html, new RegExp(`data-title-rating="${rating}"`));
  assert.match(js, /\/api\/title\/state\?ref=/);
  assert.match(js, /\/api\/title\/state\/list/);
  assert.match(js, /\/api\/title\/state\/rating/);
  assert.match(js, /renderTitleState/);
  assert.match(js, /myListStatus/);
  assert.match(js, /myRating/);
  assert.match(css, /\.title-plan-menu\s*\{/);
  assert.match(css, /\.title-rating-picker\s*\{/);
  assert.match(css, /\.title-list-stats\s*\{/);
  assert.doesNotMatch(html, /В списках у\s*26|Моя оценка:\s*10|>10\s+1</);
});
