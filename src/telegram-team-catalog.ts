import type { D1DatabaseLike } from './ranobelib-runtime.js';

export type TelegramTeamCatalogEnv = { DB: D1DatabaseLike };

export type TeamCatalogTeam = {
  id: number;
  displayName: string;
  isPrimary: boolean;
  followed: boolean;
  activeCount: number;
  completedCount: number;
};

export type TeamCatalogTranslation = {
  teamId: number;
  teamName: string;
  teamIsPrimary: boolean;
  ranobelibId: number | null;
  bookRef: string;
  title: string;
  url: string;
  semanticStatus: 'active' | 'completed' | 'unknown';
  enabled: boolean;
  enabledReason: 'excluded' | 'team' | 'explicit' | 'none';
};

export type WorkSearchGroup = {
  bookRef: string;
  ranobelibId: number | null;
  title: string;
  translations: TeamCatalogTranslation[];
};

type TeamRow = {
  id: number | string;
  display_name: string;
  is_primary: number | string;
  followed: number | string;
  active_count: number | string;
  completed_count: number | string;
};

type TranslationRow = {
  team_id: number | string;
  team_name: string;
  team_is_primary: number | string;
  ranobelib_id: number | string | null;
  book_ref: string;
  title: string | null;
  url: string;
  semantic_status: string;
  team_followed: number | string;
  explicit_subscribed: number | string;
  excluded: number | string;
};

export async function countFollowedTeams(env: TelegramTeamCatalogEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM telegram_team_subscriptions sub
    JOIN ranobelib_teams team ON team.id=sub.team_id
    WHERE sub.user_telegram_id=? AND team.lifecycle_state='published'
  `).bind(userId).first<{ count: number | string | null }>();
  return nonNegative(row?.count);
}

export async function countManualTeamTitles(env: TelegramTeamCatalogEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM telegram_team_title_subscriptions manual
    JOIN ranobelib_team_translations tt
      ON tt.team_id=manual.team_id AND tt.book_ref=manual.book_ref
    JOIN ranobelib_teams team ON team.id=manual.team_id
    WHERE manual.user_telegram_id=?
      AND team.lifecycle_state='published'
      AND tt.presence_state='active'
      AND NOT EXISTS (
        SELECT 1 FROM telegram_team_subscriptions whole
        WHERE whole.user_telegram_id=manual.user_telegram_id AND whole.team_id=manual.team_id
      )
  `).bind(userId).first<{ count: number | string | null }>();
  return nonNegative(row?.count);
}

export async function listPublishedTeams(
  env: TelegramTeamCatalogEnv,
  userId: string,
  page = 0,
  pageSize = 8,
): Promise<TeamCatalogTeam[]> {
  const limit = clamp(pageSize, 1, 20);
  const offset = clamp(page, 0, 1_000_000) * limit;
  const { results } = await env.DB.prepare(`
    SELECT team.id, team.display_name, team.is_primary,
      CASE WHEN sub.team_id IS NULL THEN 0 ELSE 1 END AS followed,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status<>'completed' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status='completed' THEN 1 ELSE 0 END) AS completed_count
    FROM ranobelib_teams team
    LEFT JOIN telegram_team_subscriptions sub
      ON sub.team_id=team.id AND sub.user_telegram_id=?
    LEFT JOIN ranobelib_team_translations tt ON tt.team_id=team.id
    WHERE team.lifecycle_state='published'
    GROUP BY team.id, team.display_name, team.is_primary, sub.team_id
    ORDER BY team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, limit + 1, offset).all<TeamRow>();
  return results.map(teamFromRow);
}

export async function listMyFollowedTeams(
  env: TelegramTeamCatalogEnv,
  userId: string,
  page = 0,
  pageSize = 8,
): Promise<TeamCatalogTeam[]> {
  const limit = clamp(pageSize, 1, 20);
  const offset = clamp(page, 0, 1_000_000) * limit;
  const { results } = await env.DB.prepare(`
    SELECT team.id, team.display_name, team.is_primary, 1 AS followed,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status<>'completed' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status='completed' THEN 1 ELSE 0 END) AS completed_count
    FROM telegram_team_subscriptions sub
    JOIN ranobelib_teams team ON team.id=sub.team_id
    LEFT JOIN ranobelib_team_translations tt ON tt.team_id=team.id
    WHERE sub.user_telegram_id=? AND team.lifecycle_state='published'
    GROUP BY team.id, team.display_name, team.is_primary
    ORDER BY team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, limit + 1, offset).all<TeamRow>();
  return results.map(teamFromRow);
}

