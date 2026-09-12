import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('reader shell mirrors the captured RanobeLib reading surface', async () => {
  const html = await read('../public/reader/index.html');

  assert.match(html, /<title>Читалка · НекромантЛиб<\/title>/);
  assert.match(html, /href="\/reader\.css\?v=/);
  assert.match(html, /id="readerBack"/);
  assert.match(html, /id="readerBookTitle"/);
  assert.match(html, /id="readerChapterShort"/);
  assert.match(html, /id="contentsButton"/);
  assert.match(html, /id="settingsButton"/);
  assert.match(html, /id="readerChapterList"/);
  assert.match(html, /id="readerChapters"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="readerSettings"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, />Список глав</);
  assert.match(html, />Настройки</);
  assert.doesNotMatch(html, /class="reader-paper"/);
});

test('reader settings expose the controls visible in the captured RanobeLib settings panel', async () => {
  const html = await read('../public/reader/index.html');
  for (const label of [
    'Цветовая тема',
    'Цвет фона',
    'Цвет текста',
    'Отступ',
    'Выравнивание текста',
    'Шрифт',
    'Размер шрифта',
    'Высота строк',
    'Отступ между абзацами',
    'Ширина контейнера',
  ]) assert.match(html, new RegExp(label));
});

test('reader client keeps real chapter delivery/progress and loads a real contents list', async () => {
  const js = await read('../public/reader.js');

  assert.match(js, /api\(`\/api\/reader\/chapter\?ref=\$\{encodeURIComponent\(ref\)\}&chapter=\$\{encodeURIComponent\(chapter\)\}`\)/);
  assert.match(js, /api\(`\/api\/title\?ref=\$\{encodeURIComponent\(ref\)\}`\)/);
  assert.match(js, /domnkr:reader:\$\{ref\}:read/);
  assert.match(js, /domnkr:reader:\$\{ref\}:last/);
  assert.match(js, /readerChapterList/);
  assert.match(js, /renderChapterList/);
  assert.match(js, /readerChapters/);
  assert.match(js, /readerSettings/);
});

test('reader parity stylesheet preserves captured default geometry and colors', async () => {
  const css = await read('../public/reader.css');

  assert.match(css, /--reader-background:\s*#434751/i);
  assert.match(css, /--reader-text:\s*#dbdbdb/i);
  assert.match(css, /--reader-header:\s*#555862/i);
  assert.match(css, /--reader-font-size:\s*24px/i);
  assert.match(css, /--reader-line-height:\s*1\.7/);
  assert.match(css, /--reader-max-width:\s*47%/);
  assert.match(css, /--reader-block-offset:\s*5px/i);
  assert.match(css, /--reader-text-indent:\s*\.875em/i);
  assert.match(css, /\.reader-topbar\s*\{[^}]*position:\s*sticky[^}]*height:\s*48px/is);
  assert.match(css, /\.reader-popup-panel\s*\{[^}]*max-width:\s*440px/is);
  assert.match(css, /\.reader-popup-overlay\s*\{[^}]*rgba\(0,\s*0,\s*0,\s*\.6\)/is);
  assert.match(css, /@media\s*\(max-width:\s*650px\)[^{]*\{[\s\S]*?min-width:\s*90vw/i);
});
