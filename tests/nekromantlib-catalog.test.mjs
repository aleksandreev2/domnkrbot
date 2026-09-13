import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('catalog route exposes the RanobeLib-like catalog shell', async () => {
  const html = await read('../public/catalog/index.html');
  assert.match(html, /<title>Каталог · НекромантЛиб/);
  assert.match(html, />НекромантЛиб</);
  assert.match(html, /id="catalogSearch"/);
  assert.match(html, /id="catalogGrid"/);
  assert.match(html, /id="catalogCount"/);
  assert.match(html, /id="catalogFilters"/);
  assert.match(html, /id="chaptersMin"/);
  assert.match(html, /id="chaptersMax"/);
  assert.match(html, /id="catalogSort"/);
  assert.match(html, /id="catalogDirection"/);
  assert.match(html, /id="applyFilters"/);
  assert.match(html, /id="resetFilters"/);
  assert.match(html, />Жанры</);
  assert.match(html, />Теги</);
  assert.match(html, />Статус перевода</);
});

test('home points its catalog navigation at the dedicated catalog route', async () => {
  const html = await read('../public/index.html');
  assert.match(html, /href="\/catalog\/"[^>]*>Каталог</);
});

test('catalog behavior uses real APIs and URL-backed supported filters', async () => {
  const js = await read('../public/catalog.js');
  assert.match(js, /\/api\/ranobelib/);
  assert.match(js, /\/api\/bootstrap/);
  for (const param of ['q','sort','dir','chaptersMin','chaptersMax']) assert.match(js, new RegExp(param));
  assert.match(js, /history\.replaceState/);
  assert.match(js, /popstate/);
  assert.match(js, /sort==='updated'|sort === 'updated'/);
  assert.match(js, /sort==='chapters'|sort === 'chapters'/);
  assert.match(js, /sort==='title'|sort === 'title'/);
  assert.doesNotMatch(js, /Math\.random\(|fakeRating|fakePopularity/);
});

test('catalog styling has desktop sidebar and mobile filter sheet', async () => {
  const css = await read('../public/catalog.css');
  assert.match(css, /\.catalog-layout\s*\{[^}]*grid-template-columns/s);
  assert.match(css, /\.catalog-grid\s*\{[^}]*display\s*:\s*grid/s);
  assert.match(css, /\.catalog-filter-panel\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /position\s*:\s*fixed/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
  assert.match(css, /:focus-visible/);
});
