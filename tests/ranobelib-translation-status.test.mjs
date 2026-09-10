import assert from 'node:assert/strict';
import test from 'node:test';

import { RanobeLibClient } from '../dist-runtime/integrations/ranobelib/client.js';

const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';
const detailUrl = 'https://api.cdnlibs.org/api/manga/70001--finished-book?fields[]=status_id';

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

test('team catalog uses the live accepted request shape and never mistakes generic status for translation status', async () => {
  await withFetch((url) => {
    if (url === teamCatalogUrl) {
      return json({
        data: [{
          id: 70001,
          slug: 'finished-book',
          slug_url: '70001--finished-book',
          rus_name: 'Оригинал завершён, перевод неизвестен',
          status: { id: 2, label: 'Завершён' },
        }],
        meta: { has_next_page: false },
      });
    }
    return new Response('unexpected', { status: 500 });
  }, async (requests) => {
    const books = await new RanobeLibClient().discoverTeamBooks('11969--dom-nekromanta');
    assert.deepEqual(requests, [teamCatalogUrl]);
    assert.equal(books.length, 1);
    assert.equal(books[0].translationStatusId, undefined);
    assert.equal(books[0].translationStatusLabel, undefined);
  });
});

test('detail status request reads scanlateStatus returned by fields[]=status_id', async () => {
  await withFetch((url) => {
    if (url === detailUrl) {
      return json({
        data: {
          id: 70001,
          status: { id: 1, label: 'Онгоинг' },
          scanlateStatus: { id: 2, label: 'Завершён' },
        },
      });
    }
    return new Response('unexpected', { status: 500 });
  }, async (requests) => {
    const status = await new RanobeLibClient().getTranslationStatus('70001--finished-book');
    assert.deepEqual(requests, [detailUrl]);
    assert.deepEqual(status, { id: 2, label: 'Завершён' });
  });
});

test('detail status request ignores generic work status when scanlateStatus is absent', async () => {
  await withFetch((url) => {
    if (url === detailUrl) {
      return json({ data: { status: { id: 2, label: 'Завершён' } } });
    }
    return new Response('unexpected', { status: 500 });
  }, async () => {
    const status = await new RanobeLibClient().getTranslationStatus('70001--finished-book');
    assert.deepEqual(status, { id: null, label: null });
  });
});

test('nested scanlateStatus remains authoritative when a catalog response already includes it', async () => {
  await withFetch((url) => {
    if (url === teamCatalogUrl) {
      return json({
        data: [{
          id: 70002,
          slug: 'active-book',
          slug_url: '70002--active-book',
          rus_name: 'Активная книга',
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
