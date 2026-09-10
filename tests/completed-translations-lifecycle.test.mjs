import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const teamCatalogPrefix = 'https://api.cdnlibs.org/api/manga?';

function telegramCallbacks(payload) {
  return payload.reply_markup.inline_keyboard.flat()
    .map((button) => button.callback_data)
    .filter(Boolean);
}

test('RanobeLib team discovery requests and preserves translation status metadata', async () => {
  const { RanobeLibClient } = await import('../dist/index.js');
  const requests = [];
  const client = new RanobeLibClient({
    fetchImpl: async (url) => {
      requests.push(String(url));
      return Response.json({
        data: [{
          id: 1000,
          slug: 'one',
          slug_url: '1000--one',
          rus_name: 'Книга 1',
          cover: { default: 'https://example.test/cover.jpg' },
          scanlateStatus: { id: 2, label: 'Завершен' },
        }],
        meta: { has_next_page: false },
      });
    },
  });

  const [book] = await client.discoverTeamBooks('11969--dom-nekromanta');
  const teamRequest = requests.find((url) => url.startsWith(teamCatalogPrefix));
  assert.ok(teamRequest, 'team catalog request must be issued');
  assert.match(teamRequest, /(?:\?|&)fields%5B%5D=status_id|(?:\?|&)fields\[\]=status_id/);
  assert.equal(book.translationStatusId, 2);
  assert.equal(book.translationStatusLabel, 'Завершен');
});

test('notification UX exposes completed translations and marks completed search results', async () => {
  const ux = await import('../dist-runtime/telegram-notification-ux.js');
  const dashboard = ux.buildNotificationDashboard({
    effectiveCount: 4,
    allTitles: false,
    globalSetting: { mode: 'instant', stackSize: null },
    overrideCount: 0,
  });
  assert.ok(telegramCallbacks(dashboard).includes('subs:completed:0'));

  const completed = {
    ranobelib_id: 1000,
    book_ref: '1000--one',
    title: 'Книга 1',
    url: 'https://ranobelib.me/ru/book/1000--one',
    translation_status_id: 2,
  };
  const list = ux.buildNotificationTitleList({ kind: 'completed', rows: [completed], page: 0 });
  assert.match(list.text, /Переведённые новеллы/);
  assert.ok(telegramCallbacks(list).includes('subs:title:1000:c:0'));
  assert.equal(list.reply_markup.inline_keyboard[0][0].text.startsWith('✅'), true);

  const search = ux.buildNotificationSearchResults({
    query: 'Книга',
    rows: [completed],
    page: 0,
    returnScope: 'home',
  });
  assert.equal(search.reply_markup.inline_keyboard[0][0].text.startsWith('✅'), true);
  assert.deepEqual(ux.parseNotificationUxCallback('subs:completed:3'), { kind: 'completed-list', page: 3 });
});

test('completed title card is read-only except removing a sleeping subscription', async () => {
  const ux = await import('../dist-runtime/telegram-notification-ux.js');
  const payload = ux.buildNotificationTitleCard({
    title: {
      ranobelib_id: 1000,
      book_ref: '1000--one',
      title: 'Книга 1',
      url: 'https://ranobelib.me/ru/book/1000--one',
      translation_status_id: 2,
    },
    enabled: true,
    completed: true,
    inherited: true,
    effectiveSetting: { mode: 'stack', stackSize: 10 },
    globalSetting: { mode: 'stack', stackSize: 10 },
    pendingChapterCount: 2,
    returnContext: { origin: 'c', page: 0 },
  });
  assert.match(payload.text, /Перевод завершён/);
  assert.match(payload.text, /Подписка сохранена/);
  assert.doesNotMatch(payload.text, /Накоплено:/);
  const data = telegramCallbacks(payload);
  assert.ok(data.includes('subs:title:toggle:1000:c:0'));
  assert.equal(data.some((value) => value.startsWith('subs:title:mode:')), false);
});

