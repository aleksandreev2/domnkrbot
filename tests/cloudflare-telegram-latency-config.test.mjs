import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Cloudflare latency config enables Smart Placement without D1 read replication or Sessions', async () => {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

  assert.match(source, /"placement"\s*:\s*\{[\s\S]*?"mode"\s*:\s*"smart"[\s\S]*?\}/);
  assert.doesNotMatch(source, /read_replication|readReplication/i);
  assert.doesNotMatch(source, /"sessions?"\s*:/i);
});

test('Workers Paid subrequest budget is explicit in the deployment source of truth', async () => {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const wrangler = JSON.parse(source);

  assert.equal(
    wrangler.limits?.subrequests,
    10_000,
    'production must not depend on an implicit or dashboard-only subrequest limit',
  );
});

test('RanobeLib encryption key stays secret-only without blocking anonymous fallback deploys', async () => {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const wrangler = JSON.parse(source);
  assert.ok(wrangler.secrets?.required?.includes('TELEGRAM_BOT_TOKEN'));
  assert.ok(!wrangler.secrets?.required?.includes('RANOBELIB_TOKEN_ENCRYPTION_KEY'));
  assert.equal(wrangler.vars?.RANOBELIB_TOKEN_ENCRYPTION_KEY, undefined);
});

test('production smoke is pinned to the exact Workers Builds git revision', async () => {
  const wranglerSource = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const wrangler = JSON.parse(wranglerSource);
  const smoke = await readFile(new URL('../scripts/check-production.mjs', import.meta.url), 'utf8');

  assert.match(String(wrangler.build?.command ?? ''), /write-deploy-revision\.mjs/);
  assert.match(smoke, /EXPECTED_REVISION/);
  assert.match(smoke, /GITHUB_SHA/);
  assert.match(smoke, /\/deploy-revision\.txt/);
  assert.match(smoke, /const\s+deployedRevision\s*=\s*revision\.text\.trim\(\)\.toLowerCase\(\)/);
  assert.match(smoke, /revision\.text\.trim\(\)\.toLowerCase\(\)\s*===\s*expectedRevision/);
});
