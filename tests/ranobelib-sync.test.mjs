import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RanobeLibClient,
  detectReleaseDelta,
  discoverTeamBooksFromHtml,
} from '../dist/index.js';

test('discovers and deduplicates real Dom Nekromanta-style RanobeLib book links', () => {
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

test('normalizes title and chapter API payloads through the client', async () => {
  const responses = new Map([
    [
      'https://api2.mangalib.me/api/manga/62387--pokemon-master-of-tactics?fields[]=summary',
      new Response(JSON.stringify({ data: { id: 62387, rus_name: 'Покемон: Мастер тактики', summary: 'x', cover: { default: 'cover.webp' } } }), { headers: { 'content-type': 'application/json' } }),
    ],
    [
      'https://api2.mangalib.me/api/manga/62387--pokemon-master-of-tactics/chapters',
      new Response(JSON.stringify({ data: [
        { id: 2, volume: 1, number: '2', name: 'Second' },
        { id: 1, volume: '1', number: 1, name: 'First' },
      ] }), { headers: { 'content-type': 'application/json' } }),
    ],
  ]);

  const fetchImpl = async (url) => {
    const response = responses.get(String(url));
    if (!response) return new Response('not found', { status: 404 });
    return response.clone();
  };

  const client = new RanobeLibClient({ fetchImpl });
  const title = await client.getTitle('62387--pokemon-master-of-tactics');
  const chapters = await client.getChapters('62387--pokemon-master-of-tactics');

  assert.equal(title.title, 'Покемон: Мастер тактики');
  assert.equal(title.coverUrl, 'cover.webp');
  assert.deepEqual(chapters.map((chapter) => chapter.number), ['1', '2']);
});
