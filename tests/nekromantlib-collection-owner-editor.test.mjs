import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('collection detail exposes owner-only edit and delete controls', async () => {
  const html = await read('../public/collection/index.html');
  assert.match(html, /id="editCollectionButton"/);
  assert.match(html, /id="editCollectionDialog"/);
  assert.match(html, /id="editCollectionForm"/);
  assert.match(html, /id="editCollectionTitle"/);
  assert.match(html, /id="editCollectionDescription"/);
  assert.match(html, /id="editCollectionPublic"/);
  assert.match(html, /id="deleteCollectionButton"/);
});

test('owner editor uses existing PATCH and DELETE collection API and can update item group metadata', async () => {
  const js = await read('../public/collection.js');
  assert.match(js, /method:'PATCH'/);
  assert.match(js, /method:'DELETE'/);
  assert.match(js, /editCollectionForm/);
  assert.match(js, /deleteCollectionButton/);
  assert.match(js, /data-edit-ref/);
  assert.match(js, /editItemGroup/);
  assert.match(js, /editItemNote/);
  assert.match(js, /\/items`/);
});

test('owner editor controls remain compact and responsive', async () => {
  const css = await read('../public/collection.css');
  assert.match(css, /\.collection-owner-menu\s*\{/);
  assert.match(css, /\.collection-edit-form\s*\{/);
  assert.match(css, /\.collection-item-edit\s*\{/);
});
