import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('reader lower surface keeps captured RanobeLib ordering and labels', async () => {
  const html = await read('../public/reader/index.html');
  const chapterEnd = html.indexOf('</article>');
  const work = html.indexOf('id="readerWorkCredit"');
  const rating = html.indexOf('id="readerTranslationRating"');
  const nav = html.indexOf('class="reader-bottom-nav"');
  const comments = html.indexOf('id="readerComments"');

  assert.ok(chapterEnd >= 0 && work > chapterEnd && rating > work && nav > rating && comments > nav,
    'chapter -> workers -> rating -> bottom nav -> comments ordering must match capture');
  for (const text of ['Над главой работали', 'Дом Некроманта', 'Поддержать', 'Оценить перевод', 'Новые', 'Настройки', 'Правила', 'Написать комментарий...']) {
    assert.match(html, new RegExp(text));
  }
  for (const id of ['readerCommentForm', 'readerCommentText', 'readerCommentsList', 'readerCommentsMessage', 'readerReplyTarget']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('reader comments client uses native auth/comments/replies/votes without seeded social data', async () => {
  const js = await read('../public/reader.js');
  assert.match(js, /api\('\/api\/auth\/session'\)/);
  assert.match(js, /\/api\/reader\/comments\?ref=/);
  assert.match(js, /method:'POST'/);
  assert.match(js, /method:'DELETE'/);
  assert.match(js, /method:'PUT'/);
  assert.match(js, /parentCommentId/);
  assert.match(js, /myVote/);
  assert.match(js, /canDelete/);
  assert.match(js, /renderComments/);
  assert.match(js, /renderComment/);
  assert.match(js, /mountCommentLogin/);
  assert.doesNotMatch(js, /Рыцарь в белых доспехах|fox1e|Обитель Лисьих Историй/);
});

test('reader lower surface preserves measured capture geometry', async () => {
  const css = await read('../public/reader.css');
  assert.match(css, /\.reader-work-row\s*\{[^}]*max-width:\s*930px[^}]*padding:\s*10px 16px/is);
  assert.match(css, /\.reader-comments-shell\s*\{[^}]*padding:\s*16px[^}]*max-width:\s*930px/is);
  assert.match(css, /\.reader-comments-form\s*\{[^}]*padding:\s*12px 0/is);
  assert.match(css, /\.reader-comment-head\s*\{[^}]*grid-template-columns:\s*24px auto auto auto/is);
  assert.match(css, /\.reader-comment-body\s*\{[^}]*padding:\s*10px 0/is);
  assert.match(css, /\.reader-comment-content\s*\{[^}]*margin-top:\s*10px[^}]*line-height:\s*1\.6/is);
});