export async function listTeamTranslations(
  env: TelegramTeamCatalogEnv,
  userId: string,
  teamId: number,
  options: { completed?: boolean; page?: number; pageSize?: number } = {},
): Promise<TeamCatalogTranslation[]> {
  const limit = clamp(options.pageSize ?? 8, 1, 20);
  const offset = clamp(options.page ?? 0, 0, 1_000_000) * limit;
  const completed = options.completed === true;
  const { results } = await env.DB.prepare(`${translationSelectSql()}
    WHERE team.id=?
      AND team.lifecycle_state='published'
      AND tt.presence_state='active'
      AND ${completed ? "tt.semantic_status='completed'" : "tt.semantic_status<>'completed'"}
    ORDER BY title COLLATE NOCASE ASC, t.ranobelib_id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, userId, userId, teamId, limit + 1, offset).all<TranslationRow>();
  return results.map(translationFromRow);
}

/**
 * Manually followed translations only. Titles inherited from a whole-team follow are deliberately
 * omitted so `Мои новеллы` does not explode into hundreds of rows.
 */
export async function listMyManualTeamTitles(
  env: TelegramTeamCatalogEnv,
  userId: string,
  page = 0,
  pageSize = 8,
): Promise<TeamCatalogTranslation[]> {
  const limit = clamp(pageSize, 1, 20);
  const offset = clamp(page, 0, 1_000_000) * limit;
  const { results } = await env.DB.prepare(`${translationSelectSql()}
    JOIN telegram_team_title_subscriptions manual
      ON manual.team_id=tt.team_id AND manual.book_ref=tt.book_ref AND manual.user_telegram_id=?
    WHERE team.lifecycle_state='published'
      AND tt.presence_state='active'
      AND NOT EXISTS (
        SELECT 1 FROM telegram_team_subscriptions whole
        WHERE whole.user_telegram_id=? AND whole.team_id=tt.team_id
      )
    ORDER BY title COLLATE NOCASE ASC, team.display_name COLLATE NOCASE ASC, t.ranobelib_id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, userId, userId, userId, userId, limit + 1, offset).all<TranslationRow>();
  return results.map(translationFromRow);
}

export async function searchPublishedTeamTranslations(
  env: TelegramTeamCatalogEnv,
  userId: string,
  query: string,
  page = 0,
  pageSize = 8,
): Promise<WorkSearchGroup[]> {
  const clean = String(query ?? '').trim();
  if (!clean) return [];
  const limit = clamp(pageSize, 1, 20);
  const offset = clamp(page, 0, 1_000_000) * limit;
  // Pagination is work-oriented: first choose matching works, then return all published translations
  // for those works so a duplicate title is never split across pages by team.
  const { results } = await env.DB.prepare(`
    WITH matching_works AS (
      SELECT DISTINCT t.book_ref, t.title, t.ranobelib_id
      FROM ranobelib_titles t
      JOIN ranobelib_team_translations tt ON tt.book_ref=t.book_ref
      JOIN ranobelib_teams team ON team.id=tt.team_id
      WHERE team.lifecycle_state='published'
        AND tt.presence_state='active'
        AND COALESCE(t.title, t.book_ref) LIKE ? COLLATE NOCASE
      ORDER BY COALESCE(t.title, t.book_ref) COLLATE NOCASE ASC, t.ranobelib_id ASC
      LIMIT ? OFFSET ?
    )
    SELECT
      team.id AS team_id,
      team.display_name AS team_name,
      team.is_primary AS team_is_primary,
      work.ranobelib_id,
      work.book_ref,
      COALESCE(work.title, work.book_ref) AS title,
      work.url,
      tt.semantic_status,
      CASE WHEN whole.team_id IS NULL THEN 0 ELSE 1 END AS team_followed,
      CASE WHEN explicit.book_ref IS NULL THEN 0 ELSE 1 END AS explicit_subscribed,
      CASE WHEN exclusion.book_ref IS NULL THEN 0 ELSE 1 END AS excluded
    FROM matching_works matches
    JOIN ranobelib_titles work ON work.book_ref=matches.book_ref
    JOIN ranobelib_team_translations tt ON tt.book_ref=work.book_ref AND tt.presence_state='active'
    JOIN ranobelib_teams team ON team.id=tt.team_id AND team.lifecycle_state='published'
    LEFT JOIN telegram_team_subscriptions whole
      ON whole.user_telegram_id=? AND whole.team_id=team.id
    LEFT JOIN telegram_team_title_subscriptions explicit
      ON explicit.user_telegram_id=? AND explicit.team_id=team.id AND explicit.book_ref=work.book_ref
    LEFT JOIN telegram_team_title_exclusions exclusion
      ON exclusion.user_telegram_id=? AND exclusion.team_id=team.id AND exclusion.book_ref=work.book_ref
    ORDER BY title COLLATE NOCASE ASC, work.ranobelib_id ASC,
      team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
  `).bind(`%${clean}%`, limit, offset, userId, userId, userId).all<TranslationRow>();
  return groupTeamTranslationSearch(results.map(translationFromRow));
}

