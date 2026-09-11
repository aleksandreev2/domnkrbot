import { RanobeLibAuthProvider, type RanobeLibAuthEnv, type RanobeLibAuthHealth } from './ranobelib-auth.js';

export type RanobeLibAuthAlertEnv = RanobeLibAuthEnv & {
  ADMIN_TELEGRAM_IDS?: string;
  TELEGRAM_BOT_TOKEN?: string;
};

type AlertOptions = { fetchImpl?: typeof fetch };

const ALERT_KEY = 'ranobelib_auth_admin_alert_fingerprint';
const REPEATED_REFRESH_FAILURES = 3;

export async function checkRanobeLibAuthAdminAlert(
  env: RanobeLibAuthAlertEnv,
  options: AlertOptions = {},
): Promise<{ alerted: boolean; reason: string | null }> {
  const health = await new RanobeLibAuthProvider(env).health();
  const reason = alertReason(health);
  if (!reason) {
    await clearAlertFingerprint(env).catch(() => undefined);
    return { alerted: false, reason: null };
  }

  const admins = adminIds(env.ADMIN_TELEGRAM_IDS);
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  if (!token || admins.length === 0) return { alerted: false, reason };

  const fingerprint = `${reason}|${health.lastError ?? ''}`;
  const previous = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?')
    .bind(ALERT_KEY)
    .first<{ value?: string }>();
  if (previous?.value === fingerprint) return { alerted: false, reason };

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const text = buildAlertText(health, reason);
  let sent = 0;
  for (const adminId of admins) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: adminId, text, parse_mode: 'HTML' }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean } | null;
      if (response.ok && body?.ok) sent += 1;
    } catch {
      // A later cron retries because the fingerprint is written only after at least one delivery.
    }
  }
  if (sent === 0) return { alerted: false, reason };

  await env.DB.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).bind(ALERT_KEY, fingerprint).run();
  return { alerted: true, reason };
}

function alertReason(health: RanobeLibAuthHealth): string | null {
  if (health.state === 'invalid') return 'invalid';
  if (health.state === 'unavailable') return 'unavailable';
  if (health.refreshFailures >= REPEATED_REFRESH_FAILURES) return 'refresh_failures';
  return null;
}

function buildAlertText(health: RanobeLibAuthHealth, reason: string): string {
  const title = reason === 'invalid'
    ? 'авторизация недействительна'
    : reason === 'unavailable'
      ? 'авторизация недоступна'
      : `повторные ошибки refresh: ${health.refreshFailures}`;
  const lines = [
    '⚠️ <b>RanobeLib auth</b>',
    title,
    `state: <b>${escapeHtml(health.state)}</b> · encryption: <b>${escapeHtml(health.encryptionState)}</b>`,
    `access expires: ${format(health.accessExpiresAt)}`,
    `last refresh: ${format(health.lastRefreshedAt)}`,
    `refresh failures: <b>${health.refreshFailures}</b>`,
  ];
  if (health.lastRefreshFailureAt) lines.push(`last refresh failure: ${format(health.lastRefreshFailureAt)}`);
  if (health.lastError) lines.push(`error: <code>${escapeHtml(health.lastError.slice(0, 180))}</code>`);
  return lines.join('\n');
}

async function clearAlertFingerprint(env: RanobeLibAuthAlertEnv): Promise<void> {
  await env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(ALERT_KEY).run();
}

function adminIds(value: string | undefined): number[] {
  const result = new Set<number>();
  for (const item of String(value ?? '').split(/[\s,;]+/)) {
    const id = Number(item);
    if (Number.isSafeInteger(id) && id > 0) result.add(id);
  }
  return [...result];
}

function format(value: string | null): string {
  return value ? `<code>${escapeHtml(value)}</code>` : 'нет данных';
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
