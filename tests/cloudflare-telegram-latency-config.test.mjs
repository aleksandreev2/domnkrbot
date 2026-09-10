import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Cloudflare latency config enables Smart Placement without D1 read replication or Sessions', async () => {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

  assert.match(source, /"placement"\s*:\s*\{[\s\S]*?"mode"\s*:\s*"smart"[\s\S]*?\}/);
  assert.doesNotMatch(source, /read_replication|readReplication/i);
  assert.doesNotMatch(source, /"sessions?"\s*:/i);
});
