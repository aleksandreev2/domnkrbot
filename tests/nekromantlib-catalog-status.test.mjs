import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('RanobeLib home API exposes a primary-team catalog projection without changing the active home feed', async () => {
  const runtime = await read('../src/ranobelib-runtime.ts');
  assert.match(runtime, /catalogTitles:\s*RanobeLibCatalogTitleCard\[\]/);
  assert.match(runtime, /FROM ranobelib_titles t[\s\S]*JOIN ranobelib_teams team[\s\S]*team\.is_primary\s*=\s*1/s);
  assert.match(runtime, /JOIN ranobelib_team_translations tt[\s\S]*tt\.team_id\s*=\s*team\.id[\s\S]*tt\.book_ref\s*=\s*t\.book_ref/s);
  assert.match(runtime, /tt\.presence_state\s*=\s*'active'/);
  assert.match(runtime, /tt\.semantic_status\s+AS\s+translation_semantic_status/i);
  assert.match(runtime, /t\.translation_status_label/);

  const activeFeed = runtime.match(/SELECT book_ref, url, title, summary, cover_url,[\s\S]*?LIMIT 80/);
  assert.ok(activeFeed, 'existing home title query must remain present');
  assert.match(activeFeed[0], /WHERE is_active = 1 AND snapshot_ready = 1/);
});

test('catalog exposes and persists a real translationStatus filter', async () => {
  const [html, js] = await Promise.all([
    read('../public/catalog/index.html'),
    read('../public/catalog.js'),
  ]);
  assert.match(html, /name="translationStatus"[^>]*value="active"/);
  assert.match(html, /name="translationStatus"[^>]*value="completed"/);
  assert.match(html, /name="translationStatus"[^>]*value="unknown"/);
  assert.match(html, />Продолжается</);
  assert.match(html, />Завершён</);
  assert.match(html, />Неизвестно</);

  assert.match(js, /catalogTitles/);
  assert.match(js, /translationStatus/);
  assert.match(js, /translation_semantic_status/);
  assert.match(js, /params\.set\('translationStatus'/);
  assert.doesNotMatch(js, /fakeStatus|Math\.random\(/);
});
