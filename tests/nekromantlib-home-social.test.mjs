import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('home exposes captured continue/forum/reviews/collections/top/newest areas', async () => {
  const html = await read('../public/index.html');
  for (const id of ['continueReadingRail','forumRail','reviewsRail','collectionsRail','topUsersRail','newestRail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, />Продолжить читать</);
  assert.match(html, />Последние темы форума\s*<i\s+data-lucide="arrow-right"/);
  assert.match(html, />Последние отзывы\s*<i\s+data-lucide="arrow-right"/);
  assert.match(html, />Последние коллекции\s*<i\s+data-lucide="arrow-right"/);
  assert.match(html, />Топ чтения за неделю</);
  assert.doesNotMatch(html, /id="proposalRail"/);
});

test('home parity grid follows captured lower-right stack order', async () => {
  const css = await read('../public/home-parity.css');
  assert.match(css, /grid-template-areas:[^}]*"popular popular"[^}]*"continue continue"[^}]*"top top"[^}]*"latest telegram"[^}]*"latest forum"[^}]*"latest reviews"[^}]*"latest collections"[^}]*"latest topusers"[^}]*"latest newest"/s);
  assert.match(css, /\.home-continue\{[^}]*grid-area:continue/s);
  assert.match(css, /\.home-forum\{[^}]*grid-area:forum/s);
  assert.match(css, /\.home-reviews\{[^}]*grid-area:reviews/s);
  assert.match(css, /\.home-collections\{[^}]*grid-area:collections/s);
  assert.match(css, /\.home-top-users\{[^}]*grid-area:topusers/s);
});

test('home social API lists real discussions reviews and collections', async () => {
  const source = await read('../src/web-home-social.ts');
  assert.match(source, /handleWebHomeSocialApi/);
  assert.match(source, /\/api\/home\/social/);
  assert.match(source, /web_title_discussions/);
  assert.match(source, /web_title_discussion_replies/);
  assert.match(source, /web_title_reviews/);
  assert.match(source, /web_title_review_votes/);
  assert.match(source, /web_collections/);
  assert.match(source, /web_collection_items/);
  assert.match(source, /ranobelib_titles/);
});

test('live entry routes home social endpoint before previous worker', async () => {
  const source = await read('../src/live-entry-v3.ts');
  assert.match(source, /import\s+\{\s*handleWebHomeSocialApi/);
  assert.match(source, /handleWebHomeSocialApi\(request,\s*env\)/);
  assert.ok(source.indexOf('handleWebHomeSocialApi(request, env)') < source.indexOf('return previous.fetch(request, env, ctx)'));
});

test('home client hydrates continue reading and public social sections without fake data', async () => {
  const source = await read('../public/home-parity.js');
  assert.match(source, /\/api\/home\/social/);
  assert.match(source, /domnkr:reader:/);
  assert.match(source, /continueReadingRail/);
  assert.match(source, /forumRail/);
  assert.match(source, /reviewsRail/);
  assert.match(source, /collectionsRail/);
  assert.match(source, /topUsersRail/);
  assert.doesNotMatch(source, /seeded|fake|mock/i);
});