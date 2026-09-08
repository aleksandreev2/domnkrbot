import { mainMenuButton, type TelegramButton, type TelegramPayload } from './telegram-bot-ui.js';

export type NotificationUiTitle = {
  ranobelib_id: number;
  book_ref: string;
  title: string;
  url: string;
};

export type NotificationDeliverySetting = {
  mode: 'instant' | 'stack';
  stackSize: number | null;
};

export type NotificationReturnContext = {
  origin: 'm' | 'a' | 's';
  page: number;
};

export type NotificationSearchReturnScope = 'home' | 'mine' | 'all';

export type NotificationUxCallback =
  | { kind: 'dashboard' }
  | { kind: 'mine'; page: number }
  | { kind: 'all-list'; page: number }
  | { kind: 'title'; titleId: number; origin: NotificationReturnContext['origin']; page: number }
  | { kind: 'toggle'; titleId: number; origin: NotificationReturnContext['origin']; page: number }
  | { kind: 'title-mode'; titleId: number; origin: NotificationReturnContext['origin']; page: number }
  | { kind: 'search-start'; returnScope: NotificationSearchReturnScope }
  | { kind: 'search-page'; page: number }
  | { kind: 'search-again' }
  | { kind: 'clear-confirm' }
  | { kind: 'clear-yes' }
  | { kind: 'mode-home' };

const PAGE_SIZE = 8;

