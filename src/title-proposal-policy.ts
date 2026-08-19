const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function titleProposalRawError(body: unknown): string | null {
  if (!isRecord(body) || body.proposalType !== 'title') return null;
  const rawUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
  if (!rawUrl) return 'Для нового тайтла обязательна ссылка на RAW.';
  return null;
}

export async function handleTitleProposalPolicy(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/proposals') return null;
  const body = await request.clone().json().catch(() => null) as unknown;
  const error = titleProposalRawError(body);
  return error ? json({ error }, 400) : null;
}
