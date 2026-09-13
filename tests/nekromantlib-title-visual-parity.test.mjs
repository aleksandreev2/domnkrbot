import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title social stylesheet pulls in the shared and title-specific parity layers', async () => {
  const css = await read('../public/title-discussions.css');
  assert.match(css, /@import url\(['"]\/ranobelib-parity\.css/);
  assert.match(css, /@import url\(['"]\/title-parity\.css/);
});

test('title desktop hero reproduces captured RanobeLib cover-header-rating composition', async () => {
  const css = await read('../public/title-parity.css');
  assert.match(css, /\.title-detail-layout\{[^}]*grid-template-columns:260px minmax\(0,1fr\) auto[^}]*grid-template-areas:"bg bg bg" "cover header rate" "cover content content" "actions content content" "facts content content"/s);
  assert.match(css, /\.title-detail-layout:before\{[^}]*grid-area:bg[^}]*height:360px[^}]*margin-left:-15px[^}]*margin-right:-15px/s);
  assert.match(css, /\.title-detail-layout:after\{[^}]*grid-area:bg[^}]*height:360px[^}]*background:radial-gradient/s);
  assert.match(css, /\.title-cover-frame\{[^}]*border-radius:8px/s);
  assert.match(css, /\.title-name-block h1\{[^}]*font-size:24px[^}]*line-height:1\.2[^}]*font-weight:600/s);
});

test('title paper, tabs and content use captured readable density instead of microtype', async () => {
  const css = await read('../public/title-parity.css');
  assert.match(css, /\.title-media-content\{[^}]*background:#fff[^}]*border-radius:8px[^}]*box-shadow:none/s);
  assert.match(css, /\.title-tabs\{[^}]*padding:0 18px[^}]*gap:16px/s);
  assert.match(css, /\.title-tabs button\{[^}]*padding:12px 0[^}]*font-size:14px[^}]*font-weight:600/s);
  assert.match(css, /\.title-tabs button:after\{[^}]*height:3px[^}]*background:var\(--nl-accent\)/s);
  assert.match(css, /\.title-description\{[^}]*font-size:14px[^}]*line-height:1\.65/s);
  assert.match(css, /\.chapter-row-copy strong\{[^}]*font-size:13px/s);
  assert.match(css, /\.chapter-row time\{[^}]*font-size:11px/s);
});
