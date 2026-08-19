import { composeChannelPublication } from './publication-comment-gate.js';
import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }
export interface PublicationOpsPreflightEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: unknown;
}

const MAX_TITLE = 180;
const MAX_BODY = 700;
const MAX_FILES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 45 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const cleanText = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const flag = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;

async function setting(env: PublicationOpsPreflightEnv, key: string): Promise<string> {
  try { return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || ''; }
  catch { return ''; }
}

export async function handlePublicationOpsPreflight(request: Request, env: PublicationOpsPreflightEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/admin/publishing-center/preflight') return null;
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const body = await request.json().catch(() => ({})) as {
    internal_title?: unknown;
    body_html?: unknown;
    add_footer?: unknown;
    add_bot_comment?: unknown;
    file_sizes?: unknown;
    image_size?: unknown;
  };
  const title = cleanText(body.internal_title, MAX_TITLE);
  const text = cleanText(body.body_html, MAX_BODY);
  const addBotComment = flag(body.add_bot_comment) === 1;
  const fileSizes = Array.isArray(body.file_sizes) ? body.file_sizes.map(Number).filter(Number.isFinite) : [];
  const imageSize = Math.max(0, Number(body.image_size || 0));
  const total = imageSize + fileSizes.reduce((sum, value) => sum + Math.max(0, value), 0);
  const [publishChannel, discussionChat] = await Promise.all([setting(env, 'publish_channel_id'), setting(env, 'discussion_chat_id')]);
  const filesWithinLimit = fileSizes.every((size) => size >= 0 && size <= MAX_FILE_BYTES);
  const channelText = composeChannelPublication(
    { body_html: text, add_footer: flag(body.add_footer) },
    env.BOT_USERNAME || 'domnekromanta_bot',
  );
  const captionOk = !imageSize || channelText.length <= 1024;
  const needsDiscussion = fileSizes.length > 0 || addBotComment;
  const discussionReady = !needsDiscussion || Boolean(discussionChat);
  const checks = [
    { id: 'title', label: 'Название', status: title ? 'ok' : 'error', message: title ? `${title.length} / ${MAX_TITLE}` : 'Заполните название.' },
    { id: 'body', label: 'Текст', status: text ? 'ok' : 'error', message: text ? `${text.length} / ${MAX_BODY}` : 'Добавьте текст.' },
    { id: 'storage', label: 'R2', status: (fileSizes.length || imageSize) && !env.FILES ? 'error' : 'ok', message: env.FILES ? 'R2 FILES подключён.' : 'R2 FILES пока не подключён.' },
    { id: 'file_count', label: 'Вложения', status: fileSizes.length <= MAX_FILES ? 'ok' : 'error', message: `${fileSizes.length} / ${MAX_FILES}` },
    { id: 'file_size', label: 'Файл ≤ 45 МБ', status: filesWithinLimit ? 'ok' : 'error', message: filesWithinLimit ? 'Размер отдельных файлов допустим для Telegram Bot API.' : 'Есть файл больше 45 МБ.' },
    { id: 'image_size', label: 'Картинка ≤ 8 МБ', status: imageSize <= MAX_IMAGE_BYTES ? 'ok' : 'error', message: imageSize <= MAX_IMAGE_BYTES ? 'Размер изображения допустим.' : 'Изображение больше 8 МБ.' },
    { id: 'total_size', label: 'Общий размер', status: total <= MAX_TOTAL_BYTES ? 'ok' : 'error', message: `${Math.round(total / 1024 / 1024 * 10) / 10} / 80 МБ` },
    { id: 'caption', label: 'Пост в канале', status: captionOk ? 'ok' : 'error', message: captionOk ? `${channelText.length} / ${imageSize ? 1024 : 4096}; download/support CTA в канальный пост не добавляются.` : `${channelText.length} / 1024 — сократите текст для поста с изображением.` },
    { id: 'channel', label: 'Канал', status: publishChannel ? 'ok' : 'error', message: publishChannel ? 'Канал настроен.' : 'Укажите канал в настройках.' },
    { id: 'download_delivery', label: 'Скачивание', status: 'ok', message: fileSizes.length ? 'Файлы выдаются только в личке бота после нажатия CTA в комментариях.' : 'В релизе нет файлов.' },
    { id: 'discussion', label: 'Комментарии', status: discussionReady ? 'ok' : 'error', message: needsDiscussion ? (discussionChat ? 'Discussion group настроена: automatic forward получит один служебный комментарий.' : 'Настройте связанную discussion group: служебные кнопки публикуются только в комментариях.') : 'Для этой публикации служебный комментарий отключён.' },
  ];
  return json({
    ready: !checks.some((check) => check.status === 'error'),
    checks,
    deliveryMode: fileSizes.length ? 'discussion_gate_bot_private' : addBotComment ? 'discussion_support' : 'none',
    channelInlineKeyboard: false,
    supportUrlConfigured: true,
  });
}
