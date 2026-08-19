import { ensureChannelMembershipSchema, type ChannelMembershipEnv } from './channel-membership-access.js';
import { ensurePublicationCommentGateSchema, type PublicationCommentGateEnv } from './publication-comment-gate.js';
import { ensurePublicationOpsSchema } from './publication-ops.js';
import { requireAdminSession } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

export interface PublicationReleaseAnalyticsEnv extends PublicationCommentGateEnv, ChannelMembershipEnv {
  DB: D1DatabaseLike;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export function parsePositiveId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function number(row: Record<string, unknown> | null | undefined, key: string): number {
  return Number(row?.[key] || 0);
}

function parseDetails(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

async function releaseUserDetail(env: PublicationReleaseAnalyticsEnv, publicationId: number, userId: string): Promise<Response> {
  const [profile, events, deliveries] = await Promise.all([
    env.DB.prepare(`WITH target(user_id) AS (VALUES (?))
      SELECT target.user_id AS user_telegram_id,u.username,u.first_name,u.last_name,u.language_code,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='download_gate_click') AS gate_clicks,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='download_open') AS download_opens,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='delivery_started') AS delivery_started,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='delivery_success') AS deliveries,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='delivery_success' AND e.repeat=1) AS repeat_deliveries,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='delivery_failed') AS delivery_failures,
        (SELECT COUNT(*) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id AND e.event_type='support_click') AS support_clicks,
        EXISTS(SELECT 1 FROM publication_thanks t WHERE t.publication_id=? AND t.user_telegram_id=target.user_id) AS thanked,
        (SELECT MIN(created_at) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id) AS first_seen,
        (SELECT MAX(created_at) FROM publication_reader_events e WHERE e.publication_id=? AND e.user_telegram_id=target.user_id) AS last_seen,
        c.last_status,c.last_checked_at,c.left_at,c.rejoined_at,c.blacklisted_at,c.blacklist_reason
      FROM target
      LEFT JOIN users u ON u.telegram_id=target.user_id
      LEFT JOIN channel_access_state c ON c.user_telegram_id=target.user_id`)
      .bind(userId, publicationId, publicationId, publicationId, publicationId, publicationId, publicationId, publicationId, publicationId, publicationId, publicationId)
      .first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT e.id,e.asset_id,a.file_name,e.event_type,e.source,e.success,e.repeat,e.details,e.created_at
      FROM publication_reader_events e
      LEFT JOIN publication_assets a ON a.id=e.asset_id
      WHERE e.publication_id=? AND e.user_telegram_id=?
      ORDER BY e.id DESC LIMIT 200`).bind(publicationId, userId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT d.asset_id,a.file_name,d.status,d.attempts,d.first_delivered_at,d.last_delivered_at,d.telegram_message_id,d.last_error,d.updated_at
      FROM publication_deliveries d
      JOIN publication_assets a ON a.id=d.asset_id
      WHERE d.publication_id=? AND d.user_telegram_id=?
      ORDER BY a.sort_order,a.id`).bind(publicationId, userId).all<Record<string, unknown>>(),
  ]);

  const user = profile || { user_telegram_id: userId };
  return json({
    publication_id: publicationId,
    user: {
      ...user,
      gate_clicks: number(user, 'gate_clicks'),
      download_opens: number(user, 'download_opens'),
      delivery_started: number(user, 'delivery_started'),
      deliveries: number(user, 'deliveries'),
      repeat_deliveries: number(user, 'repeat_deliveries'),
      delivery_failures: number(user, 'delivery_failures'),
      support_clicks: number(user, 'support_clicks'),
      thanked: Boolean(user.thanked),
    },
    deliveries: deliveries.results,
    events: events.results.map((row) => ({ ...row, success: Boolean(row.success), repeat: Boolean(row.repeat), details: parseDetails(row.details) })),
  });
}

async function releaseDetail(env: PublicationReleaseAnalyticsEnv, publicationId: number): Promise<Response> {
  const [publication, summaryRow, files, users] = await Promise.all([
    env.DB.prepare(`SELECT p.id,p.status,p.internal_title,p.published_at,p.created_at,p.channel_message_id,p.discussion_message_id,p.error_text,
        g.status AS gate_status,g.attempts AS gate_attempts,g.gate_message_id,g.discussion_message_id AS gate_discussion_message_id,
        g.last_error AS gate_error,g.updated_at AS gate_updated_at
      FROM publications p
      LEFT JOIN publication_comment_gates g ON g.publication_id=p.id
      WHERE p.id=? LIMIT 1`).bind(publicationId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT
        SUM(CASE WHEN event_type='download_gate_click' THEN 1 ELSE 0 END) AS gate_clicks,
        SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) AS download_opens,
        SUM(CASE WHEN event_type='delivery_started' THEN 1 ELSE 0 END) AS delivery_started,
        COUNT(DISTINCT CASE WHEN event_type='delivery_success' THEN user_telegram_id END) AS readers,
        SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) AS deliveries,
        SUM(CASE WHEN event_type='delivery_success' THEN repeat ELSE 0 END) AS repeats,
        SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) AS support_clicks,
        (SELECT COUNT(*) FROM publication_thanks WHERE publication_id=?) AS thanks
      FROM publication_reader_events WHERE publication_id=?`).bind(publicationId, publicationId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT a.id,a.file_name,a.mime_type,a.size_bytes,a.telegram_file_id,a.sort_order,
        COALESCE(SUM(CASE WHEN e.event_type='delivery_success' THEN 1 ELSE 0 END),0) AS deliveries,
        COALESCE(SUM(CASE WHEN e.event_type='delivery_success' THEN e.repeat ELSE 0 END),0) AS repeats,
        COALESCE(SUM(CASE WHEN e.event_type='delivery_failed' THEN 1 ELSE 0 END),0) AS failures,
        COUNT(DISTINCT CASE WHEN e.event_type='delivery_success' THEN e.user_telegram_id END) AS readers
      FROM publication_assets a
      LEFT JOIN publication_reader_events e ON e.asset_id=a.id AND e.publication_id=a.publication_id
      WHERE a.publication_id=?
      GROUP BY a.id ORDER BY a.sort_order,a.id`).bind(publicationId).all<Record<string, unknown>>(),
    env.DB.prepare(`WITH event_stats AS (
        SELECT user_telegram_id,
          SUM(CASE WHEN event_type='download_gate_click' THEN 1 ELSE 0 END) AS gate_clicks,
          SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) AS download_opens,
          SUM(CASE WHEN event_type='delivery_started' THEN 1 ELSE 0 END) AS delivery_started,
          SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) AS deliveries,
          SUM(CASE WHEN event_type='delivery_success' THEN repeat ELSE 0 END) AS repeats,
          SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) AS failures,
          SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) AS support_clicks,
          MIN(created_at) AS first_seen,MAX(created_at) AS last_seen
        FROM publication_reader_events
        WHERE publication_id=? AND user_telegram_id IS NOT NULL
        GROUP BY user_telegram_id
      ), delivery_ids AS (
        SELECT DISTINCT user_telegram_id FROM publication_deliveries WHERE publication_id=?
      ), thank_ids AS (
        SELECT user_telegram_id FROM publication_thanks WHERE publication_id=?
      ), ids AS (
        SELECT user_telegram_id FROM event_stats
        UNION SELECT user_telegram_id FROM delivery_ids
        UNION SELECT user_telegram_id FROM thank_ids
      )
      SELECT ids.user_telegram_id,u.username,u.first_name,u.last_name,
        COALESCE(es.gate_clicks,0) AS gate_clicks,COALESCE(es.download_opens,0) AS download_opens,
        COALESCE(es.delivery_started,0) AS delivery_started,COALESCE(es.deliveries,0) AS deliveries,
        COALESCE(es.repeats,0) AS repeat_deliveries,COALESCE(es.failures,0) AS delivery_failures,
        COALESCE(es.support_clicks,0) AS support_clicks,es.first_seen,es.last_seen,
        EXISTS(SELECT 1 FROM publication_thanks t WHERE t.publication_id=? AND t.user_telegram_id=ids.user_telegram_id) AS thanked,
        c.last_status,c.last_checked_at,c.left_at,c.rejoined_at,c.blacklisted_at,c.blacklist_reason
      FROM ids
      LEFT JOIN event_stats es ON es.user_telegram_id=ids.user_telegram_id
      LEFT JOIN users u ON u.telegram_id=ids.user_telegram_id
      LEFT JOIN channel_access_state c ON c.user_telegram_id=ids.user_telegram_id
      ORDER BY COALESCE(es.deliveries,0) DESC,COALESCE(es.last_seen,'') DESC,ids.user_telegram_id DESC
      LIMIT 300`).bind(publicationId, publicationId, publicationId, publicationId).all<Record<string, unknown>>(),
  ]);

  if (!publication) return json({ error: 'Релиз не найден.' }, 404);
  const summary = summaryRow || {};
  const opens = number(summary, 'download_opens');
  const readers = number(summary, 'readers');
  return json({
    publication: {
      ...publication,
      gate_attempts: Number(publication.gate_attempts || 0),
    },
    summary: {
      gate_clicks: number(summary, 'gate_clicks'),
      download_opens: opens,
      delivery_started: number(summary, 'delivery_started'),
      readers,
      deliveries: number(summary, 'deliveries'),
      repeat_deliveries: number(summary, 'repeats'),
      delivery_failures: number(summary, 'failures'),
      thanks: number(summary, 'thanks'),
      support_clicks: number(summary, 'support_clicks'),
      open_to_reader_rate: opens ? Math.round((readers / opens) * 1000) / 10 : 0,
    },
    files: files.results,
    users: users.results.map((row) => ({ ...row, thanked: Boolean(row.thanked) })),
  });
}

export async function handlePublicationReleaseAnalytics(request: Request, env: PublicationReleaseAnalyticsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/admin/publishing-analytics/release') return null;
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const publicationId = parsePositiveId(url.searchParams.get('publication_id'));
  if (!publicationId) return json({ error: 'Некорректный publication_id.' }, 400);

  await Promise.all([
    ensurePublicationOpsSchema(env),
    ensurePublicationCommentGateSchema(env),
    ensureChannelMembershipSchema(env),
  ]);

  const requestedUser = url.searchParams.get('user_id');
  if (requestedUser !== null) {
    if (!/^\d+$/.test(requestedUser)) return json({ error: 'Некорректный user_id.' }, 400);
    return releaseUserDetail(env, publicationId, requestedUser);
  }
  return releaseDetail(env, publicationId);
}
