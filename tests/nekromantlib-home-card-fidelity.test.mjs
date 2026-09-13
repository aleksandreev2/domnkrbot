import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const readHomeCss = async () => `${await read('../public/home-parity.css')}\n${await read('../public/home-fidelity.css')}`;

test('home loads its captured card-fidelity override after the base parity layer', async () => {
  const html = await read('../public/index.html');
  assert.match(html, /home-parity\.css[^>]*>[\s\S]*home-fidelity\.css/);
});

test('home update cover badges follow the captured bottom-left RanobeLib treatment', async () => {
  const css = await readHomeCss();
  assert.match(css, /\.home-cover-badge\{[^}]*bottom:6px[^}]*left:6px/s);
  assert.match(css, /\.home-cover-badge\{[^}]*padding:3px 6px[^}]*background:rgba\(0,0,0,\.7\)/s);
  assert.match(css, /\.home-cover-badge\{[^}]*font-size:12px/s);
});

test('home review cards reproduce the captured tall banner-card hierarchy', async () => {
  const js = await read('../public/home-parity.js');
  const css = await readHomeCss();

  assert.match(js, /home-review-kind/);
  assert.match(js, /home-review-foot/);
  assert.match(css, /\.home-review-card\{[^}]*min-height:244px/s);
  assert.match(css, /\.home-review-head\{[^}]*display:grid/s);
  assert.match(css, /\.home-review-cover\{[^}]*width:100%[^}]*aspect-ratio:25\/8[^}]*object-fit:cover/s);
  assert.match(css, /\.home-review-foot\{[^}]*font-size:11px/s);
});

test('home newest rail uses captured desktop quarter-width cards', async () => {
  const css = await readHomeCss();
  assert.match(css, /\.home-newest-card\{[^}]*width:25%/s);
  assert.match(css, /@media\s*\(max-width:1049px\)[\s\S]*\.home-newest-card\{[^}]*width:130px/s);
});

test('home header uses a horizontal NekromantLib wordmark footprint instead of avatar-plus-label chrome', async () => {
  const css = await readHomeCss();
  assert.match(css, /\.nl-header \.nl-brand img\{[^}]*display:none/s);
  assert.match(css, /\.nl-header \.nl-brand\{[^}]*height:50px[^}]*gap:0/s);
  assert.match(css, /\.nl-header \.nl-brand:before\{[^}]*content:"Некромант"[^}]*font-size:20px/s);
  assert.match(css, /\.nl-header \.nl-brand:after\{[^}]*content:"Либ"[^}]*color:var\(--nl-accent\)/s);
});

test('empty continue-reading state collapses like the anonymous live RanobeLib home', async () => {
  const css = await readHomeCss();
  assert.match(css, /\.home-continue:has\(#continueReadingRail>\.home-compact-empty\)\{[^}]*display:none/s);
});

test('latest update rows keep captured cover-left and stacked metadata flow', async () => {
  const css = await readHomeCss();
  assert.match(css, /\.home-latest-updates \.release-row\{[^}]*grid-template-columns:80px minmax\(0,1fr\)[^}]*grid-template-rows:auto auto/s);
  assert.match(css, /\.home-latest-updates \.release-cover\{[^}]*grid-row:1\/3/s);
  assert.match(css, /\.home-latest-updates \.release-time\{[^}]*grid-column:2[^}]*padding-left:0[^}]*margin-top:8px/s);
});
