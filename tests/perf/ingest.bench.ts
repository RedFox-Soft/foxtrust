import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { FEEDS } from "../../src/feeds/registry";
import { runFeed } from "../../src/ingest/run";
import { shippedConfig } from "../helpers/seed";
import { tempDb, type Measurement } from "./util";

/**
 * SC-004: a full ingestion of all feeds into empty storage (< 30 min) and a routine refresh
 * (< 5 min). With BENCH_FEED_DIR=<dir> the feeds are read from <dir>/<feed>/<file name>
 * (full-size copies, so publishers are not hit repeatedly); otherwise they are downloaded.
 */
export async function measureIngest(): Promise<Measurement[]> {
  const db = await tempDb("bench_ingest");
  const dir = Bun.env.BENCH_FEED_DIR;
  const optsFor = (id: string) => {
    const def = FEEDS.find((f) => f.id === id)!;
    return dir ? { fromFiles: def.files.map((f) => join(dir, id, f.name)) } : {};
  };
  const ingestAll = async () => {
    const start = performance.now();
    for (const def of FEEDS) {
      const report = await runFeed(db.sql, def.id, optsFor(def.id));
      console.error(`  ${def.id}: ${report.status}, ${report.entryCount} entries${report.error ? `, ${report.error}` : ""}`);
      if (report.status !== "applied" && report.status !== "unchanged") throw new Error(`${def.id}: ${report.status}`);
    }
    return performance.now() - start;
  };
  try {
    await activateConfig(db.sql, await shippedConfig());
    const full = await ingestAll();
    const refresh = await ingestAll();
    const source = dir ? "local full-size files" : "live download";
    return [
      { criterion: `SC-004 full ingest (${source})`, target: "< 30 min", measured: `${(full / 1000).toFixed(1)} s`, pass: full < 30 * 60_000 },
      { criterion: `SC-004 routine refresh (${source})`, target: "< 5 min", measured: `${(refresh / 1000).toFixed(1)} s`, pass: refresh < 5 * 60_000 },
    ];
  } finally {
    await db.drop();
  }
}

if (import.meta.main) console.table(await measureIngest());
