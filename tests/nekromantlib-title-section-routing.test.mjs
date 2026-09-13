import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title shell owns section routing for native social tabs', async () => {
  const source = await read('../public/title.js');
  assert.match(source, /comments\s*:\s*['"]comments['"]/);
  assert.match(source, /discussions\s*:\s*['"]discussions['"]/);
  assert.match(source, /reviews\s*:\s*['"]review['"]/);
  assert.match(source, /history\.pushState\(/);
  assert.match(source, /addEventListener\(['"]popstate['"]/);
});

test('title shell applies one active panel and broadcasts tab changes', async () => {
  const source = await read('../public/title.js');
  assert.match(source, /\[data-title-tab\]/);
  assert.match(source, /\.title-tab-panel/);
  assert.match(source, /CustomEvent\(['"]title-tab-change['"]/);
  assert.match(source, /dispatchEvent\(/);
});

test('initial deep links and browser history replay the existing social lazy loaders', async () => {
  const source = await read('../public/title.js');
  const comments = await read('../public/title-comments.js');
  const discussions = await read('../public/title-discussions.js');
  const reviews = await read('../public/title-reviews.js');

  assert.match(source, /replayTabActivation/);
  assert.match(source, /setTitleTab\(tabFromLocation\(\),\{push:false,replay:true\}\)/);
  assert.match(source, /setTitleTab\(state\.activeTab,\{replay:true\}\)/);
  assert.match(source, /\.click\(\)/);

  assert.match(comments, /loadTitleComments/);
  assert.match(discussions, /loadTitleDiscussions/);
  assert.match(reviews, /loadTitleReviews/);
});
