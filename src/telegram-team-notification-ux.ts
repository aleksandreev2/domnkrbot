import { mainMenuButton, type TelegramButton, type TelegramPayload } from './telegram-bot-ui.js';
import type { TeamCatalogTeam, TeamCatalogTranslation, WorkSearchGroup } from './telegram-team-catalog.js';

export type TeamNotificationOrigin = 'team' | 'completed' | 'mine' | 'search' | 'work' | 'alt';

export type TeamNotificationCallback =
  | { kind: 'dashboard' }
  | { kind: 'teams'; scope: 'mine' | 'all'; page: number }
  | { kind: 'titles'; page: number }
  | { kind: 'team-translations'; teamId: number; completed: boolean; page: number }
  | { kind: 'team-toggle'; teamId: number; page: number }
  | { kind: 'work'; titleId: number; page: number }
  | { kind: 'alternates'; titleId: number; page: number }
  | { kind: 'title'; teamId: number; titleId: number; origin: TeamNotificationOrigin; page: number }
  | { kind: 'title-toggle'; teamId: number; titleId: number; origin: TeamNotificationOrigin; page: number }
  | { kind: 'title-mode'; teamId: number; titleId: number; origin: TeamNotificationOrigin; page: number }
  | { kind: 'search-start' }
  | { kind: 'search-page'; page: number }
  | { kind: 'search-again' };

