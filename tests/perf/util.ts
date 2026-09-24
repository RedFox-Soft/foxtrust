import { SQL } from "bun";
import { migrate } from "../../src/db/migrate";

export type TempDb = { sql: SQL; url: string; drop: () => Promise<void> };

/** A fresh, migrated database under DATABASE_URL_TEST (measurements only). */
export async function tempDb(label: string): Promise<TempDb> {
  const base = Bun.env.DATABASE_URL_TEST;
  if (!base) throw new Error("DATABASE_URL_TEST is not set");
  const name = `ft_${label}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const admin = new SQL(base);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const sql = new SQL(url.toString());
  await migrate(sql);
  return {
    sql,
    url: url.toString(),
    drop: async () => {
      await sql.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Deterministic PRNG (mulberry32), so samples are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Measurement = { criterion: string; target: string; measured: string; pass: boolean };
