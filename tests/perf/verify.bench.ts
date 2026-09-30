import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatIp } from "../../src/ip/parse";
import { buildAndRelease } from "../../src/snapshot/publish";
import { deserializeRanges } from "../../src/snapshot/ranges";
import { loadSigningKey } from "../../src/snapshot/sign";
import { createTestPublication } from "../helpers/publication";
import { LOOPBACK, startTestVerify } from "../helpers/verify";
import { dataLabel, loadStage2Data, sampleAddresses } from "./stage2-data";
import { percentile, prng, tempDb, type Measurement } from "./util";

const LOOKUPS = 100_000;
const REQUESTS = 20_000;

/**
 * SC-004: in-memory snapshot lookups, p99 < 1 ms over 100 k lookups.
 * SC-005: `/verify` answers, p99 < 5 ms over 20 k requests on a keep-alive HTTP connection.
 */
export async function measureVerify(): Promise<Measurement[]> {
  const db = await tempDb("bench_verify");
  const dir = await mkdtemp(join(tmpdir(), "foxtrust-verify-bench-"));
  const pub = await createTestPublication();
  try {
    await loadStage2Data(db.sql, join(dir, "artifacts"));
    const release = await buildAndRelease(db.sql, "full", {
      dir: pub.dir, workDir: join(dir, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 200,
    });
    if (release.status !== "published") throw new Error(`release: ${JSON.stringify(release)}`);
    const ranges = deserializeRanges(await Bun.file(join(dir, "work", `${release.version}.ranges.gz`)).bytes());
    const addresses = sampleAddresses(ranges, LOOKUPS, prng(2));

    const verify = await startTestVerify({ pub, trustedProxies: LOOPBACK });
    try {
      const source = verify.loader.source();
      if (!source.snapshotVersion) throw new Error(`snapshot did not load: ${verify.loader.status().lastError}`);
      for (let i = 0; i < 2000; i++) source.lookup(addresses[i]!); // warm-up
      const lookupMs: number[] = [];
      for (const ip of addresses) {
        const t = performance.now();
        source.lookup(ip);
        lookupMs.push(performance.now() - t);
      }

      const clients = addresses.slice(0, REQUESTS).map(formatIp);
      for (let i = 0; i < 500; i++) await fetch(`${verify.url}/verify`, { headers: { "X-Forwarded-For": clients[i]! } });
      const requestMs: number[] = [];
      for (const client of clients) {
        const t = performance.now();
        const res = await fetch(`${verify.url}/verify?proxy=nginx`, {
          headers: { "X-Forwarded-For": client, "X-Forwarded-Uri": "/login", Connection: "keep-alive" },
          redirect: "manual",
        });
        await res.arrayBuffer();
        requestMs.push(performance.now() - t);
      }
      const p99Lookup = percentile(lookupMs, 99);
      const p99Request = percentile(requestMs, 99);
      return [
        {
          criterion: `002 SC-004 in-memory lookup p99 (${dataLabel()})`,
          target: "< 1 ms",
          measured: `${(p99Lookup * 1000).toFixed(1)} µs (p50 ${(percentile(lookupMs, 50) * 1000).toFixed(1)} µs, ${LOOKUPS} lookups)`,
          pass: p99Lookup < 1,
        },
        {
          criterion: `002 SC-005 /verify p99 (${dataLabel()})`,
          target: "< 5 ms",
          measured: `${p99Request.toFixed(2)} ms (p50 ${percentile(requestMs, 50).toFixed(2)} ms, ${REQUESTS} requests)`,
          pass: p99Request < 5,
        },
      ];
    } finally {
      await verify.stop();
    }
  } finally {
    await pub.stop();
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  }
}

if (import.meta.main) console.table(await measureVerify());
