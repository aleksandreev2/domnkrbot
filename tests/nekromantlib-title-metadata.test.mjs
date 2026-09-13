import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title API reads primary-team translation state and does not hide completed titles', async () => {
  const source = await read('../src/reader-runtime.ts');
  const getTitleStart = source.indexOf('async function getTitle');
  const getChapterStart = source.indexOf('async function getChapter');
  assert.ok(getTitleStart >= 0 && getChapterStart > getTitleStart, 'getTitle source block must be discoverable');
  const getTitleSource = source.slice(getTitleStart, getChapterStart);

  assert.match(getTitleSource, /ranobelib_team_translations/);
  assert.match(getTitleSource, /ranobelib_teams/);
  assert.match(getTitleSource, /semantic_status\s+AS\s+translation_semantic_status/i);
  assert.match(getTitleSource, /translation_status_label/i);
  assert.match(getTitleSource, /presence_state\s*=\s*'active'/i);
  assert.match(getTitleSource, /WHERE\s+t\.book_ref=\?\s+AND\s+\(t\.is_active=1\s+OR\s+tt\.book_ref\s+IS\s+NOT\s+NULL\)\s+LIMIT\s+1/i);
  assert.doesNotMatch(getTitleSource, /WHERE\s+(?:t\.)?book_ref=\?\s+AND\s+(?:t\.)?is_active=1\s+LIMIT\s+1/i);
});

test('reader chapter API remains available for completed primary-team translations', async () => {
  const source = await read('../src/reader-runtime.ts');
  const getChapterStart = source.indexOf('async function getChapter');
  const handleReaderStart = source.indexOf('export async function handleReaderApi');
  assert.ok(getChapterStart >= 0 && handleReaderStart > getChapterStart, 'getChapter source block must be discoverable');
  const getChapterSource = source.slice(getChapterStart, handleReaderStart);

  assert.match(getChapterSource, /ranobelib_team_translations/);
  assert.match(getChapterSource, /ranobelib_teams/);
  assert.match(getChapterSource, /presence_state\s*=\s*'active'/i);
  assert.match(getChapterSource, /WHERE\s+t\.book_ref=\?\s+AND\s+\(t\.is_active=1\s+OR\s+tt\.book_ref\s+IS\s+NOT\s+NULL\)\s+LIMIT\s+1/i);
  assert.doesNotMatch(getChapterSource, /FROM\s+ranobelib_titles\s+WHERE\s+book_ref=\?\s+AND\s+is_active=1\s+LIMIT\s+1/i);
});

test('title UI renders the real synchronized translation status', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title.js');
  assert.match(html, /id="translationStatus"/);
  assert.match(js, /translation_status_label/);
  assert.match(js, /translation_semantic_status/);
  assert.match(js, /#translationStatus/);
});
