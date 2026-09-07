import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const liveEntry = readFileSync(new URL('../src/live-entry.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/ranobelib-runtime.ts', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('public RanobeLib API is a pure D1 read and never starts legacy sync', () => {
  const start = liveEntry.indexOf("if (url.pathname === '/api/ranobelib')");
  const end = liveEntry.indexOf('\n    return appEntry.fetch', start);
  assert.ok(start >= 0 && end > start, 'RanobeLib API route should exist');
  const route = liveEntry.slice(start, end);

  assert.doesNotMatch(route, /shouldKickRanobeLibSync/);
  assert.doesNotMatch(route, /syncRanobeLib/);
  assert.doesNotMatch(route, /ctx\.waitUntil/);
  assert.match(route, /getRanobeLibHome\(env\)/);
});

test('legacy circular RanobeLib sync implementation is removed from runtime', () => {
  assert.doesNotMatch(runtime, /export async function shouldKickRanobeLibSync/);
  assert.doesNotMatch(runtime, /export function syncRanobeLib/);
  assert.doesNotMatch(runtime, /ranobelib_sync_cursor/);
  assert.doesNotMatch(runtime, /RANOBELIB_SYNC_BATCH_SIZE/);
  assert.doesNotMatch(runtime, /SYNC_STALE_MS/);
  assert.doesNotMatch(runtime, /circularSlice/);
});

test('legacy manual sync endpoint is retired and admin UI no longer invokes it', () => {
  assert.match(
    liveEntry,
    /url\.pathname === '\/api\/admin\/ranobelib\/sync'[\s\S]{0,260}410/,
    'cached callers should receive an explicit Gone response instead of silently falling through',
  );
  assert.doesNotMatch(admin, /\/api\/admin\/ranobelib\/sync/);
  assert.match(admin, /автоматическ/i);
});

test('obsolete legacy sync batch configuration is removed', () => {
  assert.doesNotMatch(wrangler, /RANOBELIB_SYNC_BATCH_SIZE/);
});
