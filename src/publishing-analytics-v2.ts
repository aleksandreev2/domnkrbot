import { ensurePublicationCommentGateSchema, type PublicationCommentGateEnv } from './publication-comment-gate.js';
import { ensurePublicationOpsSchema } from './publication-ops.js';
import { requireAdminSession } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<any>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }
export interface PublishingAnalyticsV2Env extends PublicationCommentGateEnv { DB: D1DatabaseLike }

const DAY_MS = 86_400_000;
const PERIODS = new Set([0, 7, 30, 90, 365]);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function numeric(row: Record<string, unknown> | null | undefined, key: string): number {
  return Number(row?.[key] || 0);
}
function periodClause(column: string, since: string | null, until: string | null): { sql: string; values: string[] } {
  const pieces: string[] = [];
  const values: string[] = [];
  if (since) { pieces.push(`${column}>=?`); values.push(since); }
  if (until) { pieces.push(`${column}<?`); values.push(until); }
  return { sql: pieces.length ? `WHERE ${pieces.join(' AND ')}` : '', values };
}
function andPeriod(column: string, since: string | null, until: string | null): { sql: string; values: string[] } {
  const pieces: string[] = [];
  const values: string[] = [];
  if (since) { pieces.push(`${column}>=?`); values.push(since); }
  if (until) { pieces.push(`${column}<?`); values.push(until); }
  return { sql: pieces.length ? ` AND ${pieces.join(' AND ')}` : '', values };
}

async function periodSummary(env: PublishingAnalyticsV2Env, since: string | null, until: string | null) {
  const events = periodClause('created_at', since, until);
  const thanks = periodClause('created_at', since, until);
  const published = andPeriod('published_at', since, until);
  const [eventRow, thanksRow, publishedRow] = await Promise.all([
    env.DB.prepare(`SELECT
      SUM(CASE WHEN event_type='download_gate_click' THEN 1 ELSE 0 END) gate_clicks,
      SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) download_opens,
      COUNT(DISTINCT CASE WHEN event_type='delivery_success' THEN user_telegram_id END) unique_readers,
      SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) deliveries,
      SUM(CASE WHEN event_type='delivery_success' THEN repeat ELSE 0 END) repeat_deliveries,
      SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) delivery_failures,
      SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) support_clicks
      FROM publication_reader_events ${events.sql}`).bind(...events.values).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS thanks FROM publication_thanks ${thanks.sql}`).bind(...thanks.values).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS published FROM publications WHERE status='published'${published.sql}`).bind(...published.values).first<Record<string, unknown>>(),
  ]);
  return {
    published: numeric(publishedRow, 'published'),
    gate_clicks: numeric(eventRow, 'gate_clicks'),
    download_opens: numeric(eventRow, 'download_opens'),
    unique_readers: numeric(eventRow, 'unique_readers'),
    deliveries: numeric(eventRow, 'deliveries'),
    repeat_deliveries: numeric(eventRow, 'repeat_deliveries'),
    delivery_failures: numeric(eventRow, 'delivery_failures'),
    thanks: numeric(thanksRow, 'thanks'),
    support_clicks: numeric(eventRow, 'support_clicks'),
  };
}

