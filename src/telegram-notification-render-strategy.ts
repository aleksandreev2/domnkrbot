import type { TelegramScreenRenderStrategy } from './telegram-screen-renderer.js';

export function notificationRenderStrategy(
  callbackData: string,
  currentMessageText = '',
): TelegramScreenRenderStrategy {
  const data = String(callbackData ?? '').trim();
  const text = String(currentMessageText ?? '');

  if (/^subs:title:toggle:/.test(data)) return 'edit';
  if (/^subs:search:page:\d+$/.test(data)) return 'edit';

  if (/^subs:mine:\d+$/.test(data)) {
    return isMyTitlesScreen(text) ? 'edit' : 'replace';
  }
  if (/^subs:all:\d+$/.test(data)) {
    return isAllTitlesScreen(text) ? 'edit' : 'replace';
  }

  return 'replace';
}

function isMyTitlesScreen(text: string): boolean {
  return /(?:^|\n)📚\s*Мои подписки\b/i.test(text);
}

function isAllTitlesScreen(text: string): boolean {
  return /(?:^|\n)📚\s*Все переводы\b/i.test(text);
}
