import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('collections route mirrors the application hierarchy without copied RanobeLib user data', async () => {
  const html = await read('../public/collections/index.html');
  assert.match(html, /<title>Коллекции · НекромантЛиб/);
  assert.match(html, />НекромантЛиб</);
  assert.match(html, /<h1[^>]*>Коллекции<\/h1>/);
  assert.match(html, /id="createCollection"/);
  assert.match(html, />Создать</);
  assert.match(html, />Новые</);
  assert.match(html, /id="collectionsList"/);
  assert.match(html, /id="accountName"/);
  assert.match(html, /id="telegramLogin"/);
  assert.match(html, /\/collections\.css\?v=/);
  assert.match(html, /\/collections\.js\?v=/);
  assert.doesNotMatch(html, /The Big Boobs Theory|Элементальная магия|SCP: Спецхран/);
});

test('collections shell uses bootstrap session and never calls a fake write endpoint', async () => {
  const js = await read('../public/collections.js');
  assert.match(js, /\/api\/bootstrap/);
  assert.match(js, /createCollection/);
  assert.match(js, /telegramLogin/);
  assert.doesNotMatch(js, /fetch\([^\n]*api\/collections[^\n]*method:\s*['"]POST/);
  assert.doesNotMatch(js, /Math\.random\(|fakeCollection/);
});

test('collections shell is responsive and uses a real list surface', async () => {
  const css = await read('../public/collections.css');
  assert.match(css, /\.collections-list\s*\{/);
  assert.match(css, /\.collections-empty\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
  assert.match(css, /:focus-visible/);
});
