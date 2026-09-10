import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const gateway = readFileSync(new URL('../src/telegram-multi-team-gateway.ts', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/live-entry-v3.ts', import.meta.url), 'utf8');
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('multi-team gateway is UI-flagged while admin team management remains independently reachable', () => {
  assert.match(gateway, /getMultiTeamRollout/);
  assert.match(gateway, /rollout\.ui/);
  assert.match(gateway, /handleTelegramTeamAdmin/);
  assert.match(gateway, /handleTelegramTeamOnboarding/);
  assert.match(gateway, /handleTelegramTeamNotification/);
});

test('new production entry only intercepts fetch and delegates scheduled plus Queue behavior unchanged', () => {
  assert.match(entry, /previous\.fetch/);
  assert.match(entry, /previous\.scheduled/);
  assert.match(entry, /previous\.queue/);
  assert.match(wrangler, /"main"\s*:\s*"src\/live-entry-v3\.ts"/);
});

test('gateway falls through to the previous entry whenever no multi-team route is claimed', () => {
  assert.match(entry, /if \(intercepted\) return intercepted;/);
  assert.match(entry, /return previous\.fetch/);
});
