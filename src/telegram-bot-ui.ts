export type TelegramButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TelegramPayload = {
  text: string;
  parse_mode?: 'HTML';
  reply_markup: { inline_keyboard: TelegramButton[][] };
};

export function buildMainMenu(origin: string): TelegramPayload {
  const base = origin.replace(/\/+$/, '');
  return {
    text: '<b>Дом Некроманта</b>\n\nПереводы, уведомления и предложения новых новелл.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔔 Уведомления', callback_data: 'prop:notifications' }],
        [{ text: '📚 Предложить новеллу', callback_data: 'prop:new' }],
        [{ text: '🗂 Мои заявки', callback_data: 'prop:mine' }],
        [{ text: '🌐 Сайт', url: `${base}/` }],
      ],
    },
  };
}

export function mainMenuButton(callbackData = 'prop:home'): TelegramButton & { callback_data: string } {
  return { text: '🏠 Главное меню', callback_data: callbackData };
}

export function backButton(callbackData: string): TelegramButton {
  return { text: '↩️ Назад', callback_data: callbackData };
}

export function destructiveButton(text: string, callbackData: string): TelegramButton {
  return { text, callback_data: callbackData };
}
