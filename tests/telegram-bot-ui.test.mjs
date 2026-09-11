import assert from 'node:assert/strict';
import test from 'node:test';

async function loadUi() {
  return import('../dist-runtime/telegram-bot-ui.js');
}

async function loadPartnerUi() {
  return import('../dist-runtime/telegram-partner-collaboration-ux.js');
}

async function loadPartnerTeamUi() {
  return import('../dist-runtime/telegram-partner-team-screen.js');
}

const buttons = (payload) => payload.reply_markup.inline_keyboard.flat();

test('partner-aware root Telegram menu keeps Dom Nekromanta as the owner brand and exposes collaborations', async () => {
  const { buildMainMenu } = await loadUi();
  const payload = buildMainMenu('https://bot.example/', { collaborations: true });
  assert.match(payload.text, /<b>Дом Некроманта<\/b>/);
  assert.match(payload.text, /Официальный бот команды «Дом Некроманта»/);
  assert.match(payload.text, /Переводы, уведомления и предложения новых новелл/);
  assert.match(payload.text, /переводы наших партнёров/);
  assert.equal(payload.text.includes('☠️'), false);
  const flat = buttons(payload);
  assert.ok(flat.some((button) => button.text === '🔔 Уведомления' && button.callback_data === 'prop:notifications'));
  assert.ok(flat.some((button) => button.text === '🤝 Сотрудничества' && button.callback_data === 'subs:mt:partners:0'));
  assert.ok(flat.some((button) => button.text === '📚 Предложить новеллу' && button.callback_data === 'prop:new'));
  assert.ok(flat.some((button) => button.text === '🗂 Мои заявки' && button.callback_data === 'prop:mine'));
  assert.ok(flat.some((button) => button.text === '🌐 Сайт' && button.url === 'https://bot.example/'));
});

test('legacy-safe root menu does not expose a dead collaboration callback while multi-team UI is disabled', async () => {
  const { buildMainMenu } = await loadUi();
  const payload = buildMainMenu('https://bot.example/');
  const flat = buttons(payload);
  assert.equal(flat.some((button) => button.callback_data === 'subs:mt:partners:0'), false);
});

test('shared navigation primitives keep Back, Home, and destructive actions semantically distinct', async () => {
  const { backButton, destructiveButton, mainMenuButton } = await loadUi();
  assert.deepEqual(backButton('prop:back'), { text: '↩️ Назад', callback_data: 'prop:back' });
  assert.deepEqual(mainMenuButton(), { text: '🏠 Главное меню', callback_data: 'prop:home' });
  assert.deepEqual(mainMenuButton('subs:home'), { text: '🏠 Главное меню', callback_data: 'subs:home' });
  assert.deepEqual(destructiveButton('🗑 Отменить заявку', 'prop:cancel'), {
    text: '🗑 Отменить заявку', callback_data: 'prop:cancel',
  });
});

test('partner pagination requires a real ninth row before showing Next', async () => {
  const { buildPartnerTeamList } = await loadPartnerUi();
  const makeTeam = (index) => ({
    id: index + 1,
    displayName: `Team ${index + 1}`,
    isPrimary: false,
    followed: false,
    activeCount: 1,
    completedCount: 0,
  });

  const exactlyEight = buildPartnerTeamList({
    page: 0,
    teams: Array.from({ length: 8 }, (_, index) => makeTeam(index)),
    origin: 'partners',
  });
  assert.equal(buttons(exactlyEight).some((button) => button.text === '▶️'), false);

  const nineWithLookahead = buildPartnerTeamList({
    page: 0,
    teams: Array.from({ length: 9 }, (_, index) => makeTeam(index)),
    origin: 'partners',
  });
  assert.equal(buttons(nineWithLookahead).filter((button) => button.text.startsWith('🤝 Team')).length, 8);
  assert.equal(buttons(nineWithLookahead).some((button) => button.text === '▶️'), true);
});

test('partner team screen requires a real ninth translation before showing Next', async () => {
  const { buildPartnerAwareTeamScreen } = await loadPartnerTeamUi();
  const team = { id: 7, displayName: 'Блинная Беса', isPrimary: false, followed: true, activeCount: 8, completedCount: 0 };
  const makeTranslation = (index) => ({
    teamId: 7,
    teamName: 'Блинная Беса',
    teamIsPrimary: false,
    ranobelibId: 1000 + index,
    bookRef: `${1000 + index}--book-${index}`,
    title: `Book ${index}`,
    url: `https://ranobelib.me/ru/book/${1000 + index}--book-${index}`,
    semanticStatus: 'active',
    enabled: true,
    enabledReason: 'team',
  });

  const exactlyEight = buildPartnerAwareTeamScreen({
    team,
    translations: Array.from({ length: 8 }, (_, index) => makeTranslation(index)),
    completed: false,
    page: 0,
  });
  assert.equal(buttons(exactlyEight).some((button) => button.text === '▶️'), false);

  const nineWithLookahead = buildPartnerAwareTeamScreen({
    team: { ...team, activeCount: 9 },
    translations: Array.from({ length: 9 }, (_, index) => makeTranslation(index)),
    completed: false,
    page: 0,
  });
  assert.equal(buttons(nineWithLookahead).filter((button) => button.text.startsWith('🔔 Book')).length, 8);
  assert.equal(buttons(nineWithLookahead).some((button) => button.text === '▶️'), true);
});
