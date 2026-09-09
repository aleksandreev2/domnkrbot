type D1LikeStatement = {
  bind(...values: unknown[]): D1LikeStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

type D1LikeDatabase = {
  prepare(query: string): D1LikeStatement;
};

type EnvWithDb = {
  DB: D1LikeDatabase;
};

const trustedDbByBinding = new WeakMap<object, D1LikeDatabase>();

export function withTrustedTelegramMigrations<T extends EnvWithDb>(env: T): T {
  const originalDb = env.DB;
  const key = originalDb as unknown as object;
  let trustedDb = trustedDbByBinding.get(key);
  if (!trustedDb) {
    trustedDb = new Proxy(originalDb, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (query: string) => isMigrationDdl(query)
          ? noOpStatement()
          : target.prepare(query);
      },
    });
    trustedDbByBinding.set(key, trustedDb);
  }

  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return trustedDb;
      return Reflect.get(target, property, receiver);
    },
  });
}

function isMigrationDdl(query: string): boolean {
  const normalized = String(query ?? '').trim().replace(/^--[^\n]*(?:\n|$)/g, '').trimStart();
  return /^(?:CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)|ALTER\s+TABLE)\b/i.test(normalized);
}

function noOpStatement(): D1LikeStatement {
  const statement: D1LikeStatement = {
    bind() { return statement; },
    async run() { return { success: true, meta: { changes: 0 } }; },
    async first<T>() { return null as T | null; },
    async all<T>() { return { results: [] as T[] }; },
  };
  return statement;
}
