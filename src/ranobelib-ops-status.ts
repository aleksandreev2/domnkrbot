import { RanobeLibAuthProvider, type RanobeLibAuthEnv } from './ranobelib-auth.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';

type TitleRow = {
  book_ref: string;
  ranobelib_id: number | string | null;
  title: string | null;
  chapter_count: number | string;
  latest_volume: string | null;
  latest_number: string | null;
  latest_name: string | null;
  last_synced_at: string | null;
  next_check_at: string | null;
  sync_error: string | null;
  consecutive_failures: number | string;
};

type TeamRow = {
  display_name: string;
  ranobelib_team_id: number | string;
  lifecycle_state: string;
  presence_state: string;
  semantic_status: string;
  baseline_ready: number | string;
  notification_subscriber_count: number | string;
  last_synced_at: string | null;
  sync_error: string | null;
};

type ReleaseRow = {
  release_kind: string;
  chapter_count: number | string;
  first_volume: string | null;
  first_number: string | null;
  last_volume: string | null;
  last_number: string | null;
  summary: string | null;
  created_at: string | null;
};

type OutboxRow = Record<string, unknown>;

export type RanobeLibOpsStatusEnv = RanobeLibAuthEnv & { DB: D1DatabaseLike };

export async function renderRanobeLibOperationalStatus(
  env: RanobeLibOpsStatusEnv,
  target: string,
): Promise<string | null> {
  const normalized = String(target ?? '').trim();
  if (!normalized) return null;
  const title = await findTitle(env.DB, normalized);
  if (!title) return null;

  const [auth, teamsResult, release, outbox] = await Promise.all([
    new RanobeLibAuthProvider(env).health(),
    env.DB.prepare(`
      SELECT team.display_name, team.ranobelib_team_id, team.lifecycle_state,
        tt.presence_state, tt.semantic_status, tt.baseline_ready,
        tt.notification_subscriber_count, tt.last_synced_at, tt.sync_error
      FROM ranobelib_team_translations tt
      JOIN ranobelib_teams team ON team.id=tt.team_id
      WHERE tt.book_ref=?
      ORDER BY team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
    `).bind(title.book_ref).all<TeamRow>(),
    env.DB.prepare(`
      SELECT release_kind, chapter_count, first_volume, first_number,
        last_volume, last_number, summary, created_at
      FROM ranobelib_releases
      WHERE book_ref=?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).bind(title.book_ref).first<ReleaseRow>(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN o.status='retry' THEN 1 ELSE 0 END) AS retry,
        SUM(CASE WHEN o.status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN o.status='disabled' THEN 1 ELSE 0 END) AS disabled,
        SUM(CASE WHEN o.status IN ('pending','retry') AND o.available_at<=CURRENT_TIMESTAMP
          AND (o.claim_token IS NULL OR o.claim_expires_at IS NULL OR o.claim_expires_at<=CURRENT_TIMESTAMP)
          THEN 1 ELSE 0 END) AS due_unleased,
        SUM(CASE WHEN o.status IN ('pending','retry') AND o.claim_token IS NOT NULL
          AND o.claim_expires_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS leased
      FROM ranobelib_notification_outbox o
      JOIN ranobelib_releases r ON r.id=o.release_id
      WHERE r.book_ref=?
    `).bind(title.book_ref).first<OutboxRow>(),
  ]);

  const teams = teamsResult.results;
  const lines = [
    '🔎 <b>RanobeLib status</b>',
    '',
    `<b>${escapeHtml(title.title || title.book_ref)}</b>`,
    `ID: <code>${escapeHtml(String(title.ranobelib_id ?? '—'))}</code> · ref: <code>${escapeHtml(title.book_ref)}</code>`,
    `Глав в snapshot: <b>${n(title.chapter_count)}</b>`,
    `Последняя известная глава: <b>${escapeHtml(formatChapter(title.latest_volume, title.latest_number, title.latest_name))}</b>`,
    `Последняя синхронизация: ${formatDate(title.last_synced_at)}`,
    `Следующая проверка: ${formatDate(title.next_check_at)}`,
    `Ошибок подряд: <b>${n(title.consecutive_failures)}</b>${title.sync_error ? ` · <code>${escapeHtml(clip(title.sync_error, 140))}</code>` : ''}`,
    '',
    '<b>Авторизация</b>',
    `Health: <b>${escapeHtml(auth.state)}</b> · encryption: <b>${escapeHtml(auth.encryptionState)}</b>`,
    `Access expires: ${formatDate(auth.accessExpiresAt)}`,
    `Last refresh: ${formatDate(auth.lastRefreshedAt)} · failures: <b>${n(auth.refreshFailures)}</b>`,
    `Last refresh failure: ${formatDate(auth.lastRefreshFailureAt)}`,
    ...(auth.lastError ? [`Auth error: <code>${escapeHtml(clip(auth.lastError, 140))}</code>`] : []),
    '',
    '<b>Команды / baseline / demand</b>',
    ...(teams.length ? teams.map(renderTeam) : ['Нет team-scoped связей.']),
    '',
    '<b>Последний release</b>',
    release ? renderRelease(release) : 'Нет сохранённых release.',
    '',
    '<b>Outbox этого тайтла</b>',
    `pending <b>${n(outbox?.pending)}</b> · retry <b>${n(outbox?.retry)}</b> · sent <b>${n(outbox?.sent)}</b> · disabled <b>${n(outbox?.disabled)}</b>`,
    `due без lease <b>${n(outbox?.due_unleased)}</b> · active lease <b>${n(outbox?.leased)}</b>`,
  ];
  return lines.join('\n');
}

