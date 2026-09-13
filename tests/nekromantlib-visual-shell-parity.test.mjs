import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const readSharedCss = async () => `${await read('../public/nekromantlib.css')}\n${await read('../public/ranobelib-parity.css')}`;

test('shared NekromantLib shell uses captured RanobeLib desktop tokens', async () => {
  const css = await readSharedCss();

  assert.match(css, /--nl-bg:#f2f2f3/);
  assert.match(css, /--nl-surface:#fff/);
  assert.match(css, /--nl-text:#212529/);
  assert.match(css, /--nl-muted:#8a8a8e/);
  assert.match(css, /--nl-border:#e5e5e5/);
  assert.match(css, /--nl-accent:#2196f3/);
  assert.match(css, /--nl-accent-dark:#1976d2/);
  assert.match(css, /--nl-radius:8px/);
  assert.match(css, /--nl-shell:1200px/);
});

test('desktop header reproduces the captured 56px three-column shell', async () => {
  const css = await readSharedCss();

  assert.match(css, /\.nl-header\.site-header\{[^}]*min-height:56px[^}]*height:56px[^}]*background:#e0f2ff[^}]*box-shadow:0 1px 3px rgba\(0,0,0,\.12\)/s);
  assert.match(css, /\.nl-header-inner\{[^}]*height:56px[^}]*display:grid[^}]*grid-template-columns:252px 1fr 252px/s);
  assert.match(css, /\.nl-nav\.primary-nav\{[^}]*height:56px/s);
  assert.match(css, /\.nl-nav\.primary-nav a,\.nl-nav-button\{[^}]*height:56px/s);
});

test('home desktop composition follows the captured two-column RanobeLib grid', async () => {
  const css = await readSharedCss();

  assert.match(css, /\.nl-main\{[^}]*padding:16px 0/s);
  assert.match(css, /\.nl-home-grid\{[^}]*grid-template-columns:minmax\(0,1fr\) 540px[^}]*gap:20px/s);
  assert.match(css, /\.surface\{[^}]*background:var\(--nl-surface\)[^}]*border:0[^}]*border-radius:8px[^}]*box-shadow:none/s);
  assert.match(css, /\.nl-section\{[^}]*padding:0[^}]*margin-bottom:20px/s);
  assert.match(css, /\.nl-section-head\.section-head\{[^}]*padding:12px 16px/s);
});

test('latest updates use the captured RanobeLib row density', async () => {
  const css = await readSharedCss();

  assert.match(css, /\.release-row\{[^}]*min-height:112px/s);
  assert.match(css, /\.release-cover\{[^}]*width:80px[^}]*height:112px/s);
  assert.match(css, /\.release-title\{[^}]*font-size:15px/s);
});
