import { RanobeLibClient } from './integrations/ranobelib/client.js';
import {
  getRanobeLibHome,
  syncRanobeLib,
  type RanobeLibRuntimeEnv,
} from './ranobelib-runtime.js';

const CATALOG_URL = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';
const TEAM_REF = '11969--dom-nekromanta';

type Probe = {
  ok: boolean;
  status?: number;
  count?: number;
  error?: string;
  stack?: string;
  value?: unknown;
};

function failed(error: unknown): Probe {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

export async function runRanobeLibDiagnostic(env: RanobeLibRuntimeEnv): Promise<Record<string, Probe>> {
  const result: Record<string, Probe> = {};

  try {
    const response = await fetch(CATALOG_URL, {
      headers: { accept: 'application/json', 'Site-Id': '3' },
    });
    const body = await response.clone().json().catch(() => null) as { data?: unknown[] } | null;
    result.directLexicalFetch = {
      ok: response.ok,
      status: response.status,
      count: Array.isArray(body?.data) ? body.data.length : undefined,
    };
  } catch (error) {
    result.directLexicalFetch = failed(error);
  }

  try {
    const client = new RanobeLibClient();
    const books = await client.discoverTeamBooks(TEAM_REF);
    result.clientDefaultFetch = { ok: true, count: books.length };
  } catch (error) {
    result.clientDefaultFetch = failed(error);
  }

  try {
    const client = new RanobeLibClient({
      fetchImpl: (input, init) => fetch(input, init),
    });
    const books = await client.discoverTeamBooks(TEAM_REF);
    result.clientExplicitArrowFetch = { ok: true, count: books.length };
  } catch (error) {
    result.clientExplicitArrowFetch = failed(error);
  }

  try {
    const home = await getRanobeLibHome(env);
    result.d1Before = { ok: true, value: { stats: home.stats, sync: home.sync } };
  } catch (error) {
    result.d1Before = failed(error);
  }

  try {
    const sync = await syncRanobeLib(env);
    result.runtimeSync = { ok: true, value: sync };
  } catch (error) {
    result.runtimeSync = failed(error);
  }

  try {
    const home = await getRanobeLibHome(env);
    result.d1After = { ok: true, value: { stats: home.stats, sync: home.sync } };
  } catch (error) {
    result.d1After = failed(error);
  }

  return result;
}
