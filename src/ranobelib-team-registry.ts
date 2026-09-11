import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { refreshAllWorkNotificationDemand } from './multi-team-notification-demand.js';

export type RanobeLibTeamLifecycleState = 'hidden' | 'published' | 'paused' | 'error';

export type RanobeLibTeamRecord = {
  id: number;
  ranobelibTeamId: number;
  ranobelibTeamRef: string;
  displayName: string;
  isPrimary: boolean;
  lifecycleState: RanobeLibTeamLifecycleState;
  recommendationChatId: string | null;
  recommendationChatTitle: string | null;
  recommendationChatUsername: string | null;
  recommendationMembershipCapable: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
};

export type RanobeLibTeamRegistryEnv = { DB: D1DatabaseLike };

export type RegisterRanobeLibTeamInput = {
  ranobelibTeamId: number;
  ranobelibTeamRef: string;
  displayName: string;
  lifecycleState?: RanobeLibTeamLifecycleState;
};

type TeamRow = {
  id: number | string;
  ranobelib_team_id: number | string;
  ranobelib_team_ref: string;
  display_name: string;
  is_primary: number | string;
  lifecycle_state: RanobeLibTeamLifecycleState;
  recommendation_chat_id: string | null;
  recommendation_chat_title: string | null;
  recommendation_chat_username: string | null;
  recommendation_membership_capable: number | string;
  last_sync_at: string | null;
  last_sync_error: string | null;
};

export async function listRunnableRanobeLibTeams(env: RanobeLibTeamRegistryEnv): Promise<RanobeLibTeamRecord[]> {
  const { results } = await env.DB.prepare(`
    SELECT id, ranobelib_team_id, ranobelib_team_ref, display_name, is_primary,
           lifecycle_state, recommendation_chat_id, recommendation_chat_title,
           recommendation_chat_username, recommendation_membership_capable,
           last_sync_at, last_sync_error
    FROM ranobelib_teams
    WHERE lifecycle_state IN ('hidden', 'published')
    ORDER BY is_primary DESC, id ASC
  `).all<TeamRow>();
  return results.map(normalizeTeamRow);
}

export async function listAllRanobeLibTeams(env: RanobeLibTeamRegistryEnv): Promise<RanobeLibTeamRecord[]> {
  const { results } = await env.DB.prepare(`
    SELECT id, ranobelib_team_id, ranobelib_team_ref, display_name, is_primary,
           lifecycle_state, recommendation_chat_id, recommendation_chat_title,
           recommendation_chat_username, recommendation_membership_capable,
           last_sync_at, last_sync_error
    FROM ranobelib_teams
    ORDER BY is_primary DESC, display_name COLLATE NOCASE ASC, id ASC
  `).all<TeamRow>();
  return results.map(normalizeTeamRow);
}

export async function getPrimaryRanobeLibTeam(env: RanobeLibTeamRegistryEnv): Promise<RanobeLibTeamRecord | null> {
  const row = await env.DB.prepare(`
    SELECT id, ranobelib_team_id, ranobelib_team_ref, display_name, is_primary,
           lifecycle_state, recommendation_chat_id, recommendation_chat_title,
           recommendation_chat_username, recommendation_membership_capable,
           last_sync_at, last_sync_error
    FROM ranobelib_teams
    WHERE is_primary = 1
    LIMIT 1
  `).first<TeamRow>();
  return row ? normalizeTeamRow(row) : null;
}

export async function getRanobeLibTeamById(
  env: RanobeLibTeamRegistryEnv,
  teamId: number,
): Promise<RanobeLibTeamRecord | null> {
  const row = await env.DB.prepare(`
    SELECT id, ranobelib_team_id, ranobelib_team_ref, display_name, is_primary,
           lifecycle_state, recommendation_chat_id, recommendation_chat_title,
           recommendation_chat_username, recommendation_membership_capable,
           last_sync_at, last_sync_error
    FROM ranobelib_teams
    WHERE id = ?
    LIMIT 1
  `).bind(teamId).first<TeamRow>();
  return row ? normalizeTeamRow(row) : null;
}

