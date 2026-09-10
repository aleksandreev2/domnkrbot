import assert from 'node:assert/strict';
import test from 'node:test';

import { RanobeLibClient } from '../dist-runtime/integrations/ranobelib/client.js';

const constantsUrl = 'https://api.cdnlibs.org/api/constants?fields[]=scanlateStatus';
const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&fields[]=status_id&page=1';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    return handler(String(url), init);
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = original;
  }
}

test('team catalog resolves scalar status_id through scanlateStatus constants', async () => {
  await withFetch((url) => {
    if (url === constantsUrl) {
      return json({
        data: {
          scanlateStatus: [
            { id: 1, label: 'Продолжается', site_ids: [3] },
            { id: 7, label: 'Завершён', site_ids: [3] },
          ],
        },
      });
    }
    if (url === teamCatalogUrl) {
      return json({
        data: [{
          id: 70001,
          slug: 'finished-book',
          slug_url: '70001--finished-book',
          rus_name: 'Завершённая книга',
          status_id: 7,
          cover: { default: 'https://cover.imglib.info/example.jpg' },
        }],
        meta: { has_next_page: false },
      });
    }
    return new Response('unexpected', { status: 500 });
  }, async (requests) => {
    const client = new RanobeLibClient();
    const books = await client.discoverTeamBooks('11969--dom-nekromanta');

    assert.deepEqual(requests, [constantsUrl, teamCatalogUrl]);
    assert.equal(books.length, 1);
    assert.equal(books[0].translationStatusId, 7);
    assert.equal(books[0].translationStatusLabel, 'Завершён');
  });
});

test('generic nested status object is never treated as translation status', async () => {
  await withFetch((url) => {
    if (url === constantsUrl) return json({ data: { scanlateStatus: [] } });
    if (url === teamCatalogUrl) {
      return json({
        data: [{
          id: 70003,
          slug: 'finished-status-object',
          slug_url: '70003--finished-status-object',
          rus_name: 'Оригинал завершён, перевод неизвестен',
          status: { id: 2, label: 'Завершён' },
        }],
        meta: { has_next_page: false },
      });
    }
    return new Response('unexpected', { status: 500 });
  }, async () => {
    const books = await new RanobeLibClient().discoverTeamBooks('11969--dom-nekromanta');
    assert.equal(books.length, 1);
    assert.equal(books[0].translationStatusId, undefined);
    assert.equal(books[0].translationStatusLabel, undefined);
  });
});

test('nested scanlateStatus remains authoritative when catalog already returns it', async () => {
  await withFetch((url) => {
    if (url === constantsUrl) return json({ data: { scanlateStatus: [] } });
    if (url === teamCatalogUrl) {
      return json({
        data: [{
          id: 70002,
          slug: 'active-book',
          slug_url: '70002--active-book',
          rus_name: 'Активная книга',
          status_id: 99,
          status: { id: 2, label: 'Завершён' },
          scanlateStatus: { id: 1, label: 'Продолжается' },
        }],
        meta: { has_next_page: false },
      });
    }
    return new Response('unexpected', { status: 500 });
  }, async () => {
    const books = await new RanobeLibClient().discoverTeamBooks('11969--dom-nekromanta');
    assert.equal(books[0].translationStatusId, 1);
    assert.equal(books[0].translationStatusLabel, 'Продолжается');
  });
});

// Temporary diagnostic. It is intentionally removed before merge. The production incident is
// impossible to distinguish safely from mocks alone, so CI records only field names/status shapes
// from the public team-catalog response (no auth, no user data, no chapter text).
test('diagnostic: inspect live RanobeLib team status shape', { timeout: 20_000 }, async () => {
  try {
    const response = await fetch(teamCatalogUrl, {
      headers: {
        accept: 'application/json',
        'accept-language': 'ru,en;q=0.7',
        'Site-Id': '3',
      },
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    console.log('LIVE_RANOBELIB_STATUS_DIAG', JSON.stringify({
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      dataCount: Array.isArray(payload?.data) ? payload.data.length : null,
      keys: first && typeof first === 'object' ? Object.keys(first).sort() : null,
      status_id: first?.status_id ?? null,
      status: first?.status ?? null,
      scanlateStatus: first?.scanlateStatus ?? null,
      bodyPreview: payload ? null : text.slice(0, 160),
    }));
  } catch (error) {
    console.log('LIVE_RANOBELIB_STATUS_DIAG', JSON.stringify({ error: String(error) }));
  }
});
