import assert from 'node:assert/strict';
import test from 'node:test';

async function loadUi() {
  return import('../dist-runtime/telegram-bot-ui.js');
}

const buttons = (payload) => payload.reply_markup.inline_keyboard.flat();

test('root Telegram menu keeps Dom Nekromanta as the owner brand and exposes collaborations', async () => {
  const { buildMainMenu } = await loadUi();
  const payload = buildMainMenu('https://bot.example/');
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

test('shared navigation primitives keep Back, Home, and destructive actions semantically distinct', async () => {
  const { backButton, destructiveButton, mainMenuButton } = await loadUi();
  assert.deepEqual(backButton('prop:back'), { text: '↩️ Назад', callback_data: 'prop:back' });
  assert.deepEqual(mainMenuButton(), { text: '🏠 Главное меню', callback_data: 'prop:home' });
  assert.deepEqual(mainMenuButton('subs:home'), { text: '🏠 Главное меню', callback_data: 'subs:home' });
  assert.deepEqual(destructiveButton('🗑 Отменить заявку', 'prop:cancel'), {
    text: '🗑 Отменить заявку', callback_data: 'prop:cancel',
  });
});
