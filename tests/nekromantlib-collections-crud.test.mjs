import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('collections migration persists owner-scoped collections with safe cascades', async () => {
  const sql = await read('../migrations/0030_web_collections.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_collections/i);
  assert.match(sql, /owner_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /FOREIGN KEY \(owner_telegram_id\) REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_collection_items/i);
  assert.match(sql, /FOREIGN KEY \(collection_id\) REFERENCES web_collections\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /UNIQUE\s*\(collection_id,\s*book_ref\)/i);
});

test('collections API requires Telegram session and same-origin writes and scopes mutations to owner', async () => {
  const source = await read('../src/web-collections.ts');
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /request\.method === 'POST'/);
  assert.match(source, /request\.method === 'PATCH'/);
  assert.match(source, /request\.method === 'DELETE'/);
  assert.match(source, /owner_telegram_id\s*=\s*\?/i);
  assert.match(source, /WHERE id = \?\s+AND owner_telegram_id = \?/i);
  assert.doesNotMatch(source, /owner_telegram_id\s*=\s*\$\{/i);
});

test('production entry dispatches collections API before the legacy base worker', async () => {
  const entry = await read('../src/live-entry-v2.ts');
  const importAt = entry.indexOf("from './web-collections.js'");
  const handlerAt = entry.indexOf('handleWebCollectionsApi(request, env)');
  const baseAt = entry.indexOf('return baseWorker.fetch');
  assert.ok(importAt >= 0, 'collections handler must be imported');
  assert.ok(handlerAt >= 0 && handlerAt < baseAt, 'collections handler must run before base worker');
});
