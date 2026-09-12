import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('collections page exposes a real create form instead of a CRUD placeholder', async () => {
  const html = await read('../public/collections/index.html');
  assert.match(html, /id="collectionForm"/);
  assert.match(html, /id="collectionTitle"/);
  assert.match(html, /id="collectionDescription"/);
  assert.match(html, /id="collectionPublic"/);
  assert.match(html, /id="collectionSubmit"/);
  assert.doesNotMatch(html, /после подключения серверного CRUD/i);
});

test('collections client reads API tabs and posts authenticated collection creation', async () => {
  const js = await read('../public/collections.js');
  assert.match(js, /api\('\/api\/collections'\)/);
  assert.match(js, /api\('\/api\/collections\?mine=1'\)/);
  assert.match(js, /api\('\/api\/collections',\{method:'POST'/);
  assert.match(js, /renderCollections/);
  assert.match(js, /collection-card/);
  assert.doesNotMatch(js, /После подключения CRUD|Форма создания появится/);
});

test('collections cards and create form remain responsive', async () => {
  const css = await read('../public/collections.css');
  assert.match(css, /\.collection-card\s*\{/);
  assert.match(css, /\.collection-form\s*\{/);
  assert.match(css, /\.collection-form-error\s*\{/);
});
