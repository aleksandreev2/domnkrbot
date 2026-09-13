import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('collection detail page exposes owner metadata, grouped items and add-title controls', async () => {
  const html = await read('../public/collection/index.html');
  assert.match(html, /<title>Коллекция · НекромантЛиб/);
  assert.match(html, /id="collectionTitle"/);
  assert.match(html, /id="collectionDescription"/);
  assert.match(html, /id="collectionOwner"/);
  assert.match(html, /id="collectionGroups"/);
  assert.match(html, /id="addTitleButton"/);
  assert.match(html, /id="addTitleDialog"/);
  assert.match(html, /id="titlePicker"/);
});

test('collection detail client loads collection, catalog candidates and posts real items', async () => {
  const js = await read('../public/collection.js');
  assert.match(js, /URLSearchParams\(location\.search\)/);
  assert.match(js, /\/api\/collections\/\$\{encodeURIComponent\(state\.id\)\}/);
  assert.match(js, /api\('\/api\/ranobelib'\)/);
  assert.match(js, /\/items`/);
  assert.match(js, /method:'POST'/);
  assert.match(js, /groupName/);
  assert.match(js, /renderGroups/);
});

test('collection list cards link to detail page and detail is responsive', async () => {
  const listJs = await read('../public/collections.js');
  const css = await read('../public/collection.css');
  assert.match(listJs, /\/collection\/\?id=/);
  assert.match(css, /\.collection-detail-grid\s*\{/);
  assert.match(css, /\.collection-group\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
});
