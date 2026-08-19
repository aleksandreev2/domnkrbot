import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }
export interface PublicationArchiveEnv extends WebAuthEnv { DB: D1DatabaseLike }

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export async function handlePublicationArchiveGuard(request: Request, env: PublicationArchiveEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const deleteMatch = request.method === 'DELETE' ? /^\/api\/admin\/publications\/(\d+)$/.exec(url.pathname) : null;
  const publishMatch = request.method === 'POST' ? /^\/api\/admin\/publications\/(\d+)\/publish$/.exec(url.pathname) : null;
  const id = Number(deleteMatch?.[1] || publishMatch?.[1] || 0);
  if (!id) return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const publication = await env.DB.prepare('SELECT status FROM publications WHERE id=?').bind(id).first<{ status: string }>();
  if (!publication || publication.status !== 'deleted') return null;

  return json({
    error: 'Публикация удалена из Telegram и сохранена как архив. Для повторной отправки создайте новый черновик.',
    status: 'deleted',
  }, 409);
}
