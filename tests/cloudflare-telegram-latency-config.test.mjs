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