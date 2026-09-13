import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('NekromantLib home exposes the captured library shell and removes the legacy marketing hero', async () => {
  const html = await read('../public/index.html');
  assert.match(html, /<title>НекромантЛиб/);
  assert.match(html, />НекромантЛиб</);
  assert.match(html, />Каталог</);
  assert.match(html, />Поиск</);
  for (const id of ['popularUpdates','continueReadingRail','topViewsNew','topViewsRising','topViewsPopular','releaseFeed','forumRail','reviewsRail','collectionsRail','topUsersRail','newestRail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="adminLink" class="admin-entry hidden"/);
  assert.match(html, /id="telegramLogin"/);
  assert.match(html, /\/nekromantlib\.css\?v=/);
  assert.match(html, /\/home-parity\.js\?v=/);
  assert.doesNotMatch(html, /<script[^>]+\/site\.js\?/);
  assert.doesNotMatch(html, /id="hero"|ГЛАВНЫЙ ПЕРЕВОД|Истории, которые мы переводим сами/);
});

test('NekromantLib home keeps data and authentication contracts in its single renderer', async () => {
  const js = await read('../public/home-parity.js');
  assert.match(js, /api\('\/api\/bootstrap'/);
  assert.match(js, /api\('\/api\/ranobelib'/);
  assert.match(js, /api\('\/api\/home\/social'/);
  assert.match(js, /\/auth\/logout/);
  assert.match(js, /\/auth\/telegram\/callback/);
  assert.match(js, /#releaseFeed/);
  assert.match(js, /#continueReadingRail/);
  assert.match(js, /#forumRail/);
  assert.match(js, /#reviewsRail/);
  assert.match(js, /#collectionsRail/);
  assert.match(js, /#topUsersRail/);
  assert.doesNotMatch(js, /renderHero|heroBackdrop|heroTitle|heroCover/);
});

test('NekromantLib shell keeps responsive covers, keyboard focus and reduced-motion behavior', async () => {
  const css = `${await read('../public/nekromantlib.css')}\n${await read('../public/ranobelib-parity.css')}\n${await read('../public/home-parity.css')}`;
  assert.match(css, /\.home-reference-grid\s*\{/);
  assert.match(css, /\.release-feed\s*\{/);
  assert.match(css, /\.home-cover-media\s*\{[^}]*padding-top\s*:\s*140%/s);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*(?:650|720)px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
});
