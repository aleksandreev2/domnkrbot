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

test('desktop header reproduces the captured 56px shell with 50px navigation and soft 32px actions', async () => {
  const css = await readSharedCss();

  assert.match(css, /\.nl-header\.site-header\{[^}]*min-height:56px[^}]*height:56px[^}]*background:#e0f2ff[^}]*box-shadow:0 1px 3px rgba\(0,0,0,\.12\)/s);
  assert.match(css, /\.nl-header-inner\{[^}]*height:56px[^}]*display:grid[^}]*grid-template-columns:252px 1fr 252px/s);
  assert.match(css, /\.nl-nav\.primary-nav\{[^}]*height:50px[^}]*gap:6px/s);
  assert.match(css, /\.nl-nav\.primary-nav a,\.nl-nav-button\{[^}]*min-height:32px[^}]*border-radius:6px[^}]*padding:0 12px/s);
  assert.match(css, /\.nl-nav\.primary-nav a:hover,\.nl-nav-button:hover[^}]*background:rgba\(33,150,243,\.2\)/s);
});

test('home page exposes the captured RanobeLib block hierarchy', async () => {
  const html = await read('../public/index.html');
  for (const id of ['popularUpdates','continueReadingRail','topViewsNew','topViewsRising','topViewsPopular','releaseFeed','forumRail','reviewsRail','collectionsRail','topUsersRail','newestRail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="[^"]*home-reference-grid/);
  assert.match(html, />Сейчас читают</);
  assert.match(html, />Набирающее популярность</);
  assert.match(html, />Последние обновления</);
  assert.doesNotMatch(html, /class="[^"]*team-card/);
  assert.doesNotMatch(html, /id="proposalRail"/);
});

test('home desktop composition follows the captured full-width then 1fr 540px grid', async () => {
  const css = await read('../public/home-parity.css');
  assert.match(css, /\.home-reference-grid\{[^}]*grid-template-columns:minmax\(0,1fr\) 540px[^}]*grid-template-areas:"popular popular" "continue continue" "top top" "latest telegram" "latest forum" "latest reviews" "latest collections" "latest topusers" "latest newest" "latest \\."/s);
  assert.match(css, /\.home-popular\{[^}]*grid-area:popular/s);
  assert.match(css, /\.home-continue\{[^}]*grid-area:continue/s);
  assert.match(css, /\.home-top-views\{[^}]*grid-area:top/s);
  assert.match(css, /\.home-latest-updates\{[^}]*grid-area:latest/s);
});

test('home cover strip and now-reading cards use captured RanobeLib dimensions', async () => {
  const css = await read('../public/home-parity.css');
  assert.match(css, /\.home-cover-strip\{[^}]*gap:16px[^}]*padding:12px 16px[^}]*min-height:273px/s);
  assert.match(css, /\.home-cover-card\{[^}]*flex:0 0 135px[^}]*width:135px/s);
  assert.match(css, /\.home-cover-media\{[^}]*padding-top:140%[^}]*border-radius:6px/s);
  assert.match(css, /\.home-top-grid\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/s);
  assert.match(css, /\.home-top-item img\{[^}]*width:72px[^}]*height:72px[^}]*border-radius:6px/s);
});

test('latest updates use the captured RanobeLib row density', async () => {
  const css = await readSharedCss();

  assert.match(css, /\.release-row\{[^}]*min-height:112px/s);
  assert.match(css, /\.release-cover\{[^}]*width:80px[^}]*height:112px/s);
  assert.match(css, /\.release-title\{[^}]*font-size:15px/s);
});
