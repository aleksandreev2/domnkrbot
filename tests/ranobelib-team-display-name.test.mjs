import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { RanobeLibClient } from '../dist-runtime/integrations/ranobelib/client.js';

test('RanobeLib client resolves the localized team name from title team metadata', async () => {
  const requests = [];
  const client = new RanobeLibClient({
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        data: {
          teams: [
            { id: 77, slug_url: '77--blinnaia-besa', slug: 'blinnaia-besa', name: 'Блинная Беса' },
            { id: 88, slug_url: '88--other-team', slug: 'other-team', name: 'Другая команда' },
          ],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(
    await client.getTeamDisplayName('77--blinnaia-besa', ['100--book']),
    'Блинная Беса',
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/manga\/100--book\?fields\[\]=teams/);
});

test('team discovery refreshes stored display name from upstream metadata without making it mandatory', async () => {
  const source = await readFile(new URL('../src/ranobelib-multi-team-discovery.ts', import.meta.url), 'utf8');
  assert.match(source, /getTeamDisplayName/);
  assert.match(source, /UPDATE ranobelib_teams[\s\S]*display_name/);
  assert.match(source, /catch\(\(\) => null\)/);
});
