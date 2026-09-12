import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [collections, items] = await Promise.all([
  readFile(new URL('../src/web-collections.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/web-collection-items.ts', import.meta.url), 'utf8'),
]);
const source = `${collections}\n${items}`;

test('collection detail loads real item/title metadata', () => {
  assert.match(source, /web_collection_items\s+i/i);
  assert.match(source, /JOIN ranobelib_titles\s+t/i);
  assert.match(source, /cover_url/i);
  assert.match(source, /group_name/i);
});

test('collection owner can add update and remove items through an items route', () => {
  assert.match(source, /route\.kind === 'items'/);
  assert.match(source, /INSERT INTO web_collection_items/i);
  assert.match(source, /UPDATE web_collection_items/i);
  assert.match(source, /DELETE FROM web_collection_items/i);
  assert.match(source, /request\.method === 'POST'/);
  assert.match(source, /request\.method === 'PATCH'/);
  assert.match(source, /request\.method === 'DELETE'/);
});

test('item mutations verify collection ownership before touching child rows', () => {
  assert.match(source, /WHERE id = \? AND owner_telegram_id = \?/i);
  assert.match(source, /requireOwnedCollection/);
  assert.doesNotMatch(source, /collection_id\s*=\s*\$\{/i);
});
