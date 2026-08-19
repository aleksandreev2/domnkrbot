import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatement }
export interface TitleProposalAdminEnv extends WebAuthEnv { DB: D1DatabaseLike }

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export async function handleTitleProposalAdminApi(request: Request, env: TitleProposalAdminEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/admin/title-proposal-details') return null;
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const { results } = await env.DB.prepare(`
    SELECT p.id,p.title,p.source_url,p.comment,p.status,p.created_at,p.user_telegram_id,
           u.username,u.first_name,
           COALESCE(d.original_title,'') AS original_title,
           COALESCE(d.extra_url,'') AS extra_url,
           d.raw_upload_id,
           r.original_name AS raw_original_name,
           r.expected_size AS raw_size,
           r.status AS raw_status
    FROM chapter_proposals p
    JOIN users u ON u.telegram_id=p.user_telegram_id
    LEFT JOIN title_proposal_details d ON d.proposal_id=p.id
    LEFT JOIN proposal_raw_uploads r ON r.id=d.raw_upload_id
    WHERE p.proposal_type='title'
    ORDER BY p.created_at DESC
    LIMIT 220
  `).all();
  return json({ proposals: results });
}
