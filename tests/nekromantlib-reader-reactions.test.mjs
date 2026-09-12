import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('reader reactions migration stores one native thanks and one 1-10 rating per Telegram user and chapter', async () => {
  const sql = await read('../migrations/0033_reader_chapter_reactions.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reader_chapter_thanks/i);
  assert.match(sql, /book_ref TEXT NOT NULL/i);
  assert.match(sql, /chapter_id INTEGER NOT NULL/i);
  assert.match(sql, /user_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /PRIMARY KEY \(book_ref, chapter_id, user_telegram_id\)/i);
  assert.match(sql, /FOREIGN KEY \(user_telegram_id\) REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reader_chapter_ratings/i);
  assert.match(sql, /rating INTEGER NOT NULL CHECK\(rating BETWEEN 1 AND 10\)/i);
  assert.match(sql, /PRIMARY KEY \(book_ref, chapter_id, user_telegram_id\)/i);
});

test('reader reactions API validates chapter scope and returns real aggregates plus viewer state', async () => {
  const source = await read('../src/web-reader-reactions.ts');
  assert.match(source, /handleWebReaderReactionsApi/);
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /INSERT INTO users/i);
  assert.match(source, /ranobelib_chapters/i);
  assert.match(source, /reader_chapter_thanks/i);
  assert.match(source, /reader_chapter_ratings/i);
  assert.match(source, /COUNT\(\*\)/i);
  assert.match(source, /AVG\(rating\)/i);
  assert.match(source, /rating < 1 \|\| rating > 10/);
  assert.match(source, /request\.method === 'GET'/);
  assert.match(source, /request\.method === 'PUT'/);
  assert.match(source, /DELETE FROM reader_chapter_thanks/i);
  assert.match(source, /ON CONFLICT\(book_ref, chapter_id, user_telegram_id\) DO UPDATE SET/i);
});

test('live v2 routes native reader reactions before base worker', async () => {
  const source = await read('../src/live-entry-v2.ts');
  assert.match(source, /handleWebReaderReactionsApi/);
  assert.match(source, /WebReaderReactionsEnv/);
  assert.match(source, /handleWebReaderReactionsApi\(request, env\)/);
  assert.match(source, /if \(readerReactionsResponse\) return readerReactionsResponse/);
});

test('reader closed reaction controls reproduce captured two-line states without copied counts', async () => {
  const html = await read('../public/reader/index.html');
  const js = await read('../public/reader.js');
  const css = await read('../public/reader.css');

  for (const id of ['readerThanksButton','readerThanksCount','readerRatingButton','readerRatingSummary','readerRatingPicker']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (let rating = 1; rating <= 10; rating += 1) assert.match(html, new RegExp(`data-rating="${rating}"`));
  assert.match(html, /Сказать спасибо/);
  assert.match(html, /поблагодарили/);
  assert.match(html, /Оценить перевод/);
  assert.match(html, /Средняя оценка:/);
  assert.doesNotMatch(html, /поблагодарили 323|Средняя оценка:\s*7\.0\s*\(9\)/);

  assert.match(js, /loadReaderReactions/);
  assert.match(js, /\/api\/reader\/reactions\?ref=/);
  assert.match(js, /\/api\/reader\/reactions\/thanks/);
  assert.match(js, /\/api\/reader\/reactions\/rating/);
  assert.match(js, /myRating/);
  assert.match(js, /thanked/);
  assert.match(css, /\.reader-thanks-button\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /\.reader-reaction-subline\s*\{[^}]*font-size:\s*11px/is);
  assert.match(css, /\.reader-rating-button\s*\{[^}]*min-height:\s*44px/is);
});
