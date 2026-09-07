import { handleAdminUserWorkspace, type AdminUserWorkspaceEnv } from './admin-user-workspace.js';
import {
  handleTelegramTitleProposalWebhookRequest,
  type TelegramTitleProposalEnv,
} from './telegram-title-proposals.js';
import {
  handleTelegramSubscriptionWebhookRequest,
  type TelegramSubscriptionWebhookEnv,
} from './telegram-subscription-webhook.js';
import baseWorker from './worker';

type Env = AdminUserWorkspaceEnv & TelegramTitleProposalEnv & TelegramSubscriptionWebhookEnv;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proposalResponse = await handleTelegramTitleProposalWebhookRequest(request, env);
    if (proposalResponse) return proposalResponse;

    const subscriptionResponse = await handleTelegramSubscriptionWebhookRequest(request, env);
    if (subscriptionResponse) return subscriptionResponse;

    const adminWorkspaceResponse = await handleAdminUserWorkspace(request, env);
    if (adminWorkspaceResponse) return adminWorkspaceResponse;
    return baseWorker.fetch(request, env as never);
  },
};
