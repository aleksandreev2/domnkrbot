import { handleAdminUserWorkspace, type AdminUserWorkspaceEnv } from './admin-user-workspace.js';
import {
  captureTitleProposalSubmission,
  notifyAdminsForCreatedTitleProposal,
  type TelegramTitleProposalAdminAlertEnv,
} from './telegram-title-proposal-admin-alert.js';
import {
  handleTelegramTitleProposalCabinetWebhookRequest,
  type TelegramTitleProposalCabinetEnv,
} from './telegram-title-proposal-cabinet.js';
import {
  handleTelegramTitleProposalV2WebhookRequest,
  type TelegramTitleProposalV2Env,
} from './telegram-title-proposals-v2.js';
import {
  handleTelegramTitleProposalWebhookRequest,
  type TelegramTitleProposalEnv,
} from './telegram-title-proposals.js';
import {
  handleTelegramNotificationTextInputRequest,
  handleTelegramSubscriptionWebhookRequest,
  type TelegramSubscriptionWebhookEnv,
} from './telegram-subscription-webhook.js';
import baseWorker from './worker';

type Env = AdminUserWorkspaceEnv
  & TelegramTitleProposalV2Env
  & TelegramTitleProposalCabinetEnv
  & TelegramTitleProposalEnv
  & TelegramTitleProposalAdminAlertEnv
  & TelegramSubscriptionWebhookEnv;

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContextLike): Promise<Response> {
    const notificationTextInputResponse = await handleTelegramNotificationTextInputRequest(request, env);
    if (notificationTextInputResponse) return notificationTextInputResponse;

    const proposalV2Response = await handleTelegramTitleProposalV2WebhookRequest(request, env);
    if (proposalV2Response) return proposalV2Response;

    const proposalCabinetResponse = await handleTelegramTitleProposalCabinetWebhookRequest(request, env);
    if (proposalCabinetResponse) return proposalCabinetResponse;

    const proposalAlertContext = await captureTitleProposalSubmission(request, env).catch((error) => {
      console.error('Proposal admin alert preflight failed', error);
      return null;
    });
    const proposalResponse = await handleTelegramTitleProposalWebhookRequest(request, env);
    if (proposalResponse) {
      if (proposalAlertContext) {
        await notifyAdminsForCreatedTitleProposal(env, proposalAlertContext).catch((error) => {
          console.error('Proposal admin alert failed', error);
        });
      }
      return proposalResponse;
    }

    const subscriptionResponse = await handleTelegramSubscriptionWebhookRequest(request, env);
    if (subscriptionResponse) return subscriptionResponse;

    const adminWorkspaceResponse = await handleAdminUserWorkspace(request, env);
    if (adminWorkspaceResponse) return adminWorkspaceResponse;
    return baseWorker.fetch(request, env as never);
  },
};