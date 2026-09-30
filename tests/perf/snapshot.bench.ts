import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeed } from "../../src/ingest/run";
import { buildAndRelease, type ReleaseOptions } from "../../src/snapshot/publish";
import { loadSigningKey } from "../../src/snapshot/sign";
import { createTestPublication } from "../helpers/publication";
import { dataLabel, feedFiles, loadStage2Data } from "./stage2-data";
import { prng, tempDb, type Measurement } from "./util";

/**
 * SC-007: a full build plus publication (validation, report, signing) takes < 60 min, and a
 * delta < 15 min. SC-006: after a typical hour of changes the delta is ≤ 5 % of the full file.
 *
 * The hour of changes: with BENCH_DIFF_DIR=<dir>, later copies of the Tor and X4BNet feeds from
 * <dir>/<feed>/<file name> are ingested; otherwise 5 % of the Tor exits are replaced, which is
 * more than Tor's usual hourly churn.
 */
export async function measureSnapshot(): Promise<Measurement[]> {
  const db = await tempDb("bench_snapshot");
  const dir = await mkdtemp(join(tmpdir(), "foxtrust-snapshot-bench-"));
  const pub = await createTestPublication();
  try {
    await loadStage2Data(db.sql, join(dir, "artifacts"));
    const opts: ReleaseOptions = {
      dir: pub.dir, workDir: join(dir, "work"), key: await loadSigningKey(pub.signingKeyPath), disputeUrl: "https://foxtrust.example/dispute",
    };
    const at = new Date();
    let t = performance.now();
    const full = await buildAndRelease(db.sql, "full", { ...opts, at, now: at });
    const fullMs = performance.now() - t;
    if (full.status !== "published") throw new Error(`full: ${JSON.stringify(full)}`);
    const fullSize = Bun.file(join(pub.dir, full.path!)).size;

    const diffDir = Bun.env.BENCH_DIFF_DIR?.trim();
    let change: string;
    if (diffDir) {
      for (const id of ["tor-exit", "x4bnet-datacenter"]) {
        const r = await runFeed(db.sql, id, { fromFiles: feedFiles(id, diffDir), artifactRoot: join(dir, "artifacts") });
        console.error(`  ${id} (later copy): ${r.status}, ${r.entryCount} entries`);
      }
      change = "recorded Tor and X4BNet copies";
    } else {
      const text = await Bun.file(feedFiles("tor-exit")[0]!).text();
      const random = prng(3);
      let replaced = 0;
      const changed = text.replace(/^ExitAddress (\S+) /gm, (line) => {
        if (random() >= 0.05) return line;
        replaced++;
        return `ExitAddress 185.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.${1 + Math.floor(random() * 254)} `;
      });
      const path = join(dir, "exit-list.txt");
      await Bun.write(path, changed);
      const r = await runFeed(db.sql, "tor-exit", { fromFiles: [path], artifactRoot: join(dir, "artifacts") });
      if (r.status !== "applied") throw new Error(`tor-exit change: ${r.status} ${r.error ?? ""}`);
      change = `${replaced} Tor exits replaced`;
    }

    const next = new Date(at.getTime() + 3_600_000);
    t = performance.now();
    const delta = await buildAndRelease(db.sql, "delta", { ...opts, at: next, now: next });
    const deltaMs = performance.now() - t;
    if (delta.status !== "published") throw new Error(`delta: ${JSON.stringify(delta)}`);
    const deltaSize = Bun.file(join(pub.dir, delta.path!)).size;
    const ratio = deltaSize / fullSize;
    return [
      {
        criterion: `002 SC-006 delta / full size after one hour (${dataLabel()}; ${change})`,
        target: "≤ 5 %",
        measured: `${(ratio * 100).toFixed(2)} % (${deltaSize} / ${fullSize} bytes)`,
        pass: ratio <= 0.05,
      },
      {
        criterion: `002 SC-007 full build + publish (${dataLabel()})`,
        target: "< 60 min",
        measured: `${(fullMs / 1000).toFixed(1)} s`,
        pass: fullMs < 60 * 60_000,
      },
      {
        criterion: `002 SC-007 delta build + publish (${dataLabel()})`,
        target: "< 15 min",
        measured: `${(deltaMs / 1000).toFixed(1)} s`,
        pass: deltaMs < 15 * 60_000,
      },
    ];
  } finally {
    await pub.stop();
    await rm(dir, { recursive: true, force: true });
    await db.drop();
  }
}

if (import.meta.main) console.table(await measureSnapshot());