export function groupTeamTranslationSearch(rows: readonly TeamCatalogTranslation[]): WorkSearchGroup[] {
  const groups = new Map<string, WorkSearchGroup>();
  for (const row of rows) {
    let group = groups.get(row.bookRef);
    if (!group) {
      group = {
        bookRef: row.bookRef,
        ranobelibId: row.ranobelibId,
        title: row.title,
        translations: [],
      };
      groups.set(row.bookRef, group);
    }
    group.translations.push(row);
  }
  return [...groups.values()];
}

function translationSelectSql(): string {
  return `
    SELECT
      team.id AS team_id,
      team.display_name AS team_name,
      team.is_primary AS team_is_primary,
      t.ranobelib_id,
      t.book_ref,
      COALESCE(t.title, t.book_ref) AS title,
      t.url,
      tt.semantic_status,
      CASE WHEN whole.team_id IS NULL THEN 0 ELSE 1 END AS team_followed,
      CASE WHEN explicit.book_ref IS NULL THEN 0 ELSE 1 END AS explicit_subscribed,
      CASE WHEN exclusion.book_ref IS NULL THEN 0 ELSE 1 END AS excluded
    FROM ranobelib_team_translations tt
    JOIN ranobelib_teams team ON team.id=tt.team_id
    JOIN ranobelib_titles t ON t.book_ref=tt.book_ref
    LEFT JOIN telegram_team_subscriptions whole
      ON whole.user_telegram_id=? AND whole.team_id=tt.team_id
    LEFT JOIN telegram_team_title_subscriptions explicit
      ON explicit.user_telegram_id=? AND explicit.team_id=tt.team_id AND explicit.book_ref=tt.book_ref
    LEFT JOIN telegram_team_title_exclusions exclusion
      ON exclusion.user_telegram_id=? AND exclusion.team_id=tt.team_id AND exclusion.book_ref=tt.book_ref
  `;
}

function translationFromRow(row: TranslationRow): TeamCatalogTranslation {
  const excluded = Number(row.excluded) === 1;
  const teamFollowed = Number(row.team_followed) === 1;
  const explicit = Number(row.explicit_subscribed) === 1;
  const enabledReason: TeamCatalogTranslation['enabledReason'] = excluded
    ? 'excluded'
    : teamFollowed
      ? 'team'
      : explicit
        ? 'explicit'
        : 'none';
  return {
    teamId: Number(row.team_id),
    teamName: String(row.team_name),
    teamIsPrimary: Number(row.team_is_primary) === 1,
    ranobelibId: nullableNumber(row.ranobelib_id),
    bookRef: String(row.book_ref),
    title: String(row.title ?? row.book_ref),
    url: String(row.url),
    semanticStatus: normalizeSemanticStatus(row.semantic_status),
    enabled: enabledReason === 'team' || enabledReason === 'explicit',
    enabledReason,
  };
}

function teamFromRow(row: TeamRow): TeamCatalogTeam {
  return {
    id: Number(row.id),
    displayName: String(row.display_name),
    isPrimary: Number(row.is_primary) === 1,
    followed: Number(row.followed) === 1,
    activeCount: nonNegative(row.active_count),
    completedCount: nonNegative(row.completed_count),
  };
}

function normalizeSemanticStatus(value: unknown): TeamCatalogTranslation['semanticStatus'] {
  return value === 'active' || value === 'completed' ? value : 'unknown';
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
