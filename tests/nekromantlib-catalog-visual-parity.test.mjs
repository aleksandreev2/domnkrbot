import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const css = async () => `${await read('../public/catalog.css')}\n${await read('../public/ranobelib-parity.css')}`;

test('catalog desktop puts media body left and 330px filter paper right', async () => {
  const source = await css();
  assert.match(source, /\.catalog-main\{[^}]*padding:16px 0/s);
  assert.match(source, /\.catalog-layout\{[^}]*grid-template-columns:minmax\(0,1fr\) 330px[^}]*gap:16px/s);
  assert.match(source, /\.catalog-results\{[^}]*grid-column:1[^}]*grid-row:1[^}]*background:#fff[^}]*border-radius:8px/s);
  assert.match(source, /\.catalog-filter-panel\{[^}]*grid-column:2[^}]*grid-row:1[^}]*top:72px[^}]*width:330px[^}]*max-height:calc\(100vh - 88px\)/s);
});

test('catalog list uses captured card padding and typography', async () => {
  const source = await css();
  assert.match(source, /\.catalog-grid\{[^}]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)[^}]*gap:0[^}]*padding:0 8px 4px/s);
  assert.match(source, /\.catalog-book-card\{[^}]*padding:8px/s);
  assert.match(source, /\.catalog-book-card h3\{[^}]*font-size:14px[^}]*line-height:18px[^}]*font-weight:600/s);
  assert.match(source, /\.catalog-card-meta\{[^}]*font-size:13px/s);
});

test('catalog heading follows captured paper header density', async () => {
  const source = await css();
  assert.match(source, /\.catalog-heading-row\{[^}]*padding:12px 16px 8px[^}]*margin:0/s);
  assert.match(source, /\.catalog-heading-row h1\{[^}]*font-size:20px[^}]*font-weight:600/s);
});
