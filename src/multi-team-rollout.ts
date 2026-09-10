import type { D1DatabaseLike } from './ranobelib-runtime.js';

export type MultiTeamRolloutEnv = { DB: D1DatabaseLike };

export type MultiTeamRolloutState = {
  shadow: boolean;
  delivery: boolean;
  ui: boolean;
};

export type MultiTeamRolloutKey =
  | 'ranobelib_multi_team_shadow'
  | 'ranobelib_multi_team_delivery'
  | 'ranobelib_multi_team_ui';

const FLAG_KEYS: readonly MultiTeamRolloutKey[] = [
  'ranobelib_multi_team_shadow',
  'ranobelib_multi_team_delivery',
  'ranobelib_multi_team_ui',
];

const cache = new WeakMap<object, { value: MultiTeamRolloutState; expiresAt: number }>();
const CACHE_MS = 5_000;

export async function getMultiTeamRollout(
  env: MultiTeamRolloutEnv,
  options: { bypassCache?: boolean; nowMs?: number } = {},
): Promise<MultiTeamRolloutState> {
  const key = env.DB as object;
  const nowMs = options.nowMs ?? Date.now();
  const cached = cache.get(key);
  if (!options.bypassCache && cached && cached.expiresAt > nowMs) return cached.value;

  let rows: Array<{ key: string; value: string }> = [];
  try {
    const result = await env.DB.prepare(`
      SELECT key, value
      FROM app_settings
      WHERE key IN (
        'ranobelib_multi_team_shadow',
        'ranobelib_multi_team_delivery',
        'ranobelib_multi_team_ui'
      )
    `).all<{ key: string; value: string }>();
    rows = result.results;
  } catch (error) {
    // Missing migration/table during a deployment overlap must fail closed to legacy behavior.
    console.warn('Multi-team rollout flags unavailable; using legacy mode', compactError(error));
  }

  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const value: MultiTeamRolloutState = {
    shadow: flagEnabled(byKey.get('ranobelib_multi_team_shadow')),
    delivery: flagEnabled(byKey.get('ranobelib_multi_team_delivery')),
    ui: flagEnabled(byKey.get('ranobelib_multi_team_ui')),
  };
  cache.set(key, { value, expiresAt: nowMs + CACHE_MS });
  return value;
}

export async function setMultiTeamRolloutFlag(
  env: MultiTeamRolloutEnv,
  flag: MultiTeamRolloutKey,
  enabled: boolean,
): Promise<void> {
  if (!FLAG_KEYS.includes(flag)) throw new Error(`Unsupported multi-team rollout flag: ${flag}`);
  await env.DB.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(flag, enabled ? '1' : '0').run();
  cache.delete(env.DB as object);
}

export function multiTeamScannerMode(state: MultiTeamRolloutState): 'legacy' | 'shadow' | 'live' {
  if (state.delivery) return 'live';
  if (state.shadow) return 'shadow';
  return 'legacy';
}

export function invalidateMultiTeamRolloutCache(env: MultiTeamRolloutEnv): void {
  cache.delete(env.DB as object);
}

function flagEnabled(value: unknown): boolean {
  if (value === 1 || value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'on', 'enabled', 'yes'].includes(value.trim().toLowerCase());
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