async function dailySeries(env: PublishingAnalyticsV2Env, since: string) {
  const [events, thanks, publications] = await Promise.all([
    env.DB.prepare(`SELECT substr(created_at,1,10) AS day,
      SUM(CASE WHEN event_type='download_gate_click' THEN 1 ELSE 0 END) gate_clicks,
      SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) download_opens,
      COUNT(DISTINCT CASE WHEN event_type='delivery_success' THEN user_telegram_id END) readers,
      SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) deliveries,
      SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) failures,
      SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) support_clicks
      FROM publication_reader_events WHERE created_at>=? GROUP BY substr(created_at,1,10) ORDER BY day`).bind(since).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT substr(created_at,1,10) AS day,COUNT(*) AS thanks FROM publication_thanks WHERE created_at>=? GROUP BY substr(created_at,1,10) ORDER BY day`).bind(since).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT substr(published_at,1,10) AS day,COUNT(*) AS published FROM publications WHERE status='published' AND published_at>=? GROUP BY substr(published_at,1,10) ORDER BY day`).bind(since).all<Record<string, unknown>>(),
  ]);
  const map = new Map<string, Record<string, unknown>>();
  const rowFor = (day: string) => {
    const existing = map.get(day);
    if (existing) return existing;
    const row: Record<string, unknown> = { day, gate_clicks: 0, download_opens: 0, readers: 0, deliveries: 0, failures: 0, support_clicks: 0, thanks: 0, published: 0 };
    map.set(day, row);
    return row;
  };
  for (const row of events.results) Object.assign(rowFor(String(row.day)), row);
  for (const row of thanks.results) Object.assign(rowFor(String(row.day)), row);
  for (const row of publications.results) Object.assign(rowFor(String(row.day)), row);
  return [...map.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

async function gateHealth(env: PublishingAnalyticsV2Env) {
  const row = await env.DB.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN g.status='sent' THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN g.status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN g.status IN ('waiting_forward','pending') THEN 1 ELSE 0 END) AS waiting,
    SUM(CASE WHEN p.discussion_message_id IS NULL THEN 1 ELSE 0 END) AS discussion_missing
    FROM publications p
    LEFT JOIN publication_comment_gates g ON g.publication_id=p.id
    WHERE p.status='published' AND (
      p.add_bot_comment=1 OR EXISTS(SELECT 1 FROM publication_assets a WHERE a.publication_id=p.id)
    )`).first<Record<string, unknown>>();
  return {
    total: numeric(row, 'total'), sent: numeric(row, 'sent'), failed: numeric(row, 'failed'),
    waiting: numeric(row, 'waiting'), discussion_missing: numeric(row, 'discussion_missing'),
  };
}

async function releaseMetrics(env: PublishingAnalyticsV2Env, since: string | null, until: string | null) {
  const events = periodClause('created_at', since, until);
  const thanks = periodClause('created_at', since, until);
  const [eventRows, thanksRows, pubs] = await Promise.all([
    env.DB.prepare(`SELECT publication_id,
      SUM(CASE WHEN event_type='download_gate_click' THEN 1 ELSE 0 END) gate_clicks,
      SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) download_opens,
      COUNT(DISTINCT CASE WHEN event_type='delivery_success' THEN user_telegram_id END) readers,
      SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) deliveries,
      SUM(CASE WHEN event_type='delivery_success' THEN repeat ELSE 0 END) repeats,
      SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) failures,
      SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) support_clicks
      FROM publication_reader_events ${events.sql} GROUP BY publication_id`).bind(...events.values).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT publication_id,COUNT(*) AS thanks FROM publication_thanks ${thanks.sql} GROUP BY publication_id`).bind(...thanks.values).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT p.id,p.internal_title,p.published_at,p.discussion_message_id,p.error_text,
      COUNT(a.id) AS file_count,g.status AS gate_status,g.gate_message_id,g.last_error AS gate_error
      FROM publications p
      LEFT JOIN publication_assets a ON a.publication_id=p.id
      LEFT JOIN publication_comment_gates g ON g.publication_id=p.id
      WHERE p.status='published'
      GROUP BY p.id ORDER BY p.published_at DESC LIMIT 150`).all<Record<string, unknown>>(),
  ]);
  const eventMap = new Map(eventRows.results.map((row) => [Number(row.publication_id), row]));
  const thanksMap = new Map(thanksRows.results.map((row) => [Number(row.publication_id), Number(row.thanks || 0)]));
  const releases = pubs.results.map((pub) => {
    const metric = eventMap.get(Number(pub.id)) || {};
    const readers = Number(metric.readers || 0);
    const opens = Number(metric.download_opens || 0);
    return {
      id: Number(pub.id),
      title: String(pub.internal_title || `Публикация #${pub.id}`),
      published_at: pub.published_at,
      file_count: Number(pub.file_count || 0),
      discussion_ready: Boolean(pub.discussion_message_id),
      gate_status: String(pub.gate_status || 'missing'),
      gate_message_id: pub.gate_message_id == null ? null : Number(pub.gate_message_id),
      gate_error: pub.gate_error || null,
      error_text: pub.error_text || null,
      gate_clicks: Number(metric.gate_clicks || 0),
      download_opens: opens,
      readers,
      deliveries: Number(metric.deliveries || 0),
      repeat_deliveries: Number(metric.repeats || 0),
      delivery_failures: Number(metric.failures || 0),
      thanks: thanksMap.get(Number(pub.id)) || 0,
      support_clicks: Number(metric.support_clicks || 0),
      open_to_reader_rate: opens ? Math.round((readers / opens) * 1000) / 10 : 0,
    };
  });
  releases.sort((a, b) => b.readers - a.readers || b.download_opens - a.download_opens || b.id - a.id);
  return releases;
}

