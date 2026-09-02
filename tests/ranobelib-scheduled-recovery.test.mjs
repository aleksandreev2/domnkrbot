import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('recovers a scheduled chapter that was snapshotted before its release time exactly once', async () => {
  const ranobelib = await import('../dist/index.js');
  assert.equal(typeof ranobelib.detectScheduledReleaseTransitions, 'function');

  const previous = [
    {
      id: 52,
      volume: '1',
      number: '52',
      name: 'Отложка',
      firstSeenAt: '2026-09-01T10:00:00.000Z',
    },
  ];
  const current = [
    {
      id: 52,
      volume: '1',
      number: '52',
      name: 'Отложка',
      releasedAt: '2026-09-02T05:00:00.000Z',
    },
  ];

  const recovered = ranobelib.detectScheduledReleaseTransitions(
    previous,
    current,
    new Date('2026-09-02T06:00:00.000Z').getTime(),
  );
  assert.deepEqual(recovered.map((chapter) => chapter.number), ['52']);

  const notYetReleased = ranobelib.detectScheduledReleaseTransitions(
    previous,
    current,
    new Date('2026-09-02T04:59:59.000Z').getTime(),
  );
  assert.deepEqual(notYetReleased, []);

  const normallyObserved = ranobelib.detectScheduledReleaseTransitions(
    [{ ...previous[0], firstSeenAt: '2026-09-02T05:00:01.000Z' }],
    current,
    new Date('2026-09-02T06:00:00.000Z').getTime(),
  );
  assert.deepEqual(normallyObserved, []);
});

test('recovers only fresh chapters after an empty snapshot outage instead of replaying old history', async () => {
  const ranobelib = await import('../dist/index.js');
  assert.equal(typeof ranobelib.detectRecentBootstrapReleaseCandidates, 'function');

  const now = new Date('2026-09-02T06:30:00.000Z').getTime();
  const current = [
    {
      id: 14,
      volume: '1',
      number: '14',
      name: 'Старая глава',
      releasedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      id: 15,
      volume: '1',
      number: '15',
      name: 'Свежая глава',
      releasedAt: '2026-09-02T05:03:00.000Z',
    },
    {
      id: 16,
      volume: '1',
      number: '16',
      name: 'Ещё не опубликована',
      releasedAt: '2026-09-02T07:00:00.000Z',
    },
    {
      id: 13,
      volume: '1',
      number: '13',
      name: 'Без времени публикации',
    },
  ];

  const recovered = ranobelib.detectRecentBootstrapReleaseCandidates(current, now);
  assert.deepEqual(recovered.map((chapter) => chapter.number), ['15']);
});

test('runtime wires recent bootstrap recovery into release creation', () => {
  const runtime = readFileSync(new URL('../src/ranobelib-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /detectRecentBootstrapReleaseCandidates/);
  assert.match(runtime, /last_release_at/);
});
