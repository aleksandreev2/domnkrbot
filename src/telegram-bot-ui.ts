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

export type MainMenuOptions = {
  collaborations?: boolean;
};

export function buildMainMenu(origin: string, options: MainMenuOptions = {}): TelegramPayload {
  const base = origin.replace(/\/+$/, '');
  const collaborations = options.collaborations === true;
  return {
    text: collaborations
      ? [
          '<b>Дом Некроманта</b>',
          '',
          'Официальный бот команды «Дом Некроманта».',
          'Переводы, уведомления и предложения новых новелл.',
          '',
          '🤝 Здесь также доступны переводы наших партнёров.',
        ].join('\n')
      : '<b>Дом Некроманта</b>\n\nПереводы, уведомления и предложения новых новелл.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔔 Уведомления', callback_data: 'prop:notifications' }],
        ...(collaborations ? [[{ text: '🤝 Сотрудничества', callback_data: 'subs:mt:partners:0' }]] : []),
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
