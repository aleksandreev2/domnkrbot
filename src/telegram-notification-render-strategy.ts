import type { TelegramRenderStrategy } from './telegram-screen-renderer.js';

export function notificationRenderStrategy(
  callbackData: string,
  currentMessageText = '',
): TelegramRenderStrategy {
  const data = String(callbackData ?? '').trim();
  const text = String(currentMessageText ?? '');

  // Telegram normally includes the current text for these notification screens.
  // If it does not, preserve the legacy in-place behavior instead of guessing
  // that a semantic screen transition occurred and creating a replacement.
  if (!text.trim()) return 'edit';

  if (/^subs:title:toggle:/.test(data)) return 'edit';
  if (/^subs:search:page:\d+$/.test(data)) return 'edit';

  if (/^subs:mine:\d+$/.test(data)) {
    return isMyTitlesScreen(text) ? 'edit' : 'replace';
  }
  if (/^subs:all:\d+$/.test(data)) {
    return isAllTitlesScreen(text) ? 'edit' : 'replace';
  }
  if (/^subs:completed:\d+$/.test(data)) {
    return isCompletedTitlesScreen(text) ? 'edit' : 'replace';
  }

  return 'replace';
}

function isMyTitlesScreen(text: string): boolean {
  return /(?:^|\n)📚\s*Мои подписки(?=\s|$)/i.test(text);
}

function isAllTitlesScreen(text: string): boolean {
  return /(?:^|\n)📚\s*Все переводы(?=\s|$)/i.test(text);
}

function isCompletedTitlesScreen(text: string): boolean {
  return /(?:^|\n)✅\s*Переведённые новеллы(?=\s|$)/i.test(text);
}
