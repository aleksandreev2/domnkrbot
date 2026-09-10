import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const productionEntry = readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
const compatibilityEntry = readFileSync(new URL('../src/live-entry.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/ranobelib-runtime.ts', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('production RanobeLib API is intercepted as a pure D1 read before the legacy base worker', () => {
  const start = productionEntry.indexOf("url.pathname === '/api/ranobelib'");
  const routeEnd = productionEntry.indexOf('\n    }', start);
  const base = productionEntry.indexOf('return baseWorker.fetch');
  assert.ok(start >= 0 && routeEnd > start && base > routeEnd, 'production entry must intercept RanobeLib API before base worker');
  const route = productionEntry.slice(start, routeEnd);

  assert.doesNotMatch(route, /syncRanobeLib/);
  assert.doesNotMatch(route, /ctx\.waitUntil/);
  assert.match(route, /getRanobeLibHome\(env\)/);

  const homeStart = runtime.indexOf('export async function getRanobeLibHome');
  const homeEnd = runtime.indexOf('\n/**', homeStart);
  assert.ok(homeStart >= 0 && homeEnd > homeStart, 'getRanobeLibHome must remain inspectable');
  const home = runtime.slice(homeStart, homeEnd);
  assert.doesNotMatch(home, /ensureRanobeLibSchema/);
});

test('public RanobeLib feed and release count exclude lifecycle-only completion events', () => {
  const homeStart = runtime.indexOf('export async function getRanobeLibHome');
  const homeEnd = runtime.indexOf('\n/**', homeStart);
  assert.ok(homeStart >= 0 && homeEnd > homeStart, 'getRanobeLibHome must remain inspectable');
  const home = runtime.slice(homeStart, homeEnd);
  const chapterOnlyFilters = home.match(/release_kind\s*=\s*'chapters'/g) ?? [];

  assert.ok(chapterOnlyFilters.length >= 2, 'both the public release feed and release count must be chapter-only');
  assert.doesNotMatch(home, /\(SELECT COUNT\(\*\) FROM ranobelib_releases\) AS releases/);
});

test('legacy circular crawler is removed from RanobeLib runtime', () => {
  assert.doesNotMatch(runtime, /new RanobeLibClient/);
  assert.doesNotMatch(runtime, /ranobelib_sync_cursor/);
  assert.doesNotMatch(runtime, /RANOBELIB_SYNC_BATCH_SIZE/);
  assert.doesNotMatch(runtime, /SYNC_STALE_MS/);
  assert.doesNotMatch(runtime, /circularSlice/);
  assert.doesNotMatch(runtime, /syncBook\(/);
});

test('compatibility auto-kick is permanently disabled while manual admin sync uses modern scheduler modules', () => {
  assert.match(runtime, /shouldKickRanobeLibSync[\s\S]{0,180}return false/);
  assert.match(runtime, /import\('\.\/ranobelib-discovery-scheduler\.js'\)/);
  assert.match(runtime, /import\('\.\/ranobelib-fast-scanner\.js'\)/);
  assert.match(runtime, /discoverRanobeLibTeam\(env\)/);
  assert.match(runtime, /scanDueRanobeLibTitles\(env/);
  assert.match(runtime, /scanIdleRanobeLibTitles\(env/);
  assert.match(runtime, /processed:\s*hotScan\.selected\s*\+\s*idleScan\.selected/);
  assert.match(runtime, /newReleases:\s*hotScan\.newReleases\s*\+\s*idleScan\.newReleases/);
});

test('obsolete legacy sync batch configuration is removed from deployment and compatibility types', () => {
  assert.doesNotMatch(wrangler, /RANOBELIB_SYNC_BATCH_SIZE/);
  assert.doesNotMatch(compatibilityEntry, /RANOBELIB_SYNC_BATCH_SIZE/);
});
