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

test('team page fallback can recover a catalog-omitted title only after exact team attribution is verified', async () => {
  const teamRef = '64306--blinnaia-besa';
  const bookRef = '247881--deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha';
  const teamPageUrl = `https://ranobelib.me/ru/team/${teamRef}`;
  const detailTeamsUrl = `https://api.cdnlibs.org/api/manga/${bookRef}?fields[]=teams`;
  const foreignRef = '999999--foreign-book';
  const foreignDetailUrl = `https://api.cdnlibs.org/api/manga/${foreignRef}?fields[]=teams`;
  const requests = [];

  const client = new RanobeLibClient({
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url) === teamPageUrl) {
        return new Response(`
          <a href="/ru/book/${bookRef}">Дракончик</a>
          <a href="/ru/book/${foreignRef}">Посторонняя ссылка</a>
        `, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (String(url) === detailTeamsUrl) {
        return json({ data: {
          id: 247881,
          slug: 'deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha',
          slug_url: bookRef,
          rus_name: 'Я ни за что не стану воспитывать дочь дракона',
          teams: [{ id: 64306, slug: 'blinnaia-besa', slug_url: teamRef, name: 'Блинная Беса' }],
        } });
      }
      if (String(url) === foreignDetailUrl) {
        return json({ data: {
          id: 999999,
          slug: 'foreign-book',
          slug_url: foreignRef,
          rus_name: 'Чужая книга',
          teams: [{ id: 77, slug: 'other', slug_url: '77--other', name: 'Другая команда' }],
        } });
      }
      return new Response('unexpected', { status: 500 });
    },
  });

  assert.equal(typeof client.discoverTeamPageBooks, 'function');
  assert.equal(typeof client.getTeamAttributedBook, 'function');

  const pageBooks = await client.discoverTeamPageBooks(teamRef);
  assert.deepEqual(pageBooks.map((book) => book.ref), [bookRef, foreignRef]);

  const verified = await client.getTeamAttributedBook(teamRef, bookRef);
  assert.equal(verified?.ref, bookRef);
  assert.equal(verified?.title, 'Я ни за что не стану воспитывать дочь дракона');

  const rejected = await client.getTeamAttributedBook(teamRef, foreignRef);
  assert.equal(rejected, null);
  assert.deepEqual(requests, [teamPageUrl, detailTeamsUrl, foreignDetailUrl]);
});

test('team chapter history discovers auth-hidden titles with exact team attribution across pages', async () => {
  const teamRef = '64306--blinnaia-besa';
  const hiddenRef = '247881--deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha';
  const secondRef = '258579--ropaneul-dakfantajiro-chacgakhassda';
  const firstPageUrl = 'https://api.cdnlibs.org/api/teams/64306/chapters?page=1';
  const secondPageUrl = 'https://api.cdnlibs.org/api/teams/64306/chapters?page=2';
  const requests = [];

  const chapter = (id, ref, title, teamId = 64306) => ({
    chapters: [{
      teams: [{ id: teamId, slug_url: teamId === 64306 ? teamRef : `${teamId}--other-team` }],
    }],
    manga: {
      id,
      slug_url: ref,
      slug: ref.split('--').slice(1).join('--'),
      rus_name: title,
    },
  });

  const client = new RanobeLibClient({
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url) === firstPageUrl) {
        return json({
          data: [
            chapter(247881, hiddenRef, 'Я ни за что не стану воспитывать дочь дракона'),
            chapter(247881, hiddenRef, 'Дубликат той же главы'),
            chapter(999999, '999999--foreign-book', 'Чужая книга', 77),
          ],
          meta: { current_page: 1, has_next_page: true },
        });
      }
      if (String(url) === secondPageUrl) {
        return json({
          data: [chapter(258579, secondRef, 'Я перепутал романтическое фэнтези с тёмным фэнтези')],
          meta: { current_page: 2, has_next_page: false },
        });
      }
      return new Response('unexpected', { status: 500 });
    },
  });

  const books = await client.discoverTeamHistoryBooks(teamRef);
  assert.deepEqual(books.map((book) => book.ref), [hiddenRef, secondRef]);
  assert.equal(books[0].title, 'Я ни за что не стану воспитывать дочь дракона');
  assert.deepEqual(requests, [firstPageUrl, secondPageUrl]);
});