test('completion makes a partial stack ready and does not count the synthetic event as a chapter', async () => {
  const delivery = await import('../dist-runtime/telegram-notification-delivery-groups.js');
  assert.equal(delivery.notificationGroupReady({
    deliveryMode: 'stack',
    stackSize: 10,
    pendingChapters: 2,
    oldestPendingAt: new Date().toISOString(),
    retryBlocked: false,
    translationCompleted: true,
  }), true);

  const [group] = delivery.aggregateClaimedDeliveryRows([
    {
      release_id: 'r-chapters', user_telegram_id: '42', book_ref: '1000--one', ranobelib_id: 1000,
      title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one', release_kind: 'chapters',
      chapter_count: 2, first_volume: '1', first_number: '9', last_volume: '1', last_number: '10', summary: '9-10',
    },
    {
      release_id: 'r-complete', user_telegram_id: '42', book_ref: '1000--one', ranobelib_id: 1000,
      title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one', release_kind: 'translation_completed',
      chapter_count: 0, first_volume: null, first_number: null, last_volume: null, last_number: null, summary: 'Перевод завершён',
    },
  ]);
  assert.equal(group.translationCompleted, true);
  assert.equal(group.chapterCount, 2);
  assert.equal(group.firstNumber, '9');
  assert.equal(group.lastNumber, '10');
});

test('completion notification combines pending chapters with the final status', async () => {
  const { formatTranslationCompletionNotification } = await import('../dist-runtime/telegram-translation-completion.js');
  const payload = formatTranslationCompletionNotification({
    title: 'Книга 1',
    url: 'https://ranobelib.me/ru/book/1000--one',
    chapterCount: 2,
    firstNumber: '9',
    lastNumber: '10',
  });
  assert.match(payload.text, /Перевод завершён/);
  assert.match(payload.text, /9–10|9-10/);
  assert.match(payload.text, /Этими главами перевод тайтла завершён/);
  assert.ok(telegramCallbacks(payload).includes('subs:completed:0'));
});

test('schema persists completion lifecycle and fanout uses the existing outbox', () => {
  const migrationUrl = new URL('../migrations/0020_translation_completion_lifecycle.sql', import.meta.url);
  assert.equal(existsSync(migrationUrl), true, 'translation lifecycle migration must exist');
  const migration = readFileSync(migrationUrl, 'utf8');
  assert.match(migration, /translation_status_id/i);
  assert.match(migration, /release_kind/i);
  assert.match(migration, /translation_completed/i);
  assert.match(migration, /OLD\.translation_status_id\s+IS\s+NOT\s+NULL/i);
  assert.match(migration, /telegram_notification_callback_dedup/i);

  const delivery = readFileSync(new URL('../src/telegram-notification-delivery.ts', import.meta.url), 'utf8');
  assert.match(delivery, /release_kind/i);
  assert.match(delivery, /translation_completed/i);

  const runtime = readFileSync(new URL('../src/telegram-notification-ux-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /translation_status_id\s*=\s*2/i);
  assert.match(runtime, /is_active\s*=\s*1/i);
});

class PromptStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() { return null; }
  async all() { return { results: [] }; }
  async run() {
    if (/INSERT OR IGNORE INTO telegram_notification_callback_dedup/i.test(this.query)) {
      const id = String(this.values[0]);
      if (this.db.callbacks.has(id)) return { meta: { changes: 0 } };
      this.db.callbacks.add(id);
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
}

class PromptDB {
  constructor() { this.callbacks = new Set(); }
  prepare(query) { return new PromptStatement(this, query); }
}

test('redelivered custom-stack callback sends the input prompt only once', async () => {
  const { handleTelegramNotificationModeUpdate } = await import('../dist-runtime/telegram-notification-mode-runtime.js');
  const db = new PromptDB();
  const update = {
    callback_query: {
      id: 'same-callback-id',
      from: { id: 42, first_name: 'Reader' },
      data: 'subs:mode:g:c',
      message: { message_id: 9, chat: { id: 42, type: 'private' } },
    },
  };
  const env = { DB: db, TELEGRAM_BOT_TOKEN: 'unit-test-token' };
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ method: String(url).split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  try {
    await handleTelegramNotificationModeUpdate(update, env);
    await handleTelegramNotificationModeUpdate(update, env);
  } finally {
    globalThis.fetch = original;
  }
  const prompts = calls.filter((call) => call.method === 'sendMessage' && /размер стака/i.test(call.payload.text || ''));
  assert.equal(prompts.length, 1);
});