async function recentEvents(env: PublishingAnalyticsV2Env, since: string | null) {
  const clause = since ? 'WHERE e.created_at>=?' : '';
  const values = since ? [since] : [];
  return (await env.DB.prepare(`SELECT e.id,e.publication_id,e.asset_id,e.user_telegram_id,e.event_type,e.source,e.success,e.repeat,e.created_at,
      p.internal_title,u.username,u.first_name
      FROM publication_reader_events e
      JOIN publications p ON p.id=e.publication_id
      LEFT JOIN users u ON u.telegram_id=e.user_telegram_id
      ${clause}
      ORDER BY e.id DESC LIMIT 80`).bind(...values).all<Record<string, unknown>>()).results;
}

export async function handlePublishingAnalyticsV2(request: Request, env: PublishingAnalyticsV2Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/admin/publishing-analytics') return null;
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await Promise.all([ensurePublicationOpsSchema(env), ensurePublicationCommentGateSchema(env)]);

  const requested = Number(url.searchParams.get('days') || 30);
  const days = PERIODS.has(requested) ? requested : 30;
  const now = new Date();
  const since = days ? new Date(now.getTime() - days * DAY_MS).toISOString() : null;
  const previousSince = days ? new Date(now.getTime() - days * 2 * DAY_MS).toISOString() : null;
  const previousUntil = since;
  const chartSince = days === 0 ? new Date(now.getTime() - 180 * DAY_MS).toISOString() : since || new Date(now.getTime() - 180 * DAY_MS).toISOString();

  const [summary, previous, daily, health, releases, events] = await Promise.all([
    periodSummary(env, since, null),
    days ? periodSummary(env, previousSince, previousUntil) : Promise.resolve(null),
    dailySeries(env, chartSince),
    gateHealth(env),
    releaseMetrics(env, since, null),
    recentEvents(env, since),
  ]);

  const attention = releases.filter((item) => item.delivery_failures > 0
    || (item.file_count > 0 && (!item.discussion_ready || item.gate_status === 'failed' || item.gate_status === 'missing'))).slice(0, 24);
  const rates = {
    gate_to_open: summary.gate_clicks ? Math.round((summary.download_opens / summary.gate_clicks) * 1000) / 10 : 0,
    open_to_reader: summary.download_opens ? Math.round((summary.unique_readers / summary.download_opens) * 1000) / 10 : 0,
    reader_to_thanks: summary.unique_readers ? Math.round((summary.thanks / summary.unique_readers) * 1000) / 10 : 0,
    reader_to_support: summary.unique_readers ? Math.round((summary.support_clicks / summary.unique_readers) * 1000) / 10 : 0,
  };

  return json({
    period: { days, since, previous_since: previousSince },
    summary,
    previous,
    rates,
    gate_health: health,
    daily,
    top_releases: releases.slice(0, 15),
    attention,
    recent_events: events,
  });
}
