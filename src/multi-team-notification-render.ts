import { formatReleaseNotification, type TelegramMessagePayload } from './telegram-subscriptions.js';
import { formatTranslationCompletionNotification } from './telegram-translation-completion.js';

const LEGACY_TRANSLATOR_LINE = 'Перевод команды «Дом Некроманта».';

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
  const payload = formatReleaseNotification(input);
  return replaceTranslatorLine(payload, translatorLine(input.teamNames));
}

export function formatTeamAwareCompletionNotification(input: {
  title: string;
  url: string;
  chapterCount: number;
  firstNumber: string | null;
  lastNumber: string | null;
  teamNames: readonly string[];
}): TelegramMessagePayload {
  const payload = formatTranslationCompletionNotification(input);
  return replaceTranslatorLine(payload, translatorLine(input.teamNames));
}

export function translatorLine(teamNames: readonly string[]): string {
  const names = uniqueTeamNames(teamNames);
  if (names.length === 0) return LEGACY_TRANSLATOR_LINE;
  if (names.length === 1) return `Перевод команды «${escapeHtml(names[0]!)}».`;
  return `Перевод команд: ${names.map((name) => `«${escapeHtml(name)}»`).join(', ')}.`;
}

export function uniqueTeamNames(teamNames: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of teamNames) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase('ru-RU');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function replaceTranslatorLine(payload: TelegramMessagePayload, line: string): TelegramMessagePayload {
  return {
    ...payload,
    text: payload.text.includes(LEGACY_TRANSLATOR_LINE)
      ? payload.text.replace(LEGACY_TRANSLATOR_LINE, line)
      : `${payload.text}\n${line}`,
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
