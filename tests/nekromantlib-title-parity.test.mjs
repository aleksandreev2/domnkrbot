import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title shell follows captured cover-actions-facts-header-tabs hierarchy', async () => {
  const html = await read('../public/title/index.html');

  for (const className of ['title-media-shell','title-cover-column','title-actions-stack','title-facts-paper','title-name-block','title-rating-slot','title-media-content']) {
    assert.match(html, new RegExp(`class="[^"]*${className}`));
  }
  assert.match(html, /id="continueReading"/);
  assert.match(html, /id="titlePlanButton"[^>]*disabled/);
  assert.match(html, />Добавить в планы</);

  const cover = html.indexOf('title-cover-column');
  const actions = html.indexOf('title-actions-stack');
  const facts = html.indexOf('title-facts-paper');
  const name = html.indexOf('title-name-block');
  const media = html.indexOf('title-media-content');
  assert.ok(cover >= 0 && actions > cover && facts > actions && name > facts && media > name,
    'DOM must preserve a deterministic captured hierarchy');
});

test('title tabs reproduce captured labels while unsupported title-level social tabs stay disabled', async () => {
  const html = await read('../public/title/index.html');
  const labels = ['О тайтле','Главы','Комментарии','Обсуждения','Отзывы'];
  let cursor = -1;
  for (const label of labels) {
    const next = html.indexOf(`>${label}<`, cursor + 1);
    assert.ok(next > cursor, `${label} must appear in captured order`);
    cursor = next;
  }
  assert.match(html, /data-title-tab="about"/);
  assert.match(html, /data-title-tab="chapters"[^>]*aria-selected="true"/);
  assert.match(html, />Комментарии<\/button>/);
  assert.match(html, /data-title-tab="comments"[^>]*disabled/);
  assert.match(html, /data-title-tab="discussions"[^>]*disabled/);
  assert.match(html, /data-title-tab="reviews"[^>]*disabled/);
  assert.doesNotMatch(html, />Скачать</);
});

test('title client switches only native panels and keeps synchronized title data', async () => {
  const js = await read('../public/title.js');
  assert.match(js, /activeTab:'chapters'/);
  assert.match(js, /setTitleTab/);
  assert.match(js, /\[data-title-tab\]/);
  assert.match(js, /#titleAboutPanel/);
  assert.match(js, /#titleChaptersPanel/);
  assert.match(js, /translation_status_label/);
  assert.match(js, /readerAvailable/);
  assert.match(js, /localStorage/);
  assert.doesNotMatch(js, /views|publisher|author|releaseYear|country/i);
});

test('title capture grid mirrors desktop and mobile structure without fake rating data', async () => {
  const html = await read('../public/title/index.html');
  const css = await read('../public/title.css');

  assert.match(html, /class="[^"]*title-rating-slot[^"]*"[^>]*aria-disabled="true"/);
  assert.match(html, />Рейтинг тайтла</);
  assert.doesNotMatch(html, /\b10\s+1\b|Просмотры\s+91|В списках у\s*26/);
  assert.match(css, /\.title-detail-layout\s*\{[^}]*grid-template-columns:\s*260px\s+minmax\(0,1fr\)\s+auto/is);
  assert.match(css, /grid-template-areas:\s*"cover header rate"\s*"cover content content"\s*"actions content content"\s*"facts content content"/is);
  assert.match(css, /column-gap:\s*30px/i);
  assert.match(css, /\.chapter-row\s*\{[^}]*min-height:\s*40px/is);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*\.title-detail-layout\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/is);
});
