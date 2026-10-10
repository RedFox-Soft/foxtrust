import { SQL } from "bun";
import { afterAll, beforeAll, describe } from "bun:test";
import { migrate } from "../../src/db/migrate";

export const TEST_DB_URL = Bun.env.DATABASE_URL_TEST;

/** `describe`, or `describe.skip` with a message when no test database is configured. */
export const describeDb: typeof describe = TEST_DB_URL
  ? describe
  : (((name: string, fn: () => void) => {
      console.warn(`[skip] ${name}: DATABASE_URL_TEST is not set`);
      describe.skip(name, fn);
    }) as typeof describe);

export type TestDb = { sql: SQL; url: string };

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Creates a fresh, migrated database for the calling test file and drops it afterwards.
 * Call at the top level of a `describeDb` block; read `db.sql` / `db.url` inside tests.
 */
export function withTestDb(): TestDb {
  const db = {} as TestDb;
  const name = `ft_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let admin: SQL | undefined;

  beforeAll(async () => {
    admin = new SQL(TEST_DB_URL!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db.url = withDatabase(TEST_DB_URL!, name);
    // Small pools: test files run in parallel workers against one server (max_connections 100).
    db.sql = new SQL(db.url, { max: 4 });
    await migrate(db.sql);
  });

  afterAll(async () => {
    await db.sql?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.close();
  });

  return db;
}

/** Empties every data table (between scenarios in one file) but keeps the schema. */
export async function resetData(sql: SQL): Promise<void> {
  await sql.unsafe(`TRUNCATE behavior_daily, behavior_sighting, category_interval, network_interval,
    data_version, feed_run, feed, scoring_config, alert_problem, api_usage_daily, api_key, account,
    admin_session, operator_request, admin_audit, site_session RESTART IDENTITY CASCADE`);
}
