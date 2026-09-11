import type { D1DatabaseLike } from './ranobelib-runtime.js';

export interface RanobeLibAuthEnv {
  DB: D1DatabaseLike;
  RANOBELIB_TOKEN_ENCRYPTION_KEY?: string;
}

export interface RanobeLibTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface RanobeLibAuthHealth {
  state: 'missing' | 'active' | 'expired' | 'invalid' | 'unavailable';
  accessExpiresAt: string | null;
  lastValidatedAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

type CredentialRow = {
  ciphertext: string;
  iv: string;
  key_version: number | string;
  access_expires_at: string;
  state: 'active' | 'expired' | 'invalid';
  last_validated_at: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  updated_at: string | null;
};

type ProviderOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type StoreMetadata = {
  validatedAt?: string | null;
  refreshedAt?: string | null;
};

const API_ORIGIN = 'https://api.cdnlibs.org';
const ADDITIONAL_DATA = 'domnkrbot:ranobelib-auth:v1';
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class RanobeLibAuthProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly env: RanobeLibAuthEnv, options: ProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  async store(bundle: RanobeLibTokenBundle, metadata: StoreMetadata = {}): Promise<void> {
    const normalized = normalizeBundle(bundle);
    const key = await this.encryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(normalized));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(ADDITIONAL_DATA) },
      key,
      plaintext,
    );
    const state = Date.parse(normalized.expiresAt) <= this.now().getTime() ? 'expired' : 'active';
    await this.env.DB.prepare(`
      INSERT INTO ranobelib_auth_credentials (
        singleton_id, ciphertext, iv, key_version, access_expires_at, state,
        last_validated_at, last_refreshed_at, last_error, updated_at
      ) VALUES (1, ?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(singleton_id) DO UPDATE SET
        ciphertext=excluded.ciphertext, iv=excluded.iv, key_version=excluded.key_version,
        access_expires_at=excluded.access_expires_at, state=excluded.state,
        last_validated_at=excluded.last_validated_at,
        last_refreshed_at=excluded.last_refreshed_at,
        last_error=excluded.last_error, updated_at=CURRENT_TIMESTAMP
    `).bind(
      base64Encode(new Uint8Array(ciphertext)),
      base64Encode(iv),
      normalized.expiresAt,
      state,
      metadata.validatedAt ?? null,
      metadata.refreshedAt ?? null,
      null,
    ).run();
  }

  async load(): Promise<RanobeLibTokenBundle | null> {
    const row = await this.readRow();
    if (!row) return null;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: byteBuffer(base64Decode(row.iv)), additionalData: encoder.encode(ADDITIONAL_DATA) },
        await this.encryptionKey(),
        byteBuffer(base64Decode(row.ciphertext)),
      );
      return normalizeBundle(JSON.parse(decoder.decode(plaintext)) as RanobeLibTokenBundle);
    } catch {
      throw new Error('Unable to decrypt RanobeLib credentials');
    }
  }

  async validateAndStore(bundle: RanobeLibTokenBundle): Promise<void> {
    const normalized = normalizeBundle(bundle);
    const response = await this.fetchImpl(`${API_ORIGIN}/api/auth/me`, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json', Authorization: `Bearer ${normalized.accessToken}` },
    });
    if (!response.ok) throw new Error(`RanobeLib validation failed: ${response.status}`);
    const body = await response.json().catch(() => null) as { data?: { id?: unknown } } | null;
    if (!body?.data || body.data.id == null) throw new Error('RanobeLib validation returned no account');
    await this.store(normalized, { validatedAt: this.now().toISOString() });
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    const row = await this.readRow();
    if (!row) return null;
    if (row.state === 'invalid') throw new Error('RanobeLib authorization is invalid');
    const bundle = await this.load();
    if (!bundle) return null;
    const refreshDue = Date.parse(bundle.expiresAt) <= this.now().getTime() + REFRESH_SKEW_MS;
    if (!options.forceRefresh && !refreshDue) return bundle.accessToken;
    return this.refresh(bundle, row);
  }

  async health(): Promise<RanobeLibAuthHealth> {
    const row = await this.readRow();
    if (!row) return emptyHealth('missing');
    const configured = Boolean(this.env.RANOBELIB_TOKEN_ENCRYPTION_KEY?.trim());
    const timeState = Date.parse(row.access_expires_at) <= this.now().getTime() ? 'expired' : row.state;
    return {
      state: configured ? timeState : 'unavailable',
      accessExpiresAt: row.access_expires_at,
      lastValidatedAt: row.last_validated_at,
      lastRefreshedAt: row.last_refreshed_at,
      lastError: sanitizeError(row.last_error),
      updatedAt: row.updated_at,
    };
  }

  async remove(): Promise<void> {
    await this.env.DB.prepare('DELETE FROM ranobelib_auth_credentials WHERE singleton_id = 1').run();
  }

  private async refresh(bundle: RanobeLibTokenBundle, row: CredentialRow): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh(bundle, row).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async performRefresh(bundle: RanobeLibTokenBundle, row: CredentialRow): Promise<string> {
    const response = await this.fetchImpl(`${API_ORIGIN}/api/auth/oauth/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token', client_id: '1', refresh_token: bundle.refreshToken, scope: '',
      }),
    });
    if (!response.ok) {
      const state = response.status === 400 || response.status === 401 ? 'invalid' : row.state;
      const message = `RanobeLib refresh failed: ${response.status}`;
      await this.recordFailure(state, message);
      throw new Error(message);
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const accessToken = stringValue(body?.access_token);
    const refreshToken = stringValue(body?.refresh_token);
    const expiresIn = Number(body?.expires_in);
    if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      const message = 'RanobeLib refresh returned an invalid token bundle';
      await this.recordFailure(row.state, message);
      throw new Error(message);
    }
    const refreshedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + expiresIn * 1000).toISOString();
    await this.store(
      { accessToken, refreshToken, expiresAt },
      { validatedAt: row.last_validated_at, refreshedAt },
    );
    return accessToken;
  }

  private async recordFailure(state: CredentialRow['state'], message: string): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE ranobelib_auth_credentials
      SET state = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).bind(state, sanitizeError(message)).run();
  }

  private readRow(): Promise<CredentialRow | null> {
    return this.env.DB.prepare(`
      SELECT ciphertext, iv, key_version, access_expires_at, state,
        last_validated_at, last_refreshed_at, last_error, updated_at
      FROM ranobelib_auth_credentials WHERE singleton_id = 1
    `).first<CredentialRow>();
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const secret = this.env.RANOBELIB_TOKEN_ENCRYPTION_KEY?.trim();
    if (!secret) throw new Error('RanobeLib token encryption key is not configured');
    const material = await crypto.subtle.digest(
      'SHA-256', encoder.encode(`domnkrbot:ranobelib-auth:key:v1\n${secret}`),
    );
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
}

function normalizeBundle(bundle: RanobeLibTokenBundle): RanobeLibTokenBundle {
  const accessToken = stringValue(bundle?.accessToken);
  const refreshToken = stringValue(bundle?.refreshToken);
  const expiresAtMs = Date.parse(stringValue(bundle?.expiresAt));
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAtMs)) {
    throw new Error('Invalid RanobeLib token bundle');
  }
  return { accessToken, refreshToken, expiresAt: new Date(expiresAtMs).toISOString() };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeError(value: unknown): string | null {
  const text = stringValue(value);
  return text ? text.slice(0, 240) : null;
}

function emptyHealth(state: 'missing' | 'unavailable'): RanobeLibAuthHealth {
  return {
    state, accessExpiresAt: null, lastValidatedAt: null,
    lastRefreshedAt: null, lastError: null, updatedAt: null,
  };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function byteBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
