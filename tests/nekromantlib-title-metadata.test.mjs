import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title API reads primary-team translation state and does not hide completed titles', async () => {
  const source = await read('../src/reader-runtime.ts');
  assert.match(source, /ranobelib_team_translations/);
  assert.match(source, /ranobelib_teams/);
  assert.match(source, /semantic_status\s+AS\s+translation_semantic_status/i);
  assert.match(source, /translation_status_label/i);
  assert.match(source, /presence_state\s*=\s*'active'/i);
  assert.doesNotMatch(source, /getTitle[\s\S]*?WHERE\s+book_ref=\?\s+AND\s+is_active=1\s+LIMIT\s+1/i);
});

test('title UI renders the real synchronized translation status', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title.js');
  assert.match(html, /id="translationStatus"/);
  assert.match(js, /translation_status_label/);
  assert.match(js, /translation_semantic_status/);
  assert.match(js, /#translationStatus/);
});
