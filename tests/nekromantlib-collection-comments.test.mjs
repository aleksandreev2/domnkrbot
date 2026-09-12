import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('collection comments migration is owner-safe and cascades with the collection', async () => {
  const sql = await read('../migrations/0031_web_collection_comments.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_collection_comments/i);
  assert.match(sql, /collection_id TEXT NOT NULL/i);
  assert.match(sql, /author_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /FOREIGN KEY \(collection_id\) REFERENCES web_collections\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /FOREIGN KEY \(author_telegram_id\) REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
});

test('comments API supports public reads, authenticated posting and author-or-collection-owner deletion', async () => {
  const source = await read('../src/web-collection-comments.ts');
  assert.match(source, /listCollectionComments/);
  assert.match(source, /handleCollectionCommentsMutation/);
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /INSERT INTO web_collection_comments/i);
  assert.match(source, /DELETE FROM web_collection_comments/i);
  assert.match(source, /author_telegram_id\s*=\s*\?/i);
  assert.match(source, /owner_telegram_id\s*=\s*\?/i);
});

test('collections router exposes the comments child route', async () => {
  const source = await read('../src/web-collections.ts');
  assert.match(source, /kind: 'collection' \| 'items' \| 'comments'/);
  assert.match(source, /parts\[1\] !== 'items'.*parts\[1\] !== 'comments'/s);
  assert.match(source, /route\.kind === 'comments'/);
  assert.match(source, /listCollectionComments/);
  assert.match(source, /handleCollectionCommentsMutation/);
});

test('collection detail renders and posts real comments', async () => {
  const html = await read('../public/collection/index.html');
  const js = await read('../public/collection.js');
  const css = await read('../public/collection.css');
  assert.match(html, /id="collectionComments"/);
  assert.match(html, /id="commentForm"/);
  assert.match(html, /id="commentText"/);
  assert.match(html, /id="commentsCount"/);
  assert.match(js, /\/comments`/);
  assert.match(js, /renderComments/);
  assert.match(js, /commentForm/);
  assert.match(css, /\.collection-comments\s*\{/);
  assert.match(css, /\.collection-comment\s*\{/);
});
