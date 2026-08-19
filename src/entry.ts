import { handleAdminUserWorkspace, type AdminUserWorkspaceEnv } from './admin-user-workspace.js';
import baseWorker from './worker';

export default {
  async fetch(request: Request, env: AdminUserWorkspaceEnv): Promise<Response> {
    const adminWorkspaceResponse = await handleAdminUserWorkspace(request, env);
    if (adminWorkspaceResponse) return adminWorkspaceResponse;
    return baseWorker.fetch(request, env as never);
  },
};
