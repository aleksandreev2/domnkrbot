import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RanobeLibClient,
  detectReleaseDelta,
  discoverTeamBooksFromHtml,
} from '../dist/index.js';

test('keeps rendered HTML parsing as an offline/import fallback', () => {
  const html = `
    <a href="https://ranobelib.me/ru/book/62387--pokemon-master-of-tactics?from=catalog&amp;ui=1">Pokemon</a>
    <a href=/ru/book/128806--sonmas-eulo-gujehaneun-mangdol-insaeng>Idol</a>
    <a href="https://ranobelib.me/ru/book/271368--seiljeumaen-ui-jeonseol-i-doeeotda?from=catalog">Sales</a>
    <a href="https://ranobelib.me/ru/book/62387--pokemon-master-of-tactics">duplicate</a>
  `;

  assert.deepEqual(discoverTeamBooksFromHtml(html), [
    {
      id: 62387,
      slug: 'pokemon-master-of-tactics',
      ref: '62387--pokemon-master-of-tactics',
      url: 'https://ranobelib.me/ru/book/62387--pokemon-master-of-tactics',
    },
    {
      id: 128806,
      slug: 'sonmas-eulo-gujehaneun-mangdol-insaeng',
      ref: '128806--sonmas-eulo-gujehaneun-mangdol-insaeng',
      url: 'https://ranobelib.me/ru/book/128806--sonmas-eulo-gujehaneun-mangdol-insaeng',
    },
    {
      id: 271368,
      slug: 'seiljeumaen-ui-jeonseol-i-doeeotda',
      ref: '271368--seiljeumaen-ui-jeonseol-i-doeeotda',
      url: 'https://ranobelib.me/ru/book/271368--seiljeumaen-ui-jeonseol-i-doeeotda',
    },
  ]);
});

test('does not emit historical chapters on bootstrap', () => {
  const current = [
    { id: 1, volume: '1', number: '1', name: null },
    { id: 2, volume: '1', number: '2', name: null },
  ];
  assert.equal(detectReleaseDelta('book', undefined, current), null);
});

test('detects a chapter batch as one release delta', () => {
  const previous = [
    { id: 515, volume: '1', number: '515', name: null },
    { id: 516, volume: '1', number: '516', name: null },
  ];
  const current = [
    ...previous,
    { id: 517, volume: '1', number: '517', name: null },
    { id: 518, volume: '1', number: '518', name: null },
    { id: 519, volume: '1', number: '519', name: null },
    { id: 520, volume: '1', number: '520', name: null },
  ];

  const delta = detectReleaseDelta('62387--pokemon-master-of-tactics', previous, current);
  assert.ok(delta);
  assert.equal(delta.summary, 'Chapters 517–520');
  assert.deepEqual(delta.added.map((chapter) => chapter.number), ['517', '518', '519', '520']);
});

test('uses current RanobeLib API, required Site-Id header and team catalog filter', async () => {
  const calls = [];
  const responses = new Map([
    [
      'https://api.cdnlibs.org/api/teams/11969--dom-nekromanta',
      jsonResponse({
        data: {
          id: 11969,
          slug: 'dom-nekromanta',
          slug_url: '11969--dom-nekromanta',
          name: 'Дом Некроманта',
          titles_count_details: { 3: 2 },
          stats: [{ value: 2, tag: 'titles' }],
        },
      }),
    ],
    [
      'https://api.cdnlibs.org/api/manga?target_id=11969&target_model=team&page=1',
      jsonResponse({
        data: [
          { id: 62387, slug: 'pokemon-master-of-tactics', slug_url: '62387--pokemon-master-of-tactics' },
          { id: 271368, slug: 'seiljeumaen-ui-jeonseol-i-doeeotda', slug_url: '271368--seiljeumaen-ui-jeonseol-i-doeeotda' },
        ],
        meta: { has_next_page: false },
        links: { next: null },
      }),
    ],
  ]);

  const client = new RanobeLibClient({ fetchImpl: mockFetch(responses, calls) });
  const catalog = await client.getTeamCatalog('11969--dom-nekromanta');

  assert.equal(catalog.team.id, 11969);
  assert.equal(catalog.team.ranobeTitleCount, 2);
  assert.deepEqual(catalog.books.map((book) => book.ref), [
    '62387--pokemon-master-of-tactics',
    '271368--seiljeumaen-ui-jeonseol-i-doeeotda',
  ]);

  for (const call of calls) {
    assert.equal(call.headers.get('site-id'), '3');
    assert.equal(call.headers.get('client-time-zone'), 'UTC');
    assert.equal(call.headers.get('accept'), 'application/json');
  }
});

test('filters a title chapter list to branches published by Dom Nekromanta', async () => {
  const responses = new Map([
    [
      'https://api.cdnlibs.org/api/manga/62387--pokemon-master-of-tactics?fields[]=summary',
      jsonResponse({
        data: {
          id: 62387,
          slug: 'pokemon-master-of-tactics',
          rus_name: 'Покемон: Мастер тактики',
          summary: 'x',
          cover: { default: 'cover.webp' },
        },
      }),
    ],
    [
      'https://api.cdnlibs.org/api/manga/62387--pokemon-master-of-tactics/chapters',
      jsonResponse({
        data: [
          {
            id: 100,
            volume: '1',
            number: '1',
            name: 'First',
            branches: [
              { id: 4386927, created_at: '2026-08-08T10:53:05Z', teams: [{ id: 11969 }] },
              { id: 1232892, created_at: '2021-02-01T15:51:57Z', teams: [{ id: 14820 }] },
            ],
          },
          {
            id: 101,
            volume: 1,
            number: 2,
            name: 'Second',
            branches: [
              { id: 4388544, created_at: '2026-08-08T19:30:02Z', teams: [{ id: 11969 }] },
            ],
          },
          {
            id: 102,
            volume: 1,
            number: 3,
            name: 'Other team only',
            branches: [
              { id: 1233956, created_at: '2021-02-02T01:21:55Z', teams: [{ id: 14820 }] },
            ],
          },
        ],
      }),
    ],
  ]);

  const client = new RanobeLibClient({ fetchImpl: mockFetch(responses) });
  const title = await client.getTitle('62387--pokemon-master-of-tactics');
  const chapters = await client.getChapters('62387--pokemon-master-of-tactics', 11969);

  assert.equal(title.title, 'Покемон: Мастер тактики');
  assert.equal(title.coverUrl, 'cover.webp');
  assert.deepEqual(chapters.map((chapter) => [chapter.id, chapter.number]), [
    [4386927, '1'],
    [4388544, '2'],
  ]);
});

test('refuses to treat an empty team catalog as a successful sync', async () => {
  const responses = new Map([
    [
      'https://api.cdnlibs.org/api/teams/11969--dom-nekromanta',
      jsonResponse({
        data: {
          id: 11969,
          slug: 'dom-nekromanta',
          slug_url: '11969--dom-nekromanta',
          name: 'Дом Некроманта',
          titles_count_details: { 3: 37 },
          stats: [{ value: 48, tag: 'titles' }],
        },
      }),
    ],
    [
      'https://api.cdnlibs.org/api/manga?target_id=11969&target_model=team&page=1',
      jsonResponse({ data: [], meta: { has_next_page: false }, links: { next: null } }),
    ],
  ]);

  const client = new RanobeLibClient({ fetchImpl: mockFetch(responses) });
  await assert.rejects(
    () => client.getTeamCatalog('11969--dom-nekromanta'),
    /returned zero titles/,
  );
});

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    const response = responses.get(String(url));
    if (!response) return new Response('not found', { status: 404 });
    return response.clone();
  };
}
