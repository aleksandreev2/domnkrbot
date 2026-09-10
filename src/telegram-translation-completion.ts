import { notificationTranslatorLine } from './telegram-notification-team-copy.js';
import type { TelegramMessagePayload } from './telegram-subscriptions.js';

export function formatTranslationCompletionNotification(input: {
  title: string;
  url: string;
  chapterCount: number;
  firstNumber: string | null;
  lastNumber: string | null;
  teamNames?: string[];
}): TelegramMessagePayload {
  const chapterCount = nonNegativeInteger(input.chapterCount);
  const chapterLine = completionChapterLine(chapterCount, input.firstNumber, input.lastNumber);
  return {
    text: [
      '✅ <b>Перевод завершён</b>',
      '',
      `<b>${escapeHtml(input.title)}</b>`,
      '',
      ...(chapterLine
        ? [`🆕 ${chapterLine}`, 'Этими главами перевод тайтла завершён.']
        : ['Мы завершили перевод этого тайтла.']),
      '',
      notificationTranslatorLine(input.teamNames, escapeHtml),
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📖 Читать на RanobeLib', url: input.url }],
        [{ text: '✅ Переведённые новеллы', callback_data: 'subs:completed:0' }],
      ],
    },
  };
}

function completionChapterLine(count: number, first: string | null, last: string | null): string | null {
  if (count <= 0) return null;
  const firstNumber = clean(first);
  const lastNumber = clean(last);
  if (count === 1 && firstNumber) return `Новая глава: ${escapeHtml(firstNumber)}`;
  if (firstNumber && lastNumber && firstNumber !== lastNumber) {
    return `Новые главы: ${escapeHtml(firstNumber)}–${escapeHtml(lastNumber)}`;
  }
  if (firstNumber) return `Новые главы: ${escapeHtml(firstNumber)}`;
  return `Новые главы: ${count}`;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