export function buildNotificationDashboard(state: {
  effectiveCount: number;
  allTitles: boolean;
  globalSetting: NotificationDeliverySetting;
  overrideCount: number;
}): TelegramPayload {
  const subscriptions = state.allTitles
    ? `все переводы (${Math.max(0, Math.trunc(state.effectiveCount))})`
    : `${Math.max(0, Math.trunc(state.effectiveCount))} ${pluralTitles(state.effectiveCount)}`;
  return {
    text: [
      '🔔 <b>Уведомления</b>',
      '',
      `Подписки: ${subscriptions}`,
      `Режим по умолчанию: ${formatDeliverySetting(state.globalSetting)}`,
      `Индивидуальные настройки: ${Math.max(0, Math.trunc(state.overrideCount))}`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📚 Мои подписки', callback_data: 'subs:mine:0' }],
        [{ text: '🔎 Найти тайтл', callback_data: 'subs:search:h' }],
        [{ text: '📖 Все переводы', callback_data: 'subs:all:0' }],
        [{ text: '⚙️ Режим доставки', callback_data: 'subs:mode:home' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildNotificationTitleList(input: {
  kind: 'mine' | 'all';
  rows: NotificationUiTitle[];
  page: number;
}): TelegramPayload {
  const page = safePage(input.page);
  const origin = input.kind === 'mine' ? 'm' : 'a';
  const title = input.kind === 'mine' ? 'Мои подписки' : 'Все переводы';
  const rows: TelegramButton[][] = input.rows.slice(0, PAGE_SIZE).map((item) => [{
    text: `📚 ${truncate(item.title, 46)}`,
    callback_data: `subs:title:${item.ranobelib_id}:${origin}:${page}`,
  }]);

  const pager: TelegramButton[] = [];
  if (page > 0) pager.push({
    text: '◀️',
    callback_data: input.kind === 'mine' ? `subs:mine:${page - 1}` : `subs:all:${page - 1}`,
  });
  pager.push({ text: `${page + 1}`, callback_data: 'subs:noop' });
  if (input.rows.length >= PAGE_SIZE) pager.push({
    text: '▶️',
    callback_data: input.kind === 'mine' ? `subs:mine:${page + 1}` : `subs:all:${page + 1}`,
  });
  if (pager.length > 1) rows.push(pager);

  rows.push([{ text: '🔎 Найти тайтл', callback_data: `subs:search:${origin}` }]);
  if (input.kind === 'mine') {
    rows.push([{ text: '🔕 Отключить все', callback_data: 'subs:all:clear:confirm' }]);
  }
  rows.push([{ text: '↩️ К уведомлениям', callback_data: 'subs:center' }]);
  rows.push([mainMenuButton()]);

  return {
    text: input.rows.length
      ? `📚 <b>${title}</b>\n\nНажмите на тайтл, чтобы открыть его настройки.`
      : `📚 <b>${title}</b>\n\nЗдесь пока ничего нет.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildNotificationSearchPrompt(returnScope: NotificationSearchReturnScope): TelegramPayload {
  return {
    text: [
      '🔎 <b>Поиск тайтла</b>',
      '',
      'Введите название тайтла или его часть.',
      'Поиск идёт по переводам, которые уже есть в каталоге бота.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '↩️ Назад', callback_data: searchReturnCallback(returnScope) }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildNotificationSearchResults(input: {
  query: string;
  rows: NotificationUiTitle[];
  page: number;
  returnScope: NotificationSearchReturnScope;
}): TelegramPayload {
  const page = safePage(input.page);
  const rows: TelegramButton[][] = input.rows.slice(0, PAGE_SIZE).map((item) => [{
    text: `📚 ${truncate(item.title, 46)}`,
    callback_data: `subs:title:${item.ranobelib_id}:s:${page}`,
  }]);

  const pager: TelegramButton[] = [];
  if (page > 0) pager.push({ text: '◀️', callback_data: `subs:search:page:${page - 1}` });
  pager.push({ text: `${page + 1}`, callback_data: 'subs:noop' });
  if (input.rows.length >= PAGE_SIZE) pager.push({ text: '▶️', callback_data: `subs:search:page:${page + 1}` });
  if (pager.length > 1) rows.push(pager);

  rows.push([{ text: '🔎 Искать снова', callback_data: 'subs:search:again' }]);
  rows.push([{ text: '↩️ Назад', callback_data: searchReturnCallback(input.returnScope) }]);
  rows.push([mainMenuButton()]);

  const query = escapeHtml(String(input.query ?? '').trim());
  return {
    text: input.rows.length
      ? `🔎 <b>Результаты поиска</b>\n\nЗапрос: <b>${query}</b>\nНажмите на тайтл, чтобы открыть его настройки.`
      : `🔎 <b>Ничего не найдено</b>\n\nПо запросу <b>${query}</b> ничего не найдено. Попробуйте другое название.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildNotificationTitleCard(input: {
  title: NotificationUiTitle;
  enabled: boolean;
  inherited: boolean;
  effectiveSetting: NotificationDeliverySetting;
  globalSetting: NotificationDeliverySetting;
  pendingChapterCount: number | null;
  returnContext: NotificationReturnContext;
}): TelegramPayload {
  const modeLines = input.inherited
    ? [
      'Режим: ↩️ Как для всех',
      `Общий режим: ${formatDeliverySetting(input.globalSetting)}`,
    ]
    : [`Режим: ${formatDeliverySetting(input.effectiveSetting)}`];
  const progress = input.effectiveSetting.mode === 'stack'
    ? [`Накоплено: ${Math.max(0, Math.trunc(input.pendingChapterCount ?? 0))} / ${input.effectiveSetting.stackSize ?? 0}`]
    : [];
  const back = listCallback(input.returnContext);
  return {
    text: [
      `📚 <b>${escapeHtml(input.title.title)}</b>`,
      '',
      `Уведомления: ${input.enabled ? '✅ включены' : '🔕 отключены'}`,
      ...modeLines,
      ...progress,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📖 Открыть на RanobeLib', url: input.title.url }],
        [{
          text: input.enabled ? '🔕 Отключить уведомления' : '🔔 Включить уведомления',
          callback_data: `subs:title:toggle:${input.title.ranobelib_id}:${input.returnContext.origin}:${safePage(input.returnContext.page)}`,
        }],
        [{
          text: '⚙️ Режим доставки',
          callback_data: `subs:title:mode:${input.title.ranobelib_id}:${input.returnContext.origin}:${safePage(input.returnContext.page)}`,
        }],
        [{ text: '↩️ Назад', callback_data: back }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildNotificationDisableAllConfirmation(): TelegramPayload {
  return {
    text: '<b>Отключить все уведомления?</b>\n\nБот перестанет присылать новые главы по всем тайтлам.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔕 Да, отключить все', callback_data: 'subs:all:clear:yes' }],
        [{ text: '↩️ Нет, вернуться', callback_data: 'subs:mine:0' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildNotificationGlobalModeScreen(current: NotificationDeliverySetting): TelegramPayload {
  return {
    text: [
      '⚙️ <b>Режим доставки</b>',
      '',
      `Сейчас: ${formatDeliverySetting(current)}`,
      '',
      'Мгновенно — уведомление приходит при выходе новых глав.',
      'Стаками — бот ждёт выбранное число глав. Если порог не набран за 7 дней, накопленное отправится одним уведомлением.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: modeButton('⚡ Мгновенно', current.mode === 'instant'), callback_data: 'subs:mode:g:i' }],
        [
          { text: modeButton('📦 По 5', current.mode === 'stack' && current.stackSize === 5), callback_data: 'subs:mode:g:5' },
          { text: modeButton('📦 По 10', current.mode === 'stack' && current.stackSize === 10), callback_data: 'subs:mode:g:10' },
        ],
        [
          { text: modeButton('📦 По 20', current.mode === 'stack' && current.stackSize === 20), callback_data: 'subs:mode:g:20' },
          { text: '✏️ Свой размер', callback_data: 'subs:mode:g:c' },
        ],
        [{ text: '↩️ К уведомлениям', callback_data: 'subs:center' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildNotificationTitleModeScreen(input: {
  title: NotificationUiTitle;
  enabled: boolean;
  inherited: boolean;
  effectiveSetting: NotificationDeliverySetting;
  globalSetting: NotificationDeliverySetting;
  returnContext: NotificationReturnContext;
}): TelegramPayload {
  const id = input.title.ranobelib_id;
  const suffix = `${input.returnContext.origin}:${safePage(input.returnContext.page)}`;
  return {
    text: [
      `⚙️ <b>${escapeHtml(input.title.title)}</b>`,
      '',
      `Уведомления: ${input.enabled ? '✅ включены' : '🔕 отключены'}`,
      `Режим: ${input.inherited ? `↩️ Как для всех (${formatDeliverySetting(input.globalSetting)})` : formatDeliverySetting(input.effectiveSetting)}`,
      '',
      'Выберите индивидуальный режим или верните настройку «как для всех».',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: modeButton('⚡ Мгновенно', !input.inherited && input.effectiveSetting.mode === 'instant'), callback_data: `subs:mode:t:${id}:i:${suffix}` }],
        [
          { text: modeButton('📦 По 5', !input.inherited && input.effectiveSetting.mode === 'stack' && input.effectiveSetting.stackSize === 5), callback_data: `subs:mode:t:${id}:5:${suffix}` },
          { text: modeButton('📦 По 10', !input.inherited && input.effectiveSetting.mode === 'stack' && input.effectiveSetting.stackSize === 10), callback_data: `subs:mode:t:${id}:10:${suffix}` },
        ],
        [
          { text: modeButton('📦 По 20', !input.inherited && input.effectiveSetting.mode === 'stack' && input.effectiveSetting.stackSize === 20), callback_data: `subs:mode:t:${id}:20:${suffix}` },
          { text: '✏️ Свой размер', callback_data: `subs:mode:t:${id}:c:${suffix}` },
        ],
        [{ text: input.inherited ? '✅ ↩️ Как для всех' : '↩️ Как для всех', callback_data: `subs:mode:t:${id}:inherit:${suffix}` }],
        [{ text: '↩️ К тайтлу', callback_data: `subs:title:${id}:${suffix}` }],
        [mainMenuButton()],
      ],
    },
  };
}

export function parseNotificationUxCallback(value: string): NotificationUxCallback | null {
  if (value === 'subs:center') return { kind: 'dashboard' };
  if (value === 'subs:all:clear:confirm') return { kind: 'clear-confirm' };
  if (value === 'subs:all:clear:yes') return { kind: 'clear-yes' };
  if (value === 'subs:mode:home') return { kind: 'mode-home' };
  if (value === 'subs:search:again') return { kind: 'search-again' };

  let match = /^subs:search:([hma])$/.exec(value);
  if (match?.[1]) {
    const returnScope: NotificationSearchReturnScope = match[1] === 'm'
      ? 'mine'
      : match[1] === 'a'
        ? 'all'
        : 'home';
    return { kind: 'search-start', returnScope };
  }
  match = /^subs:search:page:(\d{1,4})$/.exec(value);
  if (match?.[1]) return { kind: 'search-page', page: safePage(Number(match[1])) };

  match = /^subs:mine:(\d{1,4})$/.exec(value);
  if (match?.[1]) return { kind: 'mine', page: safePage(Number(match[1])) };
  match = /^subs:all:(\d{1,4})$/.exec(value);
  if (match?.[1]) return { kind: 'all-list', page: safePage(Number(match[1])) };

  match = /^subs:title:(\d+):([mas]):(\d{1,4})$/.exec(value);
  if (match?.[1] && match[2] && match[3]) {
    const titleId = positiveId(match[1]);
    if (!titleId) return null;
    return { kind: 'title', titleId, origin: match[2] as NotificationReturnContext['origin'], page: safePage(Number(match[3])) };
  }

  match = /^subs:title:(\d+):(\d{1,4})$/.exec(value);
  if (match?.[1] && match[2]) {
    const titleId = positiveId(match[1]);
    if (!titleId) return null;
    return { kind: 'title', titleId, origin: 'a', page: safePage(Number(match[2])) };
  }

  match = /^subs:title:toggle:(\d+):([mas]):(\d{1,4})$/.exec(value);
  if (match?.[1] && match[2] && match[3]) {
    const titleId = positiveId(match[1]);
    if (!titleId) return null;
    return { kind: 'toggle', titleId, origin: match[2] as NotificationReturnContext['origin'], page: safePage(Number(match[3])) };
  }

  match = /^subs:title:mode:(\d+):([mas]):(\d{1,4})$/.exec(value);
  if (match?.[1] && match[2] && match[3]) {
    const titleId = positiveId(match[1]);
    if (!titleId) return null;
    return { kind: 'title-mode', titleId, origin: match[2] as NotificationReturnContext['origin'], page: safePage(Number(match[3])) };
  }
  return null;
}

export function formatDeliverySetting(setting: NotificationDeliverySetting): string {
  if (setting.mode === 'instant') return '⚡ Мгновенно';
  return `📦 По ${setting.stackSize ?? 5}`;
}

function listCallback(context: NotificationReturnContext): string {
  if (context.origin === 'm') return `subs:mine:${safePage(context.page)}`;
  if (context.origin === 's') return `subs:search:page:${safePage(context.page)}`;
  return `subs:all:${safePage(context.page)}`;
}

function searchReturnCallback(scope: NotificationSearchReturnScope): string {
  if (scope === 'mine') return 'subs:mine:0';
  if (scope === 'all') return 'subs:all:0';
  return 'subs:center';
}

function modeButton(text: string, active: boolean): string {
  return active ? `✅ ${text}` : text;
}

function positiveId(value: string): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safePage(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(9999, value) : 0;
}

function pluralTitles(value: number): string {
  const n = Math.abs(Math.trunc(value));
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'тайтлов';
  if (mod10 === 1) return 'тайтл';
  if (mod10 >= 2 && mod10 <= 4) return 'тайтла';
  return 'тайтлов';
}

function truncate(value: string, max: number): string {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
