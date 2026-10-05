import type { SQL } from "bun";
import type { ScoringConfig } from "../../src/model/types";
import { configSha256, loadConfig } from "../../src/scoring/config";

export const SHIPPED_CONFIG_PATH = `${import.meta.dir}/../../config/scoring/2026-09-24.1.json`;

export const shippedConfig = (): Promise<ScoringConfig> => loadConfig(SHIPPED_CONFIG_PATH);

/** Row shapes used by tests/fixtures/scenarios.json. Times are ISO strings. */
export type SeedRows = {
  versions?: { at: string }[];
  runs?: { feed: string; at: string; status?: "applied" | "unchanged" }[];
  network?: { prefix: string; asn: number | null; org: string | null; country: string | null; source?: string; from: string; to?: string | null }[];
  categories?: { prefix: string; code: string; source: string; from: string; to?: string | null; lastSeen: string; shippable?: boolean }[];
  sightings?: { prefix: string; code: string; source: string; firstSeen: string; lastSeen: string; recordedAt?: string; open?: boolean; feedTime?: boolean; confidence?: number | null; shippable?: boolean }[];
  daily?: { prefix: string; code: string; source: string; day: string; count?: number; firstSeen: string; lastSeen: string; confidence?: number | null; shippable?: boolean }[];
};

export type SeededConfig = { id: number; sha256: string };

export async function seedConfig(sql: SQL, config?: ScoringConfig): Promise<SeededConfig> {
  const body = config ?? (await shippedConfig());
  const sha = configSha256(body);
  const [existing] = await sql`SELECT id FROM scoring_config WHERE sha256 = ${sha}`;
  if (existing) return { id: Number(existing.id), sha256: sha };
  const [row] = await sql`
    INSERT INTO scoring_config (version, algorithm_version, body, sha256)
    VALUES (${body.version}, ${body.algorithm}, ${JSON.stringify(body)}::jsonb, ${sha}) RETURNING id`;
  return { id: Number(row.id), sha256: sha };
}

export async function seedDataVersion(sql: SQL, at: string, config: SeededConfig, cause = "config"): Promise<void> {
  const [{ id }] = await sql`SELECT nextval(pg_get_serial_sequence('data_version', 'id')) AS id`;
  await sql`
    INSERT INTO data_version (id, label, committed_at, scoring_config_id, cause)
    VALUES (${id}, ${`dv${id}.noisy-or/1.${config.sha256.slice(0, 8)}`}, ${at}, ${config.id}, ${cause})`;
}

async function ensureFeed(sql: SQL, feed: string): Promise<void> {
  await sql`INSERT INTO feed (id) VALUES (${feed}) ON CONFLICT (id) DO NOTHING`;
}

export async function seedFeedRun(sql: SQL, feed: string, at: string, status = "applied"): Promise<number> {
  await ensureFeed(sql, feed);
  const [row] = await sql`
    INSERT INTO feed_run (feed_id, started_at, finished_at, status, committed_at)
    VALUES (${feed}, ${at}, ${at}, ${status}, ${at}) RETURNING id`;
  return Number(row.id);
}

/**
 * Inserts all rows of a scenario. A successful feed run is created at every firstSeen / lastSeen
 * a category or sighting row mentions (unless listed in `runs`), because lookups derive past
 * lastSeen values from feed runs.
 */
export async function seedRows(sql: SQL, rows: SeedRows, config?: ScoringConfig): Promise<void> {
  const seeded = await seedConfig(sql, config);
  for (const v of rows.versions ?? []) await seedDataVersion(sql, v.at, seeded);

  const runIds = new Map<string, number>();
  const runFor = async (feed: string, at: string, status = "applied") => {
    const key = `${feed}@${new Date(at).toISOString()}`;
    const known = runIds.get(key);
    if (known !== undefined) return known;
    const id = await seedFeedRun(sql, feed, at, status);
    runIds.set(key, id);
    return id;
  };
  for (const r of rows.runs ?? []) await runFor(r.feed, r.at, r.status);

  for (const n of rows.network ?? []) {
    await sql`
      INSERT INTO network_interval (prefix, asn, org, country, source, valid)
      VALUES (${n.prefix}::cidr, ${n.asn}, ${n.org}, ${n.country}, ${n.source ?? "iptoasn"},
              tstzrange(${n.from}::timestamptz, ${n.to ?? null}::timestamptz, '[)'))`;
  }
  for (const c of rows.categories ?? []) {
    const run = await runFor(c.source, c.from);
    await runFor(c.source, c.lastSeen);
    await sql`
      INSERT INTO category_interval (prefix, code, source, valid, last_seen, opened_run_id, shippable)
      VALUES (${c.prefix}::cidr, ${c.code}, ${c.source},
              tstzrange(${c.from}::timestamptz, ${c.to ?? null}::timestamptz, '[)'),
              ${c.to ? c.lastSeen : null}, ${run}, ${c.shippable ?? true})`;
  }
  for (const s of rows.sightings ?? []) {
    const run = await runFor(s.source, s.recordedAt ?? s.firstSeen);
    await runFor(s.source, s.lastSeen);
    await sql`
      INSERT INTO behavior_sighting (prefix, code, source, first_seen, last_seen, recorded_at, sightings,
                                     first_run_id, last_run_id, open, feed_time, confidence, shippable)
      VALUES (${s.prefix}::cidr, ${s.code}, ${s.source}, ${s.firstSeen}, ${s.lastSeen},
              ${s.recordedAt ?? s.firstSeen}, 1, ${run}, ${run}, ${s.open ?? false}, ${s.feedTime ?? false},
              ${s.confidence ?? null}, ${s.shippable ?? true})`;
  }
  for (const d of rows.daily ?? []) {
    await sql`
      INSERT INTO behavior_daily (prefix, code, source, day, count, first_seen, last_seen, confidence, shippable)
      VALUES (${d.prefix}::cidr, ${d.code}, ${d.source}, ${d.day}, ${d.count ?? 1},
              ${d.firstSeen}, ${d.lastSeen}, ${d.confidence ?? null}, ${d.shippable ?? true})`;
  }
}
