export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TelegramMessagePayload = {
  text: string;
  parse_mode?: 'HTML';
  reply_markup: { inline_keyboard: TelegramInlineKeyboardButton[][] };
};

export type SubscriptionTitle = {
  ranobelib_id: number;
  book_ref: string;
  title: string;
};

export type SubscriptionCallback =
  | { kind: 'title'; titleId: number; page: number }
  | { kind: 'list'; page: number }
  | { kind: 'mine'; page: number }
  | { kind: 'all'; mode: 'on' | 'clear' }
  | { kind: 'noop' };

export function buildSubscriptionMenu(
  titles: SubscriptionTitle[],
  options: { page?: number; pageSize?: number; subscribedIds?: Set<number>; allTitles?: boolean } = {},
): TelegramMessagePayload {
  const pageSize = clampInt(options.pageSize ?? 8, 1, 20);
  const totalPages = Math.max(1, Math.ceil(titles.length / pageSize));
  const page = clampInt(options.page ?? 0, 0, totalPages - 1);
  const subscribed = options.subscribedIds ?? new Set<number>();
  const start = page * pageSize;
  const pageTitles = titles.slice(start, start + pageSize);
  const rows: TelegramInlineKeyboardButton[][] = pageTitles.map((title) => [{
    text: `${options.allTitles || subscribed.has(title.ranobelib_id) ? '✅' : '📖'} ${truncate(title.title, 42)}`,
    callback_data: `subs:title:${title.ranobelib_id}:${page}`,
  }]);

  const nav: TelegramInlineKeyboardButton[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `subs:list:${page - 1}` });
  nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'subs:noop' });
  if (page + 1 < totalPages) nav.push({ text: '▶️', callback_data: `subs:list:${page + 1}` });
  rows.push(nav);
  rows.push([{ text: options.allTitles ? '✅ Все переводы включены' : '☠️ Подписаться на все', callback_data: 'subs:all:on' }]);
  rows.push([
    { text: '✅ Мои подписки', callback_data: 'subs:mine:0' },
    { text: '🔕 Отключить все', callback_data: 'subs:all:clear' },
  ]);

  return {
    text: titles.length
      ? '🔔 <b>Уведомления о новых главах</b>\n\nВыберите тайтл. Список синхронизируется с RanobeLib автоматически.'
      : '🔔 <b>Уведомления о новых главах</b>\n\nСписок тайтлов пока пуст. Попробуйте позже.',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function parseSubscriptionCallback(value: string): SubscriptionCallback | null {
  if (value === 'subs:noop') return { kind: 'noop' };
  let match = /^subs:title:(\d+):(\d+)$/.exec(value);
  if (match) {
    const titleId = Number(match[1]);
    const page = Number(match[2]);
    if (Number.isSafeInteger(titleId) && titleId > 0 && Number.isSafeInteger(page) && page >= 0) {
      return { kind: 'title', titleId, page };
    }
    return null;
  }
  match = /^subs:(list|mine):(\d+)$/.exec(value);
  if (match) {
    const page = Number(match[2]);
    if (!Number.isSafeInteger(page) || page < 0) return null;
    return match[1] === 'list' ? { kind: 'list', page } : { kind: 'mine', page };
  }
  match = /^subs:all:(on|clear)$/.exec(value);
  if (match?.[1] === 'on' || match?.[1] === 'clear') return { kind: 'all', mode: match[1] };
  return null;
}

export function formatReleaseNotification(release: {
  title: string;
  url: string;
  chapterCount: number;
  firstNumber: string | null;
  lastNumber: string | null;
  summary: string;
}): TelegramMessagePayload {
  const range = chapterRange(release.chapterCount, release.firstNumber, release.lastNumber);
  const text = [
    '📖 <b>Новые главы!</b>',
    '',
    `<b>${escapeHtml(release.title)}</b>`,
    range,
    '',
    'Перевод команды «Дом Некроманта».',
  ].filter(Boolean).join('\n');

  return {
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '📖 Читать на RanobeLib', url: release.url }]],
    },
  };
}

function chapterRange(count: number, first: string | null, last: string | null): string {
  if (first && last && first !== last) return `Главы ${escapeHtml(first)}–${escapeHtml(last)}`;
  if (first) return `Глава ${escapeHtml(first)}`;
  if (count > 1) return `${count} новых глав`;
  return 'Новая глава';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}

function truncate(value: string, max: number): string {
  const text = String(value || '').trim() || 'Без названия';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function clampInt(value: number, min: number, max: number): number {
  const int = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, int));
}
