export type TelegramWebhookRoute =
  | 'chat-member'
  | 'download-start'
  | 'reader-gate'
  | 'reader-forward'
  | 'membership-appeal'
  | 'notifications'
  | 'proposal'
  | 'generic-private-text'
  | 'compat';

type TelegramWebhookUpdateLike = {
  chat_member?: unknown;
  message?: {
    chat?: { type?: string };
    text?: string;
    is_automatic_forward?: boolean;
  };
  callback_query?: {
    data?: string;
  };
};

function isCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?$`, 'i').test(text.trim());
}

function isDownloadStart(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?\s+dl_\d+\s*$/i.test(text.trim());
}

export function classifyTelegramWebhookUpdate(update: TelegramWebhookUpdateLike): TelegramWebhookRoute {
  if (update.chat_member) return 'chat-member';

  const message = update.message;
  const text = message?.text?.trim() ?? '';
  if (message?.is_automatic_forward === true) return 'reader-forward';
  if (message?.chat?.type === 'private' && isDownloadStart(text)) return 'download-start';

  const callbackData = update.callback_query?.data ?? '';
  if (callbackData.startsWith('gate-thanks:') || callbackData.startsWith('gate-download:')) return 'reader-gate';
  if (callbackData === 'membership:appeal' || callbackData.startsWith('membership:appeal:')) return 'membership-appeal';
  if (callbackData === 'prop:notifications' || callbackData.startsWith('subs:')) return 'notifications';
  if (callbackData.startsWith('prop:')) return 'proposal';

  if (message?.chat?.type === 'private') {
    if (isCommand(text, 'notifications') || isCommand(text, 'subscriptions')) return 'notifications';
    if (isCommand(text, 'start') || isCommand(text, 'propose')) return 'proposal';
    if (text && !text.startsWith('/')) return 'generic-private-text';
  }

  return 'compat';
}
