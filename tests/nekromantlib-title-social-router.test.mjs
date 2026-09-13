import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('comments and reviews consume central title-tab-change events instead of owning panel state', async () => {
  const comments = await read('../public/title-comments.js');
  const reviews = await read('../public/title-reviews.js');

  for (const [name, source] of [['comments', comments], ['reviews', reviews]]) {
    assert.match(source, /title-tab-change/, `${name} should subscribe to the central title router`);
    assert.doesNotMatch(source, /function bindTabs\s*\(/, `${name} should not bind every title tab directly`);
    assert.doesNotMatch(source, /function activate(?:Comments|Reviews)Tab\s*\(/, `${name} should not own active panel state`);
    assert.doesNotMatch(source, /querySelectorAll\('\[data-title-tab\]'\)/, `${name} should not toggle global title tabs`);
  }
});

test('comments and reviews preserve lazy loading for direct section links', async () => {
  const comments = await read('../public/title-comments.js');
  const reviews = await read('../public/title-reviews.js');
  const shell = await read('../public/title.js');

  assert.match(comments, /detail\?\.tab\s*===\s*['"]comments['"]/);
  assert.match(reviews, /detail\?\.tab\s*===\s*['"]reviews['"]/);
  assert.match(comments, /section['"]?\)\s*===\s*['"]comments['"]/);
  assert.match(reviews, /section['"]?\)\s*===\s*['"]review['"]/);
  assert.match(shell, /comments:'comments'/);
  assert.match(shell, /reviews:'review'/);
});
