import { mainMenuButton, type TelegramButton, type TelegramPayload } from './telegram-bot-ui.js';
import type { TeamCatalogTeam, TeamCatalogTranslation } from './telegram-team-catalog.js';

export type PartnerCollaborationCallback =
  | { kind: 'dashboard' }
  | { kind: 'subscriptions' }
  | { kind: 'catalog' }
  | { kind: 'partners'; page: number }
  | { kind: 'primary'; page: number }
  | { kind: 'my-teams'; page: number }
  | { kind: 'my-titles'; page: number }
  | { kind: 'catalog-translations'; completed: boolean; page: number };

export function buildPartnerNotificationDashboard(state: {
  followedTeams: number;
  manualTitles: number;
  globalModeLabel: string;
}): TelegramPayload {
  return {
    text: [
      '🔔 <b>Уведомления</b>',
      '',
      'Сейчас вы отслеживаете:',
      `👥 Команд целиком: <b>${nonNegative(state.followedTeams)}</b>`,
      `📚 Отдельных переводов: <b>${nonNegative(state.manualTitles)}</b>`,
      '',
      `Режим доставки: ${escapeHtml(state.globalModeLabel)}`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⭐ Мои подписки', callback_data: 'subs:pc:mine' }],
        [{ text: '🧭 Каталог переводов', callback_data: 'subs:pc:catalog' }],
        [{ text: '🔎 Поиск', callback_data: 'subs:mt:search:start' }],
        [{ text: '⚙️ Настройки уведомлений', callback_data: 'subs:mode:home' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildPartnerSubscriptionsHub(state: { followedTeams: number; manualTitles: number }): TelegramPayload {
  return {
    text: [
      '⭐ <b>Мои подписки</b>',
      '',
      'Подписка на команду включает её текущие и будущие переводы. Отдельные переводы можно настраивать независимо.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `👥 Мои команды · ${nonNegative(state.followedTeams)}`, callback_data: 'subs:pc:mine:teams:0' }],
        [{ text: `📚 Мои переводы · ${nonNegative(state.manualTitles)}`, callback_data: 'subs:pc:mine:titles:0' }],
        [{ text: '↩️ К уведомлениям', callback_data: 'subs:mt:home' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildPartnerCatalogHub(): TelegramPayload {
  return {
    text: [
      '🧭 <b>Каталог переводов</b>',
      '',
      'Переводы «Дома Некроманта» и наших партнёров — в одном каталоге.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏠 Дом Некроманта', callback_data: 'subs:pc:catalog:primary:0' }],
        [{ text: '🤝 Партнёрские команды', callback_data: 'subs:pc:catalog:partners:0' }],
        [{ text: '📚 Все активные переводы', callback_data: 'subs:pc:catalog:active:0' }],
        [{ text: '✅ Завершённые переводы', callback_data: 'subs:pc:catalog:completed:0' }],
        [{ text: '↩️ К уведомлениям', callback_data: 'subs:mt:home' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildPartnerTeamList(input: {
  page: number;
  teams: TeamCatalogTeam[];
  origin: 'partners' | 'mine';
}): TelegramPayload {
  const page = safePage(input.page);
  const rows: TelegramButton[][] = input.teams.slice(0, 8).map((team) => [{
    text: `${team.followed ? '🔔 ' : '🤝 '}${truncate(team.displayName, 31)} · ${nonNegative(team.activeCount)}`,
    callback_data: `subs:mt:team:${safeId(team.id)}:active:0`,
  }]);
  const pager = pageButtons(page, input.teams.length > 8, (target) => input.origin === 'partners'
    ? `subs:pc:catalog:partners:${target}`
    : `subs:pc:mine:teams:${target}`);
  if (pager) rows.push(pager);
  rows.push([{
    text: input.origin === 'partners' ? '↩️ К каталогу' : '↩️ К моим подпискам',
    callback_data: input.origin === 'partners' ? 'subs:pc:catalog' : 'subs:pc:mine',
  }]);
  rows.push([mainMenuButton()]);
  return {
    text: input.origin === 'partners'
      ? `🤝 <b>Партнёрские команды</b>\n\n${input.teams.length ? 'Выберите команду, чтобы посмотреть её переводы или подписаться целиком.' : 'Опубликованных партнёрских команд пока нет.'}`
      : `👥 <b>Мои команды</b>\n\n${input.teams.length ? 'Команды, на все текущие и будущие переводы которых вы подписаны.' : 'Вы пока не подписаны ни на одну команду целиком.'}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildPartnerTranslationList(input: {
  translations: TeamCatalogTranslation[];
  page: number;
  completed: boolean;
  scope: 'active' | 'completed' | 'primary' | 'mine';
}): TelegramPayload {
  const page = safePage(input.page);
  const rows: TelegramButton[][] = input.translations.slice(0, 8).map((translation) => [{
    text: `${input.completed ? '✅' : translation.enabled ? '🔔' : '📚'} ${truncate(translation.title, 29)} · ${truncate(translation.teamName, 14)}`,
    callback_data: `subs:mt:title:${safeId(translation.teamId)}:${safeId(translation.ranobelibId)}:${input.completed ? 'completed' : input.scope === 'mine' ? 'mine' : 'team'}:0`,
  }]);
  const callback = (target: number) => {
    if (input.scope === 'primary') return `subs:pc:catalog:primary:${target}`;
    if (input.scope === 'mine') return `subs:pc:mine:titles:${target}`;
    return `subs:pc:catalog:${input.completed ? 'completed' : 'active'}:${target}`;
  };
  const pager = pageButtons(page, input.translations.length > 8, callback);
  if (pager) rows.push(pager);
  rows.push([{
    text: input.scope === 'mine' ? '↩️ К моим подпискам' : '↩️ К каталогу',
    callback_data: input.scope === 'mine' ? 'subs:pc:mine' : 'subs:pc:catalog',
  }]);
  rows.push([mainMenuButton()]);
  const heading = input.scope === 'primary'
    ? '🏠 Дом Некроманта'
    : input.scope === 'mine'
      ? '📚 Мои переводы'
      : input.completed
        ? '✅ Завершённые переводы'
        : '📚 Все активные переводы';
  return {
    text: `<b>${heading}</b>\n\n${input.translations.length ? 'Выберите перевод:' : 'Здесь пока ничего нет.'}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function parsePartnerCollaborationCallback(data: string): PartnerCollaborationCallback | null {
  if (data === 'subs:mt:home') return { kind: 'dashboard' };
  if (data === 'subs:pc:mine') return { kind: 'subscriptions' };
  if (data === 'subs:pc:catalog') return { kind: 'catalog' };
  let match = /^subs:pc:catalog:partners:(\d+)$/.exec(data);
  if (match) return { kind: 'partners', page: safePage(match[1]) };
  match = /^subs:pc:catalog:primary:(\d+)$/.exec(data);
  if (match) return { kind: 'primary', page: safePage(match[1]) };
  match = /^subs:pc:mine:teams:(\d+)$/.exec(data);
  if (match) return { kind: 'my-teams', page: safePage(match[1]) };
  match = /^subs:pc:mine:titles:(\d+)$/.exec(data);
  if (match) return { kind: 'my-titles', page: safePage(match[1]) };
  match = /^subs:pc:catalog:(active|completed):(\d+)$/.exec(data);
  if (match) return { kind: 'catalog-translations', completed: match[1] === 'completed', page: safePage(match[2]) };
  return null;
}

function pageButtons(page: number, hasNext: boolean, callback: (target: number) => string): TelegramButton[] | null {
  const buttons: TelegramButton[] = [];
  if (page > 0) buttons.push({ text: '◀️', callback_data: callback(page - 1) });
  if (hasNext) buttons.push({ text: '▶️', callback_data: callback(page + 1) });
  return buttons.length ? buttons : null;
}

function safeId(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safePage(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(9999, Math.trunc(number))) : 0;
}

function nonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function truncate(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
