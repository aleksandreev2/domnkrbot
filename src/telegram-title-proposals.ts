export interface TelegramTitleProposalEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export async function handleTelegramTitleProposalWebhookRequest(
  request: Request,
  _env: TelegramTitleProposalEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;
  return null;
}
