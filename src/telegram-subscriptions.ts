import { notificationTranslatorLine } from './telegram-notification-team-copy.js';
import { formatReleaseNotification as formatLegacyReleaseNotification } from './telegram-subscriptions-legacy.js';

export * from './telegram-subscriptions-legacy.js';

export type TeamAwareReleaseNotificationInput = Parameters<typeof formatLegacyReleaseNotification>[0] & {
  teamNames?: readonly string[];
};

export function formatReleaseNotification(release: TeamAwareReleaseNotificationInput) {
  const payload = formatLegacyReleaseNotification(release);
  const translator = notificationTranslatorLine(release.teamNames, escapeHtml);
  return {
    ...payload,
    text: payload.text.replace('Перевод команды «Дом Некроманта».', translator),
  };
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