export async function registerRanobeLibTeam(
  env: RanobeLibTeamRegistryEnv,
  input: RegisterRanobeLibTeamInput,
): Promise<RanobeLibTeamRecord> {
  const upstreamId = positiveInt(input.ranobelibTeamId, 'ranobelibTeamId');
  const ref = requiredText(input.ranobelibTeamRef, 'ranobelibTeamRef');
  const displayName = requiredText(input.displayName, 'displayName');
  const lifecycle = input.lifecycleState ?? 'hidden';

  await env.DB.prepare(`
    INSERT INTO ranobelib_teams (
      ranobelib_team_id, ranobelib_team_ref, display_name, is_primary, lifecycle_state, updated_at
    ) VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ranobelib_team_ref) DO UPDATE SET
      ranobelib_team_id = excluded.ranobelib_team_id,
      display_name = excluded.display_name,
      updated_at = CURRENT_TIMESTAMP
  `).bind(upstreamId, ref, displayName, lifecycle).run();

  const row = await env.DB.prepare(`
    SELECT id, ranobelib_team_id, ranobelib_team_ref, display_name, is_primary,
           lifecycle_state, recommendation_chat_id, recommendation_chat_title,
           recommendation_chat_username, recommendation_membership_capable,
           last_sync_at, last_sync_error
    FROM ranobelib_teams
    WHERE ranobelib_team_ref = ?
    LIMIT 1
  `).bind(ref).first<TeamRow>();
  if (!row) throw new Error(`Failed to register RanobeLib team ${ref}`);
  return normalizeTeamRow(row);
}

export async function setRanobeLibTeamLifecycle(
  env: RanobeLibTeamRegistryEnv,
  teamId: number,
  state: RanobeLibTeamLifecycleState,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE ranobelib_teams
    SET lifecycle_state = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(state, positiveInt(teamId, 'teamId')).run();
  await refreshAllWorkNotificationDemand(env);
}

export async function recordRanobeLibTeamSyncSuccess(
  env: RanobeLibTeamRegistryEnv,
  teamId: number,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE ranobelib_teams
    SET last_sync_at = CURRENT_TIMESTAMP,
        last_sync_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(positiveInt(teamId, 'teamId')).run();
}

export async function recordRanobeLibTeamSyncFailure(
  env: RanobeLibTeamRegistryEnv,
  teamId: number,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await env.DB.prepare(`
    UPDATE ranobelib_teams
    SET last_sync_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(message, positiveInt(teamId, 'teamId')).run();
}

export async function setRanobeLibRecommendationChannel(
  env: RanobeLibTeamRegistryEnv,
  teamId: number,
  channel: {
    chatId: string;
    title: string | null;
    username: string | null;
    membershipCapable: boolean;
  } | null,
): Promise<void> {
  if (!channel) {
    await env.DB.prepare(`
      UPDATE ranobelib_teams SET
        recommendation_chat_id = NULL,
        recommendation_chat_title = NULL,
        recommendation_chat_username = NULL,
        recommendation_membership_capable = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(positiveInt(teamId, 'teamId')).run();
    return;
  }
  const chatId = requiredText(channel.chatId, 'chatId');
  await env.DB.prepare(`
    UPDATE ranobelib_teams SET
      recommendation_chat_id = ?,
      recommendation_chat_title = ?,
      recommendation_chat_username = ?,
      recommendation_membership_capable = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    chatId,
    nullableText(channel.title),
    normalizeUsername(channel.username),
    channel.membershipCapable ? 1 : 0,
    positiveInt(teamId, 'teamId'),
  ).run();
}

function normalizeTeamRow(row: TeamRow): RanobeLibTeamRecord {
  return {
    id: Number(row.id),
    ranobelibTeamId: Number(row.ranobelib_team_id),
    ranobelibTeamRef: String(row.ranobelib_team_ref),
    displayName: String(row.display_name),
    isPrimary: Number(row.is_primary) === 1,
    lifecycleState: row.lifecycle_state,
    recommendationChatId: nullableText(row.recommendation_chat_id),
    recommendationChatTitle: nullableText(row.recommendation_chat_title),
    recommendationChatUsername: normalizeUsername(row.recommendation_chat_username),
    recommendationMembershipCapable: Number(row.recommendation_membership_capable) === 1,
    lastSyncAt: nullableText(row.last_sync_at),
    lastSyncError: nullableText(row.last_sync_error),
  };
}

function positiveInt(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredText(value: unknown, name: string): string {
  const text = nullableText(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeUsername(value: unknown): string | null {
  const text = nullableText(value);
  if (!text) return null;
  return text.startsWith('@') ? text.slice(1) : text;
}
