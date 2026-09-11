import { mainMenuButton, type TelegramButton, type TelegramPayload } from './telegram-bot-ui.js';
import type { TeamCatalogTeam, TeamCatalogTranslation } from './telegram-team-catalog.js';

export function buildPartnerAwareTeamScreen(input: {
  team: TeamCatalogTeam;
  translations: TeamCatalogTranslation[];
  completed: boolean;
  page: number;
}): TelegramPayload {
  const page = safePage(input.page);
  const status = input.completed ? 'completed' : 'active';
  const rows: TelegramButton[][] = input.translations.slice(0, 8).map((translation) => [{
    text: `${input.completed ? '✅' : translation.enabled ? '🔔' : '📚'} ${truncate(translation.title, 42)}`,
    callback_data: `subs:mt:title:${safeId(translation.teamId)}:${safeId(translation.ranobelibId)}:${input.completed ? 'completed' : 'team'}:${page}`,
  }]);
  const pager = pageButtons(page, input.translations.length > 8, (target) => `subs:mt:team:${input.team.id}:${status}:${target}`);
  if (pager) rows.push(pager);
  if (!input.completed && input.team.completedCount > 0) {
    rows.push([{ text: `✅ Завершённые (${nonNegative(input.team.completedCount)})`, callback_data: `subs:mt:team:${input.team.id}:completed:0` }]);
  }
  if (input.completed) rows.push([{ text: '📚 Активные', callback_data: `subs:mt:team:${input.team.id}:active:0` }]);
  if (!input.completed) {
    rows.push([{
      text: input.team.followed ? '🔕 Не следить за всей командой' : '🔔 Следить за всей командой',
      callback_data: `subs:mt:team:toggle:${input.team.id}:${page}`,
    }]);
  }
  rows.push([{
    text: input.team.isPrimary ? '↩️ К каталогу' : '↩️ К партнёрским командам',
    callback_data: input.team.isPrimary ? 'subs:pc:catalog' : 'subs:pc:catalog:partners:0',
  }]);
  rows.push([mainMenuButton()]);

  return {
    text: [
      input.team.isPrimary
        ? `🏠 <b>${escapeHtml(input.team.displayName)}</b>`
        : `🤝 <b>${escapeHtml(input.team.displayName)}</b>`,
      input.team.isPrimary ? 'Основная команда бота.' : 'Команда-партнёр «Дома Некроманта».',
      '',
      `Активных переводов: <b>${nonNegative(input.team.activeCount)}</b>`,
      `Завершённых: <b>${nonNegative(input.team.completedCount)}</b>`,
      `Уведомления по всей команде: ${input.team.followed ? '✅ включены' : '🔕 выключены'}`,
      '',
      input.completed ? '✅ <b>Завершённые переводы</b>' : '📚 <b>Активные переводы</b>',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
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