async function findTitle(db: D1DatabaseLike, target: string): Promise<TitleRow | null> {
  const numeric = /^\d+$/.test(target) ? target : '';
  return db.prepare(`
    SELECT book_ref, ranobelib_id, title, chapter_count,
      latest_volume, latest_number, latest_name, last_synced_at, next_check_at,
      sync_error, consecutive_failures
    FROM ranobelib_titles
    WHERE book_ref=?
       OR (?<>'' AND CAST(ranobelib_id AS TEXT)=?)
       OR (?<>'' AND substr(book_ref,1,length(?)+2)=? || '--')
    ORDER BY CASE WHEN book_ref=? THEN 0 WHEN CAST(ranobelib_id AS TEXT)=? THEN 1 ELSE 2 END
    LIMIT 1
  `).bind(target, numeric, numeric, numeric, numeric, numeric, target, numeric).first<TitleRow>();
}

function renderTeam(team: TeamRow): string {
  const error = team.sync_error ? ` · error <code>${escapeHtml(clip(team.sync_error, 90))}</code>` : '';
  return `• <b>${escapeHtml(team.display_name)}</b> (${escapeHtml(String(team.ranobelib_team_id))}) · ${escapeHtml(team.lifecycle_state)}/${escapeHtml(team.presence_state)}/${escapeHtml(team.semantic_status)} · baseline <b>${n(team.baseline_ready) ? 'ready' : 'no'}</b> · demand <b>${n(team.notification_subscriber_count)}</b> · sync ${formatDate(team.last_synced_at)}${error}`;
}

function renderRelease(release: ReleaseRow): string {
  const range = release.release_kind === 'translation_completed'
    ? 'перевод завершён'
    : release.chapter_count
      ? `${formatChapter(release.first_volume, release.first_number, null)} → ${formatChapter(release.last_volume, release.last_number, null)} (${n(release.chapter_count)})`
      : escapeHtml(release.summary || release.release_kind || 'release');
  return `${escapeHtml(release.release_kind || 'chapters')} · <b>${range}</b> · ${formatDate(release.created_at)}`;
}

function formatChapter(volume: string | null, number: string | null, name: string | null): string {
  if (!volume && !number && !name) return 'нет данных';
  const base = [volume ? `т.${volume}` : '', number ? `гл.${number}` : ''].filter(Boolean).join(' ');
  return [base, name].filter(Boolean).join(' — ');
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function formatDate(value: unknown): string {
  const text = String(value ?? '').trim();
  return text ? `<code>${escapeHtml(text)}</code>` : 'нет данных';
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
