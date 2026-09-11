import { RanobeLibClient, type RanobeLibClientOptions } from './integrations/ranobelib/client.js';
import { RanobeLibAuthProvider, type RanobeLibAuthEnv } from './ranobelib-auth.js';

export type RanobeLibClientFactoryEnv = RanobeLibAuthEnv;

export function createRanobeLibClient(
  env: RanobeLibClientFactoryEnv,
  options: Omit<RanobeLibClientOptions, 'authProvider'> = {},
): RanobeLibClient {
  const secretConfigured = Boolean(env.RANOBELIB_TOKEN_ENCRYPTION_KEY?.trim());
  const authProvider = secretConfigured
    ? new RanobeLibAuthProvider(env, { fetchImpl: options.fetchImpl })
    : undefined;
  return new RanobeLibClient({ ...options, authProvider });
}
