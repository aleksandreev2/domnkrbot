import { deliverySettingLabel, type DeliverySetting } from './telegram-notification-settings.js';

export type NotificationModeReturnContext = { origin: 'm' | 'a' | 's'; page: number };

export type NotificationModeCallback =
  | { scope: 'global'; action: 'instant' }
  | { scope: 'global'; action: 'stack'; stackSize: 5 | 10 | 20 }
  | { scope: 'global'; action: 'custom' }
  | { scope: 'title'; titleId: number; action: 'instant'; returnContext?: NotificationModeReturnContext }
  | { scope: 'title'; titleId: number; action: 'stack'; stackSize: 5 | 10 | 20; returnContext?: NotificationModeReturnContext }
  | { scope: 'title'; titleId: number; action: 'custom'; returnContext?: NotificationModeReturnContext }
  | { scope: 'title'; titleId: number; action: 'inherit'; returnContext?: NotificationModeReturnContext };

export type NotificationButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type NotificationPayload = {
  text: string;
  parse_mode: 'HTML';
  reply_markup: { inline_keyboard: NotificationButton[][] };
};

export type NotificationTitle = {
  ranobelib_id: number;
  book_ref: string;
  title: string;
  url: string;
};

export function parseNotificationModeCallback(value: string): NotificationModeCallback | null {
  let match = /^subs:mode:g:(i|5|10|20|c)$/.exec(value);
  if (match) {
    const action = match[1];
    if (action === 'i') return { scope: 'global', action: 'instant' };
    if (action === 'c') return { scope: 'global', action: 'custom' };
    const stackSize = Number(action) as 5 | 10 | 20;
    return { scope: 'global', action: 'stack', stackSize };
  }

  match = /^subs:mode:t:(\d+):(i|5|10|20|c|inherit)(?::([mas]):(\d{1,4}))?$/.exec(value);
  if (!match) return null;
  const titleId = Number(match[1]);
  if (!Number.isSafeInteger(titleId) || titleId <= 0) return null;
  const returnContext = match[3] && match[4]
    ? { origin: match[3] as NotificationModeReturnContext['origin'], page: Math.min(9999, Number(match[4])) }
    : undefined;
  const action = match[2];
  const context = returnContext ? { returnContext } : {};
  if (action === 'i') return { scope: 'title', titleId, action: 'instant', ...context };
  if (action === 'c') return { scope: 'title', titleId, action: 'custom', ...context };
  if (action === 'inherit') return { scope: 'title', titleId, action: 'inherit', ...context };
  const stackSize = Number(action) as 5 | 10 | 20;
  return { scope: 'title', titleId, action: 'stack', stackSize, ...context };
}

export function buildDeliveryModeNotificationCenter(state: {
  setting: DeliverySetting;
  allTitles: boolean;
  explicitCount: number;
  exclusionCount: number;
  overrideCount: number;
}): NotificationPayload {
  const scope = state.allTitles
    ? (state.exclusionCount > 0 ? `Все переводы, кроме ${state.exclusionCount}` : 'Все переводы')
    : (state.explicitCount > 0 ? `${state.explicitCount} ${pluralTitles(state.explicitCount)}` : 'Отключены');
  return {
    text: [
      '🔔 <b>Уведомления</b>',
      '',
      `Режим по умолчанию: ${deliverySettingLabel(state.setting)}`,
      `Подписки: ${scope}`,
      `Индивидуальные настройки: ${Math.max(0, Math.trunc(state.overrideCount || 0))}`,
      '',
      'Стаки считаются отдельно для каждого тайтла. Если порог не набрался за 7 дней, бот отправит накопившиеся главы.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: state.setting.mode === 'instant' ? '✅ ⚡ Мгновенно' : '⚡ Мгновенно', callback_data: 'subs:mode:g:i' }],
        [
          presetButton('global', null, 5, state.setting),
          presetButton('global', null, 10, state.setting),
          presetButton('global', null, 20, state.setting),
        ],
        [{ text: '⚙️ Кастомный', callback_data: 'subs:mode:g:c' }],
        [{ text: '📚 Управлять тайтлами', callback_data: 'subs:list:0' }],
        [{ text: '🔕 Отключить все', callback_data: 'subs:all:clear' }],
      ],
    },
  };
}

export function buildTitleDeliveryModePanel(state: {
  title: NotificationTitle;
  enabled: boolean;
  effectiveSetting: DeliverySetting;
  globalSetting: DeliverySetting;
  inherited: boolean;
}): NotificationPayload {
  const { title } = state;
  const inheritance = state.inherited
    ? 'Для этого тайтла используется общий режим.'
    : `Общий режим: ${deliverySettingLabel(state.globalSetting)}`;
  const rows: NotificationButton[][] = [
    [{ text: state.effectiveSetting.mode === 'instant' && !state.inherited ? '✅ ⚡ Мгновенно' : '⚡ Мгновенно', callback_data: `subs:mode:t:${title.ranobelib_id}:i` }],
    [
      presetButton('title', title.ranobelib_id, 5, state.effectiveSetting, state.inherited),
      presetButton('title', title.ranobelib_id, 10, state.effectiveSetting, state.inherited),
      presetButton('title', title.ranobelib_id, 20, state.effectiveSetting, state.inherited),
    ],
    [{ text: '⚙️ Кастомный', callback_data: `subs:mode:t:${title.ranobelib_id}:c` }],
  ];
  if (!state.inherited) {
    rows.push([{ text: '↩️ Использовать общий режим', callback_data: `subs:mode:t:${title.ranobelib_id}:inherit` }]);
  }
  rows.push([{ text: '📖 Читать', url: title.url }]);
  rows.push([{ text: '📚 Все подписки', callback_data: 'subs:list:0' }]);

  return {
    text: [
      `⚙️ <b>${escapeHtml(title.title)}</b>`,
      '',
      `Уведомления: ${state.enabled ? '✅ включены' : '🔕 отключены'}`,
      `Режим: ${deliverySettingLabel(state.effectiveSetting)}`,
      inheritance,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

function presetButton(
  scope: 'global' | 'title',
  titleId: number | null,
  stackSize: 5 | 10 | 20,
  setting: DeliverySetting,
  inherited = false,
): NotificationButton {
  const active = !inherited && setting.mode === 'stack' && setting.stackSize === stackSize;
  const prefix = active ? '✅ ' : '';
  const callback = scope === 'global'
    ? `subs:mode:g:${stackSize}`
    : `subs:mode:t:${titleId}:${stackSize}`;
  return { text: `${prefix}📦 ${stackSize}`, callback_data: callback };
}

function pluralTitles(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'тайтлов';
  if (mod10 === 1) return 'тайтл';
  if (mod10 >= 2 && mod10 <= 4) return 'тайтла';
  return 'тайтлов';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}
