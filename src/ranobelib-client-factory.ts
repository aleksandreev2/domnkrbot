import { RanobeLibClient, type RanobeLibClientOptions } from './integrations/ranobelib/client.js';
import { RanobeLibAuthProvider, type RanobeLibAuthEnv } from './ranobelib-auth.js';

export type RanobeLibClientFactoryEnv = RanobeLibAuthEnv;

const TRANSIENT_READ_STATUSES = new Set([500, 502, 503, 504]);

function withTransientReadRetry(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || !TRANSIENT_READ_STATUSES.has(response.status)) return response;
    return fetchImpl(input, init);
  };
}

export function createRanobeLibClient(
  env: RanobeLibClientFactoryEnv,
  options: Omit<RanobeLibClientOptions, 'authProvider'> = {},
): RanobeLibClient {
  const dedicatedEncryptionConfigured = Boolean(env.RANOBELIB_TOKEN_ENCRYPTION_KEY?.trim());
  const authProvider = dedicatedEncryptionConfigured
    ? new RanobeLibAuthProvider(env, { fetchImpl: options.fetchImpl })
    : undefined;
  const baseFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const fetchImpl = withTransientReadRetry(baseFetch);
  return new RanobeLibClient({ ...options, fetchImpl, authProvider });
}
