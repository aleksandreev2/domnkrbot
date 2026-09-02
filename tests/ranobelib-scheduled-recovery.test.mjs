import assert from 'node:assert/strict';
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