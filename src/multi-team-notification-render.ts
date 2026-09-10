import { notificationTranslatorLine, normalizeNotificationTeamNames } from './telegram-notification-team-copy.js';
import { formatReleaseNotification, type TelegramMessagePayload } from './telegram-subscriptions.js';
import { formatTranslationCompletionNotification } from './telegram-translation-completion.js';

export function formatTeamAwareReleaseNotification(input: {
  titleId?: number;
  title: string;
  url: string;
  chapterCount: number;
  firstNumber: string | null;
  lastNumber: string | null;
  summary: string;
  subscribed?: boolean;
  teamNames: readonly string[];
}): TelegramMessagePayload {
  return formatReleaseNotification(input);
}

export function formatTeamAwareCompletionNotification(input: {
  title: string;
  url: string;
  chapterCount: number;
  firstNumber: string | null;
  lastNumber: string | null;
  teamNames: readonly string[];
}): TelegramMessagePayload {
  return formatTranslationCompletionNotification(input);
}

export function translatorLine(teamNames: readonly string[]): string {
  return notificationTranslatorLine(teamNames, escapeHtml);
}

export function uniqueTeamNames(teamNames: readonly string[]): string[] {
  return normalizeNotificationTeamNames(teamNames);
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
