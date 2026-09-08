import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const callbacks = (payload) => payload.reply_markup.inline_keyboard.flat()
  .map((button) => button.callback_data)
  .filter(Boolean);

const title = {
  ranobelib_id: 101,
  book_ref: '101--test-title',
  title: 'Тестовый тайтл',
  url: 'https://ranobelib.me/ru/book/101--test-title',
};
const instant = { mode: 'instant', stackSize: null };
const stack10 = { mode: 'stack', stackSize: 10 };

const proposalSession = (overrides = {}) => ({
  step: 'review',
  source_kind: 'external',
  ranobelib_book_ref: null,
  title: 'Тестовая новелла',
  original_title: '',
  source_url: 'https://example.com/original',
  raw_file_id: null,
  raw_file_name: null,
  raw_file_size: null,
  comment: 'Комментарий',
  return_to_review: 0,
  ...overrides,
});

const callbackUpdate = (data) => ({
  callback_query: {
    id: 'callback-1',
    from: { id: 101, first_name: 'Test' },
    data,
    message: { message_id: 77, chat: { id: 101, type: 'private' } },
  },
});

const webhookRequest = (update, secret) => new Request('https://bot.example/telegram/webhook', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
  },
  body: JSON.stringify(update),
});

const forbiddenDb = {
  prepare() {
    throw new Error('D1 must not be touched');
  },
};

test('notification journey preserves dashboard, list, title, mode, search and Home contexts', async () => {
  const botUi = await import('../dist-runtime/telegram-bot-ui.js');
  const ux = await import('../dist-runtime/telegram-notification-ux.js');

  const root = botUi.buildMainMenu('https://bot.example');
  assert.ok(callbacks(root).includes('prop:notifications'));

  const dashboard = ux.buildNotificationDashboard({
    effectiveCount: 3,
    allTitles: false,
    globalSetting: stack10,
    overrideCount: 1,
  });
  for (const route of ['subs:mine:0', 'subs:search:h', 'subs:all:0', 'subs:mode:home', 'prop:home']) {
    assert.ok(callbacks(dashboard).includes(route), `dashboard must expose ${route}`);
  }

  const mine = ux.buildNotificationTitleList({ kind: 'mine', rows: [title], page: 0 });
  assert.ok(callbacks(mine).includes('subs:title:101:m:0'));

  const card = ux.buildNotificationTitleCard({
    title,
    enabled: true,
    inherited: false,
    effectiveSetting: stack10,
    globalSetting: instant,
    pendingChapterCount: 4,
    returnContext: { origin: 'm', page: 0 },
  });
  assert.ok(callbacks(card).includes('subs:title:mode:101:m:0'));
  assert.ok(callbacks(card).includes('subs:mine:0'));
  assert.ok(callbacks(card).includes('prop:home'));
  assert.match(card.text, /Накоплено:\s*4\s*\/\s*10/i);

  const mode = ux.buildNotificationTitleModeScreen({
    title,
    enabled: true,
    inherited: false,
    effectiveSetting: stack10,
    globalSetting: instant,
    returnContext: { origin: 'm', page: 0 },
  });
  assert.ok(callbacks(mode).includes('subs:title:101:m:0'), 'Back from mode must return to the same title card');

  const search = ux.buildNotificationSearchResults({
    query: 'тест',
    rows: [title],
    page: 2,
    returnScope: 'home',
  });
  assert.ok(callbacks(search).includes('subs:title:101:s:2'));
  const searchCard = ux.buildNotificationTitleCard({
    title,
    enabled: true,
    inherited: true,
    effectiveSetting: instant,
    globalSetting: instant,
    pendingChapterCount: null,
    returnContext: { origin: 's', page: 2 },
  });
  assert.ok(callbacks(searchCard).includes('subs:search:page:2'), 'Back from a search result card must preserve the results page');
});

test('proposal journey exposes resume, safe Back/Home, field editing, recovery and explicit deletion', async () => {
  const ui = await import('../dist-runtime/telegram-title-proposal-ui.js');
  const session = proposalSession();

  const resume = ui.buildProposalResume(session);
  for (const route of ['prop:resume', 'prop:cancel', 'prop:home']) {
    assert.ok(callbacks(resume).includes(route), `resume screen must expose ${route}`);
  }

  const review = ui.buildProposalReview(session);
  for (const route of [
    'prop:submit',
    'prop:edit:title',
    'prop:edit:source',
    'prop:edit:raw',
    'prop:edit:comment',
    'prop:back',
    'prop:home',
  ]) {
    assert.ok(callbacks(review).includes(route), `review must expose ${route}`);
  }

  const error = ui.buildProposalRanobeLibError();
  for (const route of ['prop:retry:ranobelib', 'prop:query:again', 'prop:back', 'prop:home']) {
    assert.ok(callbacks(error).includes(route), `RanobeLib recovery must expose ${route}`);
  }

  const stale = ui.buildProposalStale();
  assert.ok(callbacks(stale).includes('prop:start:again'));
  assert.ok(callbacks(stale).includes('prop:home'));

  const deletion = ui.buildProposalDeleteConfirmation();
  assert.ok(callbacks(deletion).includes('prop:cancel:confirm'));
  assert.ok(callbacks(deletion).includes('prop:cancel:keep'));
  assert.equal(callbacks(deletion).includes('prop:home'), false, 'delete confirmation itself must require an explicit yes/no choice');
});

