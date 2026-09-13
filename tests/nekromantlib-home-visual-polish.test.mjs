import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('home header wordmark and actions share the captured 32px visual baseline', async () => {
  const css = await read('../public/home-fidelity.css');
  assert.match(css, /\.nl-header \.nl-brand:before,.nl-header \.nl-brand:after\{[^}]*display:inline-flex[^}]*align-items:center[^}]*height:32px[^}]*line-height:32px/s);
  assert.match(css, /\.nl-header \.nl-brand\{[^}]*align-items:center/s);
});

test('popular update covers have a deterministic captured 5 by 7 portrait box', async () => {
  const css = `${await read('../public/home-parity.css')}\n${await read('../public/home-fidelity.css')}`;
  assert.match(css, /\.home-cover-card \.home-cover-media\{[^}]*width:135px[^}]*height:189px[^}]*aspect-ratio:5\/7[^}]*padding-top:0/s);
  assert.match(css, /\.home-cover-card\{[^}]*width:135px/s);
});
