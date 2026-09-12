import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title page uses the NekromantLib shell and exposes real title detail regions', async () => {
  const html = await read('../public/title/index.html');
  assert.match(html, /<title>Тайтл · НекромантЛиб/);
  assert.match(html, /class="nl-body title-detail-body"/);
  assert.match(html, /href="\/nekromantlib\.css/);
  assert.match(html, /href="\/title\.css/);
  assert.match(html, />НекромантЛиб</);
  assert.match(html, /id="titleCover"/);
  assert.match(html, /id="titleName"/);
  assert.match(html, /id="titleDescription"/);
  assert.match(html, /id="titleChapterCount"/);
  assert.match(html, /id="titleLatest"/);
  assert.match(html, /id="titleUpdated"/);
  assert.match(html, /id="readerStatus"/);
  assert.match(html, /id="chapterList"/);
  assert.match(html, /id="chapterSearch"/);
  assert.match(html, /id="sortNew"/);
  assert.match(html, /id="sortOld"/);
  assert.doesNotMatch(html, /<span>Дом<br>Некроманта<\/span>/);
});

test('title client preserves real API/session/reader behavior under NekromantLib branding', async () => {
  const js = await read('../public/title.js');
  assert.match(js, /api\('\/api\/auth\/session'\)/);
  assert.match(js, /api\(`\/api\/title\?ref=\$\{encodeURIComponent\(ref\)\}`\)/);
  assert.match(js, /document\.title=`\$\{title\.title\|\|'Тайтл'\} · НекромантЛиб`/);
  assert.match(js, /renderProgress/);
  assert.match(js, /renderChapters/);
  assert.match(js, /readerUrl/);
  assert.match(js, /localStorage/);
  assert.match(js, /readerAvailable/);
  assert.match(js, /chapter-row/);
});

test('chapter list follows the flat RanobeLib title-tab hierarchy without fake download actions', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title.js');
  assert.match(html, /class="chapter-sort-menu"/);
  assert.match(html, />Сортировать</);
  assert.doesNotMatch(html, />Скачать</);
  assert.match(js, /chapter-row-copy/);
  assert.match(js, /chapter-row-prefix/);
  assert.match(js, /chapter-row-name/);
  assert.doesNotMatch(js, /class="volume-block"/);
});

test('title detail has isolated responsive parity styles', async () => {
  const css = await read('../public/title.css');
  assert.match(css, /\.title-detail-layout\s*\{/);
  assert.match(css, /\.title-detail-hero\s*\{/);
  assert.match(css, /\.title-meta-grid\s*\{/);
  assert.match(css, /\.title-tabs\s*\{/);
  assert.match(css, /\.chapter-sort-menu\s*\{/);
  assert.match(css, /\.chapter-row-copy\s*\{/);
  assert.match(css, /\.chapter-row\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});
