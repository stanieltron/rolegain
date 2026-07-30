import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

export const DEFAULT_DATABASE_POOL_SIZE = 5;
export const DEFAULT_SESSION_POOL_SIZE = 2;

export function createDatabasePool(
  connectionString: string,
  options: { max?: number; applicationName?: string } = {},
) {
  return new Pool({
    connectionString,
    max: options.max ?? databasePoolSize(),
    application_name: options.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl:
      process.env.ROLEGAIN_DATABASE_SSL === "disable"
        ? false
        : { rejectUnauthorized: process.env.ROLEGAIN_DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
  });
}

export function sessionPoolSize(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return positiveInteger(
    environment.ROLEGAIN_SESSION_POOL_SIZE,
    DEFAULT_SESSION_POOL_SIZE,
  );
}

export function databasePoolSize(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return positiveInteger(
    environment.ROLEGAIN_DATABASE_POOL_SIZE,
    DEFAULT_DATABASE_POOL_SIZE,
  );
}

export async function migrateDatabase(pool: Pool) {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations", "001_saas.sql"),
    "utf8",
  );
  const client = await pool.connect();
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('rolegain:schema-migrations'))",
    );
    await client.query(migration);
  } finally {
    await client
      .query(
        "select pg_advisory_unlock(hashtext('rolegain:schema-migrations'))",
      )
      .catch(() => undefined);
    client.release();
  }
}

export async function withUserLock<T>(
  pool: Pool,
  userId: string,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [userId]);
    return await work(client);
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext($1))", [userId])
      .catch(() => undefined);
    client.release();
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
