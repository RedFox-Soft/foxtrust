import type { SQL } from "bun";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { FEEDS } from "../../src/feeds/registry";
import { runFeed } from "../../src/ingest/run";
import { loadConfig } from "../../src/scoring/config";
import { FIXTURE_FILES, fixturePath, STAGE2_CONFIG } from "../helpers/fixture-data";

/**
 * The dataset for stage 2 measurements: with BENCH_FEED_DIR=<dir>, full-size copies from
 * <dir>/<feed>/<file name> (so publishers are not hit repeatedly); otherwise the recorded
 * fixtures, which are much smaller.
 */
export const benchFeedDir = () => Bun.env.BENCH_FEED_DIR?.trim() || null;
export const dataLabel = () => (benchFeedDir() ? "full-size feeds" : "fixture data");

export function feedFiles(id: string, dir = benchFeedDir()): string[] {
  const def = FEEDS.find((f) => f.id === id)!;
  return dir ? def.files.map((f) => join(dir, id, f.name)) : FIXTURE_FILES[id]!.map((n) => fixturePath(id, n));
}

export async function loadStage2Data(sql: SQL, artifactRoot: string): Promise<void> {
  await activateConfig(sql, await loadConfig(STAGE2_CONFIG));
  // The stage 2 dataset: the feeds with fixtures (the cloud feed of spec 005 has its own fixture loader).
  for (const def of FEEDS.filter((f) => FIXTURE_FILES[f.id])) {
    const report = await runFeed(sql, def.id, { fromFiles: feedFiles(def.id), artifactRoot });
    console.error(`  ${def.id}: ${report.status}, ${report.entryCount} entries${report.error ? `, ${report.error}` : ""}`);
    if (report.status !== "applied" && report.status !== "unchanged") throw new Error(`${def.id}: ${report.status}`);
  }
}

/** Random addresses inside the given ranges (half of them) and anywhere (the other half). */
export function sampleAddresses(
  ranges: { family: 4 | 6; start: bigint; end: bigint }[],
  count: number,
  random: () => number,
): { family: 4 | 6; value: bigint }[] {
  const out: { family: 4 | 6; value: bigint }[] = [];
  const big = (bits: number) => {
    let v = 0n;
    for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(Math.floor(random() * 65536));
    return v & ((1n << BigInt(bits)) - 1n);
  };
  for (let i = 0; i < count; i++) {
    const family: 4 | 6 = i % 2 === 0 ? 4 : 6;
    const inFamily = ranges.filter((r) => r.family === family);
    if (i % 4 < 2 && inFamily.length > 0) {
      const r = inFamily[Math.floor(random() * inFamily.length)]!;
      out.push({ family, value: r.start + (big(64) % (r.end - r.start + 1n)) });
    } else {
      // Anywhere; IPv6 in 2000::/3, where the routed space is.
      out.push({ family, value: family === 4 ? big(32) : (0x2n << 124n) | big(125) >> 1n });
    }
  }
  return out;
}
