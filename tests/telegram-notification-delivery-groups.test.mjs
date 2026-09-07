import assert from 'node:assert/strict';
import test from 'node:test';

async function loadDelivery() {
  return import('../dist-runtime/telegram-notification-delivery-groups.js');
}

const NOW = Date.parse('2026-09-08T12:00:00Z');

function candidate(overrides = {}) {
  return {
    deliveryMode: 'stack',
    stackSize: 10,
    pendingChapters: 1,
    oldestPendingAt: '2026-09-08T11:00:00Z',
    retryBlocked: false,
    ...overrides,
  };
}

test('instant groups are ready immediately while a future retry blocks the whole title', async () => {
  const delivery = await loadDelivery();
  assert.equal(delivery.notificationGroupReady(candidate({ deliveryMode: 'instant', stackSize: null }), NOW), true);
  assert.equal(delivery.notificationGroupReady(candidate({ deliveryMode: 'instant', stackSize: null, retryBlocked: true }), NOW), false);
});

test('stack groups become ready at threshold and send threshold overflow as one group', async () => {
  const delivery = await loadDelivery();
  assert.equal(delivery.notificationGroupReady(candidate({ pendingChapters: 9 }), NOW), false);
  assert.equal(delivery.notificationGroupReady(candidate({ pendingChapters: 10 }), NOW), true);
  assert.equal(delivery.notificationGroupReady(candidate({ pendingChapters: 13 }), NOW), true);
});

test('partial stack flushes seven days after the oldest pending member and later chapters do not move that anchor', async () => {
  const delivery = await loadDelivery();
  assert.equal(delivery.notificationGroupReady(candidate({
    pendingChapters: 3,
    oldestPendingAt: '2026-09-01T12:00:01Z',
  }), NOW), false);
  assert.equal(delivery.notificationGroupReady(candidate({
    pendingChapters: 3,
    oldestPendingAt: '2026-09-01T12:00:00Z',
  }), NOW), true);
});

test('corrupt or missing stack configuration fails safe to instant instead of suppressing delivery', async () => {
  const delivery = await loadDelivery();
  assert.equal(delivery.notificationGroupReady(candidate({ deliveryMode: 'stack', stackSize: 1, pendingChapters: 1 }), NOW), true);
  assert.equal(delivery.notificationGroupReady(candidate({ deliveryMode: 'unknown', stackSize: null, pendingChapters: 1 }), NOW), true);
});

test('claimed release rows aggregate by user and title and sum chapter counts', async () => {
  const delivery = await loadDelivery();
  const rows = [
    {
      release_id: 'r1', user_telegram_id: '42', book_ref: '77--book', ranobelib_id: 77,
      title: 'Book', url: 'https://ranobelib.me/ru/book/77--book', chapter_count: 8,
      first_volume: '1', first_number: '1', last_volume: '1', last_number: '8', summary: '1-8',
    },
    {
      release_id: 'r2', user_telegram_id: '42', book_ref: '77--book', ranobelib_id: 77,
      title: 'Book', url: 'https://ranobelib.me/ru/book/77--book', chapter_count: 5,
      first_volume: '1', first_number: '9', last_volume: '1', last_number: '13', summary: '9-13',
    },
    {
      release_id: 'r3', user_telegram_id: '42', book_ref: '88--other', ranobelib_id: 88,
      title: 'Other', url: 'https://ranobelib.me/ru/book/88--other', chapter_count: 2,
      first_volume: '1', first_number: '4', last_volume: '1', last_number: '5', summary: '4-5',
    },
  ];

  const groups = delivery.aggregateClaimedDeliveryRows(rows);
  assert.equal(groups.length, 2);
  const book = groups.find((group) => group.bookRef === '77--book');
  assert.ok(book);
  assert.equal(book.userTelegramId, '42');
  assert.equal(book.chapterCount, 13);
  assert.equal(book.members.length, 2);
  assert.equal(book.firstVolume, '1');
  assert.equal(book.firstNumber, '1');
  assert.equal(book.lastVolume, '1');
  assert.equal(book.lastNumber, '13');
});