export function buildTeamNotificationDashboard(state: {
  followedTeams: number;
  manualTitles: number;
  globalModeLabel: string;
}): TelegramPayload {
  return {
    text: [
      '🔔 <b>Уведомления</b>',
      '',
      `Команды целиком: ${nonNegative(state.followedTeams)}`,
      `Отдельные новеллы: ${nonNegative(state.manualTitles)}`,
      `Режим по умолчанию: ${escapeHtml(state.globalModeLabel)}`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Мои команды', callback_data: 'subs:mt:teams:mine:0' }],
        [{ text: '📚 Мои новеллы', callback_data: 'subs:mt:titles:0' }],
        [{ text: '🔎 Найти новеллу', callback_data: 'subs:mt:search:start' }],
        [{ text: '🧭 Все команды', callback_data: 'subs:mt:teams:all:0' }],
        [{ text: '⚙️ Режим доставки', callback_data: 'subs:mode:home' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildTeamListScreen(input: {
  kind: 'mine' | 'all';
  page: number;
  teams: TeamCatalogTeam[];
}): TelegramPayload {
  const page = safePage(input.page);
  const rows: TelegramButton[][] = input.teams.slice(0, 8).map((team) => [{
    text: `${team.isPrimary ? '⭐ ' : ''}${truncate(team.displayName, 31)} · ${nonNegative(team.activeCount)}`,
    callback_data: `subs:mt:team:${team.id}:active:${page}`,
  }]);
  const pager = pageButtons(page, input.teams.length > 8, (target) => `subs:mt:teams:${input.kind}:${target}`);
  if (pager) rows.push(pager);
  rows.push([{ text: '↩️ К уведомлениям', callback_data: 'subs:mt:home' }], [mainMenuButton()]);
  const heading = input.kind === 'mine' ? 'Мои команды' : 'Все команды';
  const hint = input.kind === 'mine'
    ? 'Здесь команды, на все текущие и будущие переводы которых вы подписаны.'
    : 'Откройте команду, чтобы подписаться на неё целиком или выбрать отдельную новеллу.';
  return {
    text: `👥 <b>${heading}</b>\n\n${input.teams.length ? hint : 'Здесь пока ничего нет.'}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildTeamTranslationsScreen(input: {
  team: TeamCatalogTeam;
  translations: TeamCatalogTranslation[];
  completed: boolean;
  page: number;
}): TelegramPayload {
  const page = safePage(input.page);
  const status = input.completed ? 'completed' : 'active';
  const origin: TeamNotificationOrigin = input.completed ? 'completed' : 'team';
  const rows: TelegramButton[][] = input.translations.slice(0, 8).map((translation) => [{
    text: `${input.completed ? '✅' : translation.enabled ? '🔔' : '📚'} ${truncate(translation.title, 42)}`,
    callback_data: titleCallback(translation, origin, page),
  }]);
  const pager = pageButtons(page, input.translations.length > 8, (target) => `subs:mt:team:${input.team.id}:${status}:${target}`);
  if (pager) rows.push(pager);
  if (!input.completed && input.team.completedCount > 0) {
    rows.push([{ text: `✅ Завершённые (${nonNegative(input.team.completedCount)})`, callback_data: `subs:mt:team:${input.team.id}:completed:0` }]);
  }
  if (input.completed) {
    rows.push([{ text: '📚 Активные', callback_data: `subs:mt:team:${input.team.id}:active:0` }]);
  }
  if (!input.completed) {
    rows.push([{
      text: input.team.followed ? '🔕 Не следить за всей командой' : '🔔 Следить за всей командой',
      callback_data: `subs:mt:team:toggle:${input.team.id}:${page}`,
    }]);
  }
  rows.push([{ text: '↩️ Ко всем командам', callback_data: 'subs:mt:teams:all:0' }], [mainMenuButton()]);
  return {
    text: [
      `${input.team.isPrimary ? '⭐ ' : ''}<b>${escapeHtml(input.team.displayName)}</b>`,
      '',
      input.completed ? '✅ Завершённые переводы' : '📚 Активные переводы',
      input.team.followed && !input.completed ? 'Уведомления по всей команде: ✅ включены' : '',
    ].filter(Boolean).join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildManualTeamTitlesScreen(input: { translations: TeamCatalogTranslation[]; page: number }): TelegramPayload {
  const page = safePage(input.page);
  const rows: TelegramButton[][] = input.translations.slice(0, 8).map((translation) => [{
    text: `${translation.semanticStatus === 'completed' ? '✅' : '📚'} ${truncate(translation.title, 33)} · ${truncate(translation.teamName, 16)}`,
    callback_data: titleCallback(translation, 'mine', page),
  }]);
  const pager = pageButtons(page, input.translations.length > 8, (target) => `subs:mt:titles:${target}`);
  if (pager) rows.push(pager);
  rows.push([{ text: '🔎 Найти новеллу', callback_data: 'subs:mt:search:start' }]);
  rows.push([{ text: '↩️ К уведомлениям', callback_data: 'subs:mt:home' }], [mainMenuButton()]);
  return {
    text: input.translations.length
      ? '📚 <b>Мои новеллы</b>\n\nТолько новеллы, выбранные вручную. Переводы из команд, на которые вы подписаны целиком, здесь не дублируются.'
      : '📚 <b>Мои новеллы</b>\n\nОтдельно выбранных новелл пока нет.',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildTeamSearchPrompt(): TelegramPayload {
  return {
    text: '🔎 <b>Поиск новеллы</b>\n\nВведите название или его часть. Если одну новеллу переводят несколько команд, бот сначала покажет саму новеллу, а затем предложит выбрать перевод.',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'subs:mt:home' }], [mainMenuButton()]] },
  };
}

export function buildWorkSearchResults(input: {
  query: string;
  groups: WorkSearchGroup[];
  page: number;
}): TelegramPayload {
  const page = safePage(input.page);
  const rows: TelegramButton[][] = input.groups.slice(0, 8).map((group) => {
    const active = group.translations.filter((item) => item.semanticStatus !== 'completed').length;
    const count = group.translations.length;
    const suffix = count > 1 ? ` · ${count} перевода` : group.translations[0]?.teamName ? ` · ${truncate(group.translations[0].teamName, 16)}` : '';
    const callback = count === 1 && group.translations[0]
      ? titleCallback(group.translations[0], 'search', page)
      : `subs:mt:work:${safeId(group.ranobelibId)}:${page}`;
    return [{ text: `${active === 0 ? '✅' : '📚'} ${truncate(group.title, 34)}${suffix}`, callback_data: callback }];
  });
  const pager = pageButtons(page, input.groups.length >= 8, (target) => `subs:mt:search:page:${target}`);
  if (pager) rows.push(pager);
  rows.push([{ text: '🔎 Искать снова', callback_data: 'subs:mt:search:again' }]);
  rows.push([{ text: '↩️ К уведомлениям', callback_data: 'subs:mt:home' }], [mainMenuButton()]);
  return {
    text: input.groups.length
      ? `🔎 <b>Результаты поиска</b>\n\nЗапрос: <b>${escapeHtml(input.query)}</b>`
      : `🔎 <b>Ничего не найдено</b>\n\nПо запросу <b>${escapeHtml(input.query)}</b> ничего не найдено.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildWorkTranslationPicker(input: { group: WorkSearchGroup; page: number; origin?: 'work' | 'alt' }): TelegramPayload {
  const page = safePage(input.page);
  const origin = input.origin ?? 'work';
  const rows: TelegramButton[][] = input.group.translations.map((translation) => [{
    text: `${translation.teamIsPrimary ? '⭐ ' : ''}${translation.semanticStatus === 'completed' ? '✅ ' : ''}${truncate(translation.teamName, 42)}`,
    callback_data: titleCallback(translation, origin, page),
  }]);
  rows.push([origin === 'alt'
    ? { text: '↩️ К уведомлениям', callback_data: 'subs:mt:home' }
    : { text: '↩️ К результатам', callback_data: `subs:mt:search:page:${page}` }]);
  rows.push([mainMenuButton()]);
  return {
    text: `📚 <b>${escapeHtml(input.group.title)}</b>\n\nЭту новеллу переводят несколько команд. Выберите нужный перевод:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildTeamTitleCard(input: {
  translation: TeamCatalogTranslation;
  deliveryLabel: string;
  inheritedDelivery: boolean;
  origin: TeamNotificationOrigin;
  page: number;
  hasAlternatives?: boolean;
}): TelegramPayload {
  const item = input.translation;
  const id = safeId(item.ranobelibId);
  const page = safePage(input.page);
  const completed = item.semanticStatus === 'completed';
  const lines = [
    `${completed ? '✅' : '📚'} <b>${escapeHtml(item.title)}</b>`,
    '',
    `Переводчик: ${item.teamIsPrimary ? '⭐ ' : ''}<b>${escapeHtml(item.teamName)}</b>`,
    `Статус: ${completed ? '✅ перевод завершён' : '📚 перевод активен'}`,
    `Уведомления: ${item.enabled ? '✅ включены' : '🔕 отключены'}`,
  ];
  if (item.enabledReason === 'team') lines.push('Источник подписки: вся команда.');
  if (item.enabledReason === 'excluded') lines.push('Для этой новеллы задано исключение из подписки на всю команду.');
  if (!completed) lines.push(`Режим доставки: ${escapeHtml(input.deliveryLabel)}${input.inheritedDelivery ? ' · общий' : ''}`);

  const buttons: TelegramButton[][] = [[{ text: '📖 Открыть на RanobeLib', url: item.url }]];
  if (input.hasAlternatives && id > 0) {
    buttons.push([{ text: '👥 Другие переводы этой новеллы', callback_data: `subs:mt:alts:${id}:${page}` }]);
  }
  if (!completed || item.enabled) {
    buttons.push([{
      text: item.enabled ? '🔕 Отключить уведомления' : '🔔 Включить уведомления',
      callback_data: `subs:mt:title:toggle:${item.teamId}:${id}:${input.origin}:${page}`,
    }]);
  }
  if (!completed) {
    buttons.push([{
      text: '⚙️ Режим доставки',
      callback_data: `subs:mt:title:mode:${item.teamId}:${id}:${input.origin}:${page}`,
    }]);
  }
  buttons.push([{ text: '↩️ Назад', callback_data: backCallback(item.teamId, id, input.origin, page) }], [mainMenuButton()]);
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } };
}

export function buildTeamTitleModeScreen(input: {
  translation: TeamCatalogTranslation;
  globalLabel: string;
  effectiveLabel: string;
  inherited: boolean;
  origin: TeamNotificationOrigin;
  page: number;
}): TelegramPayload {
  const id = safeId(input.translation.ranobelibId);
  const page = safePage(input.page);
  const base = `subs:mt:title:mode:set:${input.translation.teamId}:${id}`;
  return {
    text: [
      `⚙️ <b>${escapeHtml(input.translation.title)}</b>`,
      `Команда: <b>${escapeHtml(input.translation.teamName)}</b>`,
      '',
      `Сейчас: ${escapeHtml(input.effectiveLabel)}`,
      `Общий режим: ${escapeHtml(input.globalLabel)}`,
      input.inherited ? 'Используется общий режим.' : 'Для этой новеллы задан индивидуальный режим.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚡ Мгновенно', callback_data: `${base}:i:${input.origin}:${page}` }],
        [{ text: '📦 По 5 глав', callback_data: `${base}:5:${input.origin}:${page}` }],
        [{ text: '📦 По 10 глав', callback_data: `${base}:10:${input.origin}:${page}` }],
        [{ text: '📦 По 20 глав', callback_data: `${base}:20:${input.origin}:${page}` }],
        [{ text: '↩️ Как для всех', callback_data: `${base}:x:${input.origin}:${page}` }],
        [{ text: '↩️ Назад', callback_data: `subs:mt:title:${input.translation.teamId}:${id}:${input.origin}:${page}` }],
        [mainMenuButton()],
      ],
    },
  };
}

export function parseTeamNotificationCallback(data: string): TeamNotificationCallback | null {
  if (data === 'subs:mt:home') return { kind: 'dashboard' };
  if (data === 'subs:mt:search:start' || data === 'subs:mt:search:again') return { kind: data.endsWith('again') ? 'search-again' : 'search-start' };
  let match = /^subs:mt:teams:(mine|all):(\d+)$/.exec(data);
  if (match) return { kind: 'teams', scope: match[1] as 'mine' | 'all', page: safePage(match[2]) };
  match = /^subs:mt:titles:(\d+)$/.exec(data);
  if (match) return { kind: 'titles', page: safePage(match[1]) };
  match = /^subs:mt:team:(\d+):(active|completed):(\d+)$/.exec(data);
  if (match) return { kind: 'team-translations', teamId: safeId(match[1]), completed: match[2] === 'completed', page: safePage(match[3]) };
  match = /^subs:mt:team:toggle:(\d+):(\d+)$/.exec(data);
  if (match) return { kind: 'team-toggle', teamId: safeId(match[1]), page: safePage(match[2]) };
  match = /^subs:mt:work:(\d+):(\d+)$/.exec(data);
  if (match) return { kind: 'work', titleId: safeId(match[1]), page: safePage(match[2]) };
  match = /^subs:mt:alts:(\d+):(\d+)$/.exec(data);
  if (match) return { kind: 'alternates', titleId: safeId(match[1]), page: safePage(match[2]) };
  match = /^subs:mt:title:(\d+):(\d+):(team|completed|mine|search|work|alt):(\d+)$/.exec(data);
  if (match) return { kind: 'title', teamId: safeId(match[1]), titleId: safeId(match[2]), origin: match[3] as TeamNotificationOrigin, page: safePage(match[4]) };
  match = /^subs:mt:title:toggle:(\d+):(\d+):(team|completed|mine|search|work|alt):(\d+)$/.exec(data);
  if (match) return { kind: 'title-toggle', teamId: safeId(match[1]), titleId: safeId(match[2]), origin: match[3] as TeamNotificationOrigin, page: safePage(match[4]) };
  match = /^subs:mt:title:mode:(\d+):(\d+):(team|completed|mine|search|work|alt):(\d+)$/.exec(data);
  if (match) return { kind: 'title-mode', teamId: safeId(match[1]), titleId: safeId(match[2]), origin: match[3] as TeamNotificationOrigin, page: safePage(match[4]) };
  match = /^subs:mt:search:page:(\d+)$/.exec(data);
  if (match) return { kind: 'search-page', page: safePage(match[1]) };
  return null;
}

function titleCallback(translation: TeamCatalogTranslation, origin: TeamNotificationOrigin, page: number): string {
  return `subs:mt:title:${translation.teamId}:${safeId(translation.ranobelibId)}:${origin}:${safePage(page)}`;
}

function backCallback(teamId: number, titleId: number, origin: TeamNotificationOrigin, page: number): string {
  if (origin === 'mine') return `subs:mt:titles:${page}`;
  if (origin === 'search' || origin === 'work') return `subs:mt:search:page:${page}`;
  if (origin === 'alt') return `subs:mt:alts:${titleId}:${page}`;
  if (origin === 'completed') return `subs:mt:team:${teamId}:completed:${page}`;
  return `subs:mt:team:${teamId}:active:${page}`;
}

function pageButtons(page: number, hasNext: boolean, callback: (target: number) => string): TelegramButton[] | null {
  const buttons: TelegramButton[] = [];
  if (page > 0) buttons.push({ text: '◀️', callback_data: callback(page - 1) });
  if (page > 0 || hasNext) buttons.push({ text: `${page + 1}`, callback_data: 'subs:noop' });
  if (hasNext) buttons.push({ text: '▶️', callback_data: callback(page + 1) });
  return buttons.length ? buttons : null;
}

function safePage(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(9999, Math.max(0, Math.trunc(number))) : 0;
}

function safeId(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
