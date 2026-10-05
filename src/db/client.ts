import { SQL } from "bun";

export type Db = SQL;

export function openDb(url: string | undefined = Bun.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new SQL(url);
}

/**
 * Runs `fn` in one read-only REPEATABLE READ transaction, so every query sees the same
 * committed state (FR-021: a verdict never mixes two data versions).
 */
export function readSnapshot<T>(sql: Db, fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin("isolation level repeatable read read only", fn);
}
