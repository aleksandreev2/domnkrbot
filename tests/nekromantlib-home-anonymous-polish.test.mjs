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
  const html = await read('../public/index.html');
  const lazy = await read('../public/home-login-lazy.js');

  assert.match(html, /home-parity\.js[^>]*>[\s\S]*home-login-lazy\.js/);
  assert.match(lazy, /\.nl-account/);
  assert.match(lazy, /addEventListener\(['"]toggle['"]/);
  assert.match(lazy, /accountMenu\.open/);
  assert.match(lazy, /placeholder\.id=['"]telegramLoginLazy['"]/);
  assert.match(lazy, /\/api\/bootstrap/);
  assert.match(lazy, /telegram-widget\.js/);
  assert.match(lazy, /void mountTelegramLogin\(\)/);
});
