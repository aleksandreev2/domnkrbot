import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('anonymous home hides empty social rail sections instead of rendering large blank slabs', async () => {
  const css = await read('../public/home-fidelity.css');
  assert.match(css, /\.home-forum:has\(\.home-compact-empty\)/);
  assert.match(css, /\.home-reviews:has\(\.home-compact-empty\)/);
  assert.match(css, /\.home-collections:has\(\.home-compact-empty\)/);
  assert.match(css, /display:none/);
});

test('Telegram login widget is mounted lazily only after the account menu is opened', async () => {
  const js = await read('../public/home-parity.js');
  assert.match(js, /\.nl-account/);
  assert.match(js, /addEventListener\(['"]toggle['"]/);
  assert.match(js, /accountMenu\.open/);
  assert.match(js, /mountTelegramLogin\(\)/);

  const renderSession = js.slice(js.indexOf('function renderSession()'), js.indexOf('function renderSessionError()'));
  assert.doesNotMatch(renderSession, /mountTelegramLogin\(\)/);
});
