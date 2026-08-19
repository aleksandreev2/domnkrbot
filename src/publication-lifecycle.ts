import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

export interface PublicationLifecycleEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type PublicationRow = {
  id: number;
  status: string;
  body_html: string;
  add_footer: number;
  image_key: string | null;
  channel_message_id: number | null;
};

type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string; error_code?: number };

class TelegramApiError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const MAX_BODY = 700;
const FILES_LINE = '📎 Файлы находятся в комментариях.';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function normalizeChatId(value: string): string | number {
  const raw = value.trim();
  if (/^-?\d+$/.test(raw)) {
    const number = Number(raw);
    if (Number.isSafeInteger(number)) return number;
  }
  return raw.startsWith('@') ? raw : `@${raw}`;
}

async function setting(env: PublicationLifecycleEnv, key: string): Promise<string> {
  try {
    return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || '';
  } catch {
    return '';
  }
}

async function telegramCall<T>(env: PublicationLifecycleEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) {
    throw new TelegramApiError(Number(body?.error_code || response.status), body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return body.result as T;
}

async function getPublication(env: PublicationLifecycleEnv, id: number): Promise<PublicationRow | null> {
  return env.DB.prepare(`
    SELECT id,status,body_html,add_footer,image_key,channel_message_id
    FROM publications WHERE id=?
  `).bind(id).first<PublicationRow>();
}

async function managedPost(env: PublicationLifecycleEnv, publication: PublicationRow, body: string): Promise<string> {
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM publication_assets WHERE publication_id=?')
    .bind(publication.id).first<{ count: number | string }>();
  const parts = [body.trim()];
  if (Number(count?.count || 0) > 0) parts.push(FILES_LINE);
  if (publication.add_footer) {
    const bot = (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
    parts.push(`Дом Некроманта · переводы сообщества\nhttps://t.me/${bot}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

async function log(env: PublicationLifecycleEnv, publicationId: number, level: string, event: string, message: string, details?: unknown): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO publication_logs (publication_id,level,event,message,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(publicationId, level, event, message, details ? JSON.stringify(details).slice(0, 1600) : null).run().catch(() => undefined);
}

function alreadyGone(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.code !== 400) return false;
  const text = error.message.toLowerCase();
  return text.includes('message to delete not found') || text.includes('message not found');
}

export async function handlePublicationLifecycleApi(request: Request, env: PublicationLifecycleEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/admin\/publications\/(\d+)\/(edit|delete-telegram)$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const id = Number(match[1]);
  const action = match[2];
  const publication = await getPublication(env, id);
  if (!publication) return json({ error: 'Публикация не найдена.' }, 404);

  if (action === 'edit') {
    const input = await request.json().catch(() => null) as { body?: unknown } | null;
    const body = typeof input?.body === 'string' ? input.body.trim() : '';
    if (!body || body.length > MAX_BODY) return json({ error: `Текст должен содержать от 1 до ${MAX_BODY} символов.` }, 400);

    const composed = await managedPost(env, publication, body);
    if (publication.image_key && composed.length > 1024) {
      return json({ error: `После служебных строк caption занимает ${composed.length} / 1024 символов.` }, 400);
    }

    if (publication.status === 'published') {
      const channel = await setting(env, 'publish_channel_id');
      if (!channel || !publication.channel_message_id) return json({ error: 'У опубликованного поста нет канала или Telegram message ID.' }, 409);
      try {
        if (publication.image_key) {
          await telegramCall(env, 'editMessageCaption', {
            chat_id: normalizeChatId(channel),
            message_id: publication.channel_message_id,
            caption: composed,
          });
        } else {
          await telegramCall(env, 'editMessageText', {
            chat_id: normalizeChatId(channel),
            message_id: publication.channel_message_id,
            text: composed,
            link_preview_options: { is_disabled: true },
          });
        }
      } catch (error) {
        await log(env, id, 'error', 'post_edit_failed', 'Telegram не обновил опубликованный пост; текст в D1 не изменён.', String(error));
        return json({ error: error instanceof Error ? error.message : 'Telegram не обновил пост.' }, 502);
      }
    }

    await env.DB.prepare('UPDATE publications SET body_html=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(body, id).run();
    await log(env, id, 'success', 'post_edited', 'Текст публикации обновлён.', { adminUserId: admin.id, bodyLength: body.length });
    return json({ ok: true, id, body_html: body });
  }

  if (publication.status === 'deleted') return json({ ok: true, id, alreadyDeleted: true });
  if (publication.status !== 'published' || !publication.channel_message_id) {
    return json({ error: 'Удалить из Telegram можно только опубликованный пост.' }, 409);
  }
  const channel = await setting(env, 'publish_channel_id');
  if (!channel) return json({ error: 'Канал публикации не настроен.' }, 409);

  let reconciled = false;
  try {
    await telegramCall(env, 'deleteMessage', {
      chat_id: normalizeChatId(channel),
      message_id: publication.channel_message_id,
    });
  } catch (error) {
    if (!alreadyGone(error)) {
      await log(env, id, 'error', 'post_delete_failed', 'Telegram не смог удалить опубликованный пост.', String(error));
      return json({ error: error instanceof Error ? error.message : 'Telegram не удалил пост.' }, 502);
    }
    reconciled = true;
  }

  await env.DB.prepare("UPDATE publications SET status='deleted',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  await log(env, id, reconciled ? 'info' : 'success', reconciled ? 'post_delete_reconciled' : 'post_deleted', reconciled ? 'Пост уже отсутствовал в Telegram; запись приведена в согласованное состояние.' : 'Пост удалён из Telegram; запись и файлы сохранены.', { adminUserId: admin.id });
  return json({ ok: true, id, status: 'deleted', alreadyMissing: reconciled });
}
