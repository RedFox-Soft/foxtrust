import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatIp } from "../../src/ip/parse";
import { buildAndRelease } from "../../src/snapshot/publish";
import { deserializeRanges } from "../../src/snapshot/ranges";
import { loadSigningKey } from "../../src/snapshot/sign";
import { bearer, issueTestKey, startTestApi, type TestApi } from "../helpers/api";
import { createTestPublication } from "../helpers/publication";
import { dataLabel, loadStage2Data, sampleAddresses } from "./stage2-data";
import { percentile, prng, tempDb, type Measurement } from "./util";

const RATE = 200;
const SECONDS = 15;

/** The API on a release built from the stage 2 data, with one key; `fn` gets it and sample addresses. */
export async function withStage2Api<T>(
  count: number,
  fn: (ctx: { api: TestApi; key: string; addresses: string[]; snapshotPath: string }) => Promise<T>,
): Promise<T> {
  const db = await tempDb("bench_api");
  const dir = await mkdtemp(join(tmpdir(), "foxtrust-api-bench-"));
  const pub = await createTestPublication();
  try {
    await loadStage2Data(db.sql, join(dir, "artifacts"));
    const release = await buildAndRelease(db.sql, "full", {
      dir: pub.dir, workDir: join(dir, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 200,
    });
    if (release.status !== "published") throw new Error(`release: ${JSON.stringify(release)}`);
    const ranges = deserializeRanges(await Bun.file(join(dir, "work", `${release.version}.ranges.gz`)).bytes());
    const addresses = sampleAddresses(ranges, count, prng(3)).map(formatIp);
    const api = await startTestApi({ pub, sql: db.sql });
    try {
      const { key } = await issueTestKey(api, { dailyQuota: 10_000_000, burst: 1000 });
      return await fn({ api, key, addresses, snapshotPath: join(pub.dir, release.path!) });
    } finally {
      await api.stop();
    }
  } finally {
    await pub.stop();
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  }
}

/** Spec 010 SC-004: p95 under 50 ms at 200 lookups per second, measured at the service. */
export async function measureApi(): Promise<Measurement[]> {
  return withStage2Api(RATE * SECONDS, async ({ api, key, addresses }) => {
    for (let i = 0; i < 200; i++) await (await api.get(`/v1/ip/${addresses[i]}`, bearer(key))).arrayBuffer(); // warm-up
    const latencies: number[] = [];
    const started = performance.now();
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < addresses.length; i++) {
      // Open loop: request i is sent at i / RATE seconds, whether or not earlier ones finished.
      const due = started + (i * 1000) / RATE;
      const wait = due - performance.now();
      if (wait > 0) await Bun.sleep(wait);
      const t = performance.now();
      inflight.push(api.get(`/v1/ip/${addresses[i]}`, bearer(key)).then(async (res) => {
        await res.arrayBuffer();
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        latencies.push(performance.now() - t);
      }));
    }
    await Promise.all(inflight);
    const p95 = percentile(latencies, 95);
    return [{
      criterion: `010 SC-004 API p95 at ${RATE}/s (${dataLabel()})`,
      target: "< 50 ms",
      measured: `${p95.toFixed(2)} ms (p50 ${percentile(latencies, 50).toFixed(2)} ms, ${latencies.length} lookups)`,
      pass: p95 < 50,
    }];
  });
}
