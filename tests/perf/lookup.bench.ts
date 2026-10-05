import { activateConfig } from "../../src/db/versions";
import { runFeed } from "../../src/ingest/run";
import { createIpTrust } from "../../src/lookup/lookup";
import { shippedConfig } from "../helpers/seed";
import { percentile, prng, tempDb, type Measurement } from "./util";

const LOOKUPS = 10_000;

/**
 * SC-001: p95 of single-address lookups with the full dataset loaded, IPv4 and IPv6.
 * With BENCH_IPTOASN=<path to the full ip2asn-combined.tsv.gz> the real network table is
 * loaded; otherwise 1 M synthetic CIDRs. Behavior and category rows are synthetic.
 */
export async function measureLookup(): Promise<Measurement[]> {
  const db = await tempDb("bench_lookup");
  try {
    await activateConfig(db.sql, await shippedConfig());
    await db.sql`INSERT INTO feed (id) VALUES ('iptoasn'), ('x4bnet-datacenter'), ('blocklist-de') ON CONFLICT DO NOTHING`;
    const [run] = await db.sql`
      INSERT INTO feed_run (feed_id, started_at, status, committed_at) VALUES ('blocklist-de', now(), 'applied', now())
      RETURNING id`;

    if (Bun.env.BENCH_IPTOASN) {
      const report = await runFeed(db.sql, "iptoasn", { fromFiles: [Bun.env.BENCH_IPTOASN] });
      console.error(`  loaded iptoasn: ${report.entryCount} CIDRs`);
    } else {
      await db.sql.unsafe(`
        INSERT INTO network_interval (prefix, asn, org, country, source, valid)
        SELECT set_masklen('1.0.0.0'::inet + (i::bigint * 256), 24)::cidr, 64512 + i % 1000, 'Synthetic', 'ZZ',
               'iptoasn', tstzrange(now() - interval '1 day', NULL)
        FROM generate_series(0, 799999) i;
        INSERT INTO network_interval (prefix, asn, org, country, source, valid)
        SELECT ('2a00:' || to_hex(i / 65536) || ':' || to_hex(i % 65536) || '::/48')::cidr, 64512 + i % 1000,
               'Synthetic', 'ZZ', 'iptoasn', tstzrange(now() - interval '1 day', NULL)
        FROM generate_series(0, 199999) i;`);
    }
    await db.sql.unsafe(`
      INSERT INTO category_interval (prefix, code, source, valid, shippable)
      SELECT set_masklen('1.0.0.0'::inet + (i::bigint * 2048), 24)::cidr, 'hosting', 'x4bnet-datacenter',
             tstzrange(now() - interval '1 day', NULL), true
      FROM generate_series(0, 99999) i;
      INSERT INTO behavior_sighting (prefix, code, source, first_seen, last_seen, recorded_at, first_run_id, last_run_id, open, shippable)
      SELECT set_masklen('1.0.0.0'::inet + (i::bigint * 509), 32)::cidr, 'ssh_bruteforce', 'blocklist-de',
             now() - interval '2 days', now() - (i % 48) * interval '1 hour', now() - interval '2 days', ${Number(run.id)}, ${Number(run.id)}, false, false
      FROM generate_series(0, 399999) i;
      INSERT INTO behavior_daily (prefix, code, source, day, count, first_seen, last_seen, shippable)
      SELECT set_masklen('1.0.0.0'::inet + (i::bigint * 1021), 32)::cidr, 'ssh_bruteforce', 'blocklist-de',
             (now() - interval '3 days')::date, 1, now() - interval '3 days', now() - interval '3 days', false
      FROM generate_series(0, 99999) i;
      ANALYZE;`);

    const client = createIpTrust({ databaseUrl: db.url });
    const random = prng(42);
    const timings: Record<4 | 6, number[]> = { 4: [], 6: [] };
    try {
      for (let i = 0; i < 200; i++) await client.lookup("1.2.3.4"); // warm-up
      for (let i = 0; i < LOOKUPS; i++) {
        const family = i % 2 === 0 ? 4 : 6;
        const ip =
          family === 4
            ? [1 + Math.floor(random() * 12), Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)].join(".")
            : `2a00:${Math.floor(random() * 4).toString(16)}:${Math.floor(random() * 65536).toString(16)}::${Math.floor(random() * 65536).toString(16)}`;
        const start = performance.now();
        const result = await client.lookup(ip);
        timings[family].push(performance.now() - start);
        if (!result.ok) throw new Error(`lookup ${ip} failed: ${result.error.message}`);
      }
    } finally {
      await client.close();
    }
    return ([4, 6] as const).map((family) => {
      const p95 = percentile(timings[family], 95);
      return {
        criterion: `SC-001 lookup p95 (IPv${family})`,
        target: "< 50 ms",
        measured: `${p95.toFixed(1)} ms (p50 ${percentile(timings[family], 50).toFixed(1)} ms, n=${timings[family].length})`,
        pass: p95 < 50,
      };
    });
  } finally {
    await db.drop();
  }
}

if (import.meta.main) console.table(await measureLookup());
