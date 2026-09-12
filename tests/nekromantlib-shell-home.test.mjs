import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('NekromantLib home exposes the library shell and removes the legacy marketing hero', async () => {
  const html = await read('../public/index.html');
  assert.match(html, /<title>НекромантЛиб/);
  assert.match(html, />НекромантЛиб</);
  assert.match(html, />Каталог</);
  assert.match(html, />Поиск</);
  assert.match(html, /id="releaseFeed"/);
  assert.match(html, /id="titleGrid"/);
  assert.match(html, /id="proposalGrid"/);
  assert.match(html, /id="adminLink" class="admin-entry hidden"/);
  assert.match(html, /id="telegramLogin"/);
  assert.doesNotMatch(html, /id="hero"|ГЛАВНЫЙ ПЕРЕВОД|Истории, которые мы переводим сами/);
});

test('NekromantLib home keeps existing data and authentication contracts', async () => {
  const js = await read('../public/site.js');
  assert.match(js, /api\('\/api\/bootstrap'/);
  assert.match(js, /api\('\/api\/ranobelib'/);
  assert.match(js, /\/auth\/logout/);
  assert.match(js, /\/auth\/telegram\/callback/);
  assert.match(js, /#releaseFeed/);
  assert.match(js, /#titleGrid/);
  assert.doesNotMatch(js, /renderHero|heroBackdrop|heroTitle|heroCover/);
});

test('NekromantLib shell reserves responsive book covers and accessible mobile behavior', async () => {
  const css = await read('../public/site.css');
  assert.match(css, /\.nl-home-grid\s*\{/);
  assert.match(css, /\.release-feed\s*\{/);
  assert.match(css, /\.book-cover\s*\{[^}]*aspect-ratio\s*:/s);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
});
