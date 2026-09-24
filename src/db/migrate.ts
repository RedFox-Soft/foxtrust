import { join } from "node:path";
import type { Db } from "./client";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "db", "migrations");

/** Applies db/migrations/*.sql in filename order, once each. Returns the names applied now. */
export async function migrate(sql: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const rows: { name: string }[] = await sql`SELECT name FROM schema_migration`;
  const done = new Set(rows.map((r) => r.name));
  const files = (await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: dir }))).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = await Bun.file(join(dir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migration (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