test('historical Telegram callbacks still route into useful v2 behavior', async () => {
  const ux = await import('../dist-runtime/telegram-notification-ux.js');
  const legacySubscriptions = await import('../dist-runtime/telegram-subscriptions.js');

  assert.deepEqual(ux.parseNotificationUxCallback('subs:title:101:3'), {
    kind: 'title', titleId: 101, origin: 'a', page: 3,
  });
  assert.deepEqual(legacySubscriptions.parseSubscriptionCallback('subs:notify:settings:101'), {
    kind: 'notify-settings', titleId: 101,
  });
  assert.deepEqual(legacySubscriptions.parseSubscriptionCallback('subs:notify:toggle:101'), {
    kind: 'notify-toggle', titleId: 101,
  });

  const subscriptionWebhook = await read('src/telegram-subscription-webhook.ts');
  assert.match(subscriptionWebhook, /data\s*!==\s*['"]prop:notifications['"]/);
  assert.match(subscriptionWebhook, /data:\s*['"]subs:center['"]/);

  const cabinet = await read('src/telegram-title-proposal-cabinet.ts');
  assert.match(cabinet, /if\s*\(!body\s*\|\|\s*body\.includes\(['"]:['"]\)\)\s*return null;/);
  assert.match(cabinet, /return\s*\{\s*proposalId:\s*body,\s*filter:\s*null,\s*page:\s*0\s*\}/);
});

test('proposal v2 webhook fails closed when Telegram secret is missing', async () => {
  const proposalV2 = await import('../dist-runtime/telegram-title-proposals-v2.js');
  const result = await proposalV2.handleTelegramTitleProposalV2WebhookRequest(
    webhookRequest(callbackUpdate('prop:home')),
    { DB: forbiddenDb },
  );
  assert.equal(result, null);
});

test('proposal cabinet webhook fails closed when Telegram secret is missing', async () => {
  const cabinet = await import('../dist-runtime/telegram-title-proposal-cabinet.js');
  const result = await cabinet.handleTelegramTitleProposalCabinetWebhookRequest(
    webhookRequest(callbackUpdate('prop:mine')),
    { DB: forbiddenDb },
  );
  assert.equal(result, null);
});

test('proposal v2 leaves an unclaimed submit update readable for the next webhook handler', async () => {
  const proposalV2 = await import('../dist-runtime/telegram-title-proposals-v2.js');
  const update = callbackUpdate('prop:submit');
  const request = webhookRequest(update, 'secret');
  assert.equal(await proposalV2.handleTelegramTitleProposalV2WebhookRequest(request, {
    DB: forbiddenDb,
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  }), null);
  assert.deepEqual(await request.clone().json(), update);
});

test('proposal cabinet leaves an unclaimed submit update readable for the legacy submit handler', async () => {
  const cabinet = await import('../dist-runtime/telegram-title-proposal-cabinet.js');
  const update = callbackUpdate('prop:submit');
  const request = webhookRequest(update, 'secret');
  assert.equal(await cabinet.handleTelegramTitleProposalCabinetWebhookRequest(request, {
    DB: forbiddenDb,
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  }), null);
  assert.deepEqual(await request.clone().json(), update);
});

test('legacy handoff screens reached from v2 submit/release controls stay non-destructive and skull-free', async () => {
  const files = [
    'src/telegram-bot-ui.ts',
    'src/telegram-title-proposal-ui.ts',
    'src/telegram-title-proposals-v2.ts',
    'src/telegram-title-proposal-cabinet.ts',
    'src/telegram-notification-ux.ts',
    'src/telegram-notification-ux-runtime.ts',
    'src/telegram-subscription-webhook.ts',
    'src/telegram-subscriptions.ts',
    'src/telegram-title-proposals.ts',
  ];
  for (const path of files) {
    const source = await read(path);
    assert.equal(source.includes('☠'), false, `${path} must not contain the skull character`);
  }

  const proposal = await read('src/telegram-title-proposals.ts');
  assert.doesNotMatch(
    proposal,
    /text:\s*['"`][^'"`]*(?:Главное меню|В меню)[^'"`]*['"`]\s*,\s*callback_data:\s*['"]prop:cancel['"]/i,
    'menu navigation reached after submit/duplicate must never invoke destructive cancellation',
  );
  assert.doesNotMatch(
    proposal,
    /callback_data:\s*['"]prop:edit['"]/,
    'legacy recovery must not emit the obsolete bare prop:edit callback',
  );
  assert.match(proposal, /data\s*===\s*['"]prop:submit['"]/);
  assert.match(proposal, /callback_data:\s*`prop:view:\$\{id\}`/);
  assert.match(proposal, /callback_data:\s*['"]prop:home['"]/);
});

test('README describes the v2 Telegram navigation and recoverable notification workflow', async () => {
  const readme = await read('README.md');
  assert.match(readme, /черновик/i);
  assert.match(readme, /возобнов|продолж/i);
  assert.match(readme, /уведомлен[ия\w]*[\s\S]{0,500}поиск|поиск[\s\S]{0,500}уведомлен/i);
  assert.match(readme, /карточк[аи]\s+тайтл/i);
  assert.match(readme, /стак/i);
  assert.match(readme, /накоп/i);
});
