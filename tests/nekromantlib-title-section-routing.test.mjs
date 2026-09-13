import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title shell owns the exact live RanobeLib section mapping', async () => {
  const source = await read('../public/title.js');
  assert.match(source, /chapters\s*:\s*['"]chapters['"]/);
  assert.match(source, /comments\s*:\s*['"]comments['"]/);
  assert.match(source, /discussions\s*:\s*['"]discussions['"]/);
  assert.match(source, /reviews\s*:\s*['"]review['"]/);
  assert.match(source, /activeTab:TAB_BY_SECTION\[initialSection\]\|\|'about'/);
  assert.match(source, /TAB_BY_SECTION\[section\]\|\|'about'/);
  assert.match(source, /history\.pushState\(/);
  assert.match(source, /addEventListener\(['"]popstate['"]/);
});

test('clean title URL starts on About while Chapters uses section=chapters', async () => {
  const html = await read('../public/title/index.html');
  assert.match(html, /data-title-tab="about"[^>]*class="active"[^>]*aria-selected="true"/);
  assert.match(html, /data-title-tab="chapters"(?![^>]*class="active")[^>]*aria-selected="false"/);
  assert.doesNotMatch(html, /id="titleAboutPanel"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="titleChaptersPanel"[^>]*class="[^"]*hidden/);
});

test('title shell applies one active panel and broadcasts tab changes', async () => {
  const source = await read('../public/title.js');
  assert.match(source, /\[data-title-tab\]/);
  assert.match(source, /\.title-tab-panel/);
  assert.match(source, /CustomEvent\(['"]title-tab-change['"]/);
  assert.match(source, /dispatchEvent\(/);
});

test('deep links and browser history are handled without a compatibility click bridge', async () => {
  const html = await read('../public/title/index.html');
  const shell = await read('../public/title.js');
  const comments = await read('../public/title-comments.js');
  const discussions = await read('../public/title-discussions.js');
  const reviews = await read('../public/title-reviews.js');

  assert.doesNotMatch(html, /title-routing-bridge\.js/);
  assert.match(shell, /addEventListener\(['"]popstate['"]/);
  assert.match(shell, /title-tab-change/);
  assert.match(comments, /title-tab-change/);
  assert.match(discussions, /title-tab-change/);
  assert.match(reviews, /title-tab-change/);
  assert.doesNotMatch(`${comments}\n${discussions}\n${reviews}`, /history\.(?:replaceState|pushState)/);
});
