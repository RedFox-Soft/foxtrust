import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { activateConfig } from "../../src/db/versions";
import { loadConfig } from "../../src/scoring/config";
import { runSnapshotRetention, snapshotAt } from "../../src/snapshot/archive";
import { buildAndRelease, type ReleaseOptions } from "../../src/snapshot/publish";
import type { ReleaseReport } from "../../src/snapshot/report";
import { importTrustedKeys, loadSigningKey, verify } from "../../src/snapshot/sign";
import { knownGoodFile } from "../helpers/accuracy";
import { describeDb, withTestDb } from "../helpers/db";
import { loadFixtureFeeds, STAGE2_CONFIG } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeDb("US4: snapshot archive and release quality", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let opts: ReleaseOptions;
  let t0: Date;
  const published: { version: string; at: Date }[] = [];

  const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const bytesOf = async (path: string) => new Uint8Array(await Bun.file(join(pub.dir, path)).arrayBuffer());

  async function publishAt(kind: "full" | "delta", offsetMs: number) {
    const at = new Date(t0.getTime() + offsetMs);
    const r = await buildAndRelease(db.sql, kind, { ...opts, at, now: at });
    if (r.status !== "published") throw new Error(`${kind} at ${at.toISOString()}: ${JSON.stringify(r)}`);
    published.push({ version: r.version, at });
    return r;
  }

  /** Runs the CLI against the test database and publication. */
  async function cli(args: string[]): Promise<number> {
    const saved = { ...Bun.env };
    Object.assign(Bun.env, {
      DATABASE_URL: db.url,
      FOXTRUST_SIGNING_KEY: pub.signingKeyPath,
      FOXTRUST_PUBLICATION_DIR: pub.dir,
      FOXTRUST_SNAPSHOT_WORK_DIR: opts.workDir,
      FOXTRUST_DISPUTE_URL: opts.disputeUrl!,
      FOXTRUST_KNOWN_GOOD: opts.knownGoodFile!,
    });
    try {
      return await main(args);
    } finally {
      for (const key of Object.keys(Bun.env)) if (!(key in saved)) delete Bun.env[key];
      Object.assign(Bun.env, saved);
    }
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-us4-"));
    // Archive behaviour needs releases, not much data: X4BNet holds the known-good address that the
    // variant in US4-2 pushes to medium.
    await loadFixtureFeeds(db.sql, ["x4bnet-datacenter"]);
    t0 = new Date();

    pub = await createTestPublication();
    opts = {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 150, knownGoodFile: await knownGoodFile(tmp),
    };
    // Three simulated days: a full snapshot and two hourly deltas each.
    for (let day = 0; day < 3; day++) {
      await publishAt("full", day * DAY);
      await publishAt("delta", day * DAY + HOUR);
      await publishAt("delta", day * DAY + 2 * HOUR);
    }
  }, 300_000);

  afterAll(async () => {
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US4-1: the snapshot current at a past time is returned with its signature, algorithm and config", async () => {
    const archive = (await Bun.file(join(pub.dir, "v1", "archive", "index.json")).json()) as { version: string; sha256: string }[];
    expect(archive.map((e) => e.version)).toEqual(published.map((p) => p.version));
    const trusted = await importTrustedKeys([pub.publicKey]);
    const config = await loadConfig(STAGE2_CONFIG);

    // 90 minutes into day 2: its full snapshot and its first delta.
    const found = await snapshotAt(db.sql, new Date(t0.getTime() + DAY + 1.5 * HOUR));
    expect(found?.full.version).toBe(published[3]!.version);
    expect(found?.delta?.version).toBe(published[4]!.version);
    for (const file of [found!.full, found!.delta!]) {
      const bytes = await bytesOf(file.path);
      expect(sha256(bytes)).toBe(file.sha256);
      expect(archive.find((e) => e.version === file.version)?.sha256).toBe(file.sha256);
      expect((await verify(bytes, await bytesOf(file.signaturePath), trusted)).ok).toBe(true);
      expect(file.algorithm).toBe("noisy-or/1");
      expect(file.config).toEqual(config);
    }
    // Right after a full release, before any delta.
    const early = await snapshotAt(db.sql, new Date(t0.getTime() + 2 * DAY + 30 * 60_000));
    expect({ full: early?.full.version, delta: early?.delta }).toEqual({ full: published[6]!.version, delta: null });
    expect(await snapshotAt(db.sql, new Date(t0.getTime() - HOUR))).toBeNull();
    // Every release has a report.
    for (const p of published) expect(await Bun.file(join(pub.dir, "v1", "reports", `${p.version}.json`)).exists()).toBe(true);
  });

  test("US4-2: a regression holds full and delta releases until a release note explains it", async () => {
    // A variant config that weighs hosting more: the known-good address in a fixture hosting range
    // (2001:19f0:b800:1ddf:5400:4ff:fe4e:2aad) rises to medium, so FP at medium rises (spec 003).
    const base = await loadConfig(STAGE2_CONFIG);
    const variant = { ...base, version: "2026-09-30.99", codes: { ...base.codes, hosting: { ...base.codes.hosting!, weight: 0.5 } } };
    const variantFile = join(tmp, "variant.json");
    await Bun.write(variantFile, JSON.stringify(variant));
    await activateConfig(db.sql, await loadConfig(variantFile));

    const fullAt = new Date(t0.getTime() + 3 * DAY);
    expect(await cli(["snapshot", "build", "--full", "--at", fullAt.toISOString()])).toBe(3);
    const deltaAt = new Date(t0.getTime() + 2 * DAY + 3 * HOUR);
    expect(await cli(["snapshot", "build", "--delta", "--at", deltaAt.toISOString()])).toBe(3);

    const rows = await db.sql`SELECT version, kind, status, report_path FROM snapshot_release WHERE status = 'held' ORDER BY id`;
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["full", "delta"]);
    const heldReport = (await Bun.file(rows[1].report_path).json()) as ReleaseReport;
    expect(heldReport.regressions.join(" ")).toContain("FP rate at medium rose");
    const manifestBefore = await Bun.file(join(pub.dir, "v1", "manifest.json")).json();
    expect(manifestBefore.delta.version).toBe(published[8]!.version);

    // Without a note it stays held; with one it is published, and the note is kept.
    const delta = rows[1].version as string;
    expect(await cli(["snapshot", "publish", delta])).toBe(1);
    const note = "Hosting weight raised on purpose for this test";
    expect(await cli(["snapshot", "publish", delta, "--release-note", note])).toBe(0);
    const report = (await Bun.file(join(pub.dir, "v1", "reports", `${delta}.json`)).json()) as ReleaseReport;
    expect(report.releaseNote).toBe(note);
    expect(report.regressions.length).toBeGreaterThan(0);
    const manifest = await Bun.file(join(pub.dir, "v1", "manifest.json")).json();
    expect({ delta: manifest.delta.version, note: manifest.releaseNote }).toEqual({ delta, note });
    const [full] = await db.sql`SELECT status FROM snapshot_release WHERE version = ${rows[0].version}`;
    expect(full.status).toBe("held");
  }, 120_000);

  test("US4-3: retention deletes files and rows older than 395 days and keeps newer ones", async () => {
    // At that time, day 1 went out of use more than 395 days ago; day 2 did not. The second
    // delta of day 3 was replaced in US4-2 at the real current time, also before the cutoff.
    const now = new Date(t0.getTime() + 395 * DAY + 25 * HOUR);
    const day1 = [...published.slice(0, 3).map((p) => p.version), published[8]!.version];
    const kept = published.slice(3, 8).map((p) => p.version);
    const result = await runSnapshotRetention(db.sql, opts, now);
    expect(result.deleted.sort()).toEqual([...day1].sort());
    for (const v of day1) {
      const kind = v.startsWith("f") ? "full" : "delta";
      expect(await Bun.file(join(pub.dir, "v1", kind, `${v}.mmdb`)).exists()).toBe(false);
      expect(await Bun.file(join(pub.dir, "v1", kind, `${v}.mmdb.sig`)).exists()).toBe(false);
    }
    const rows = await db.sql`SELECT version FROM snapshot_release`;
    const remaining = rows.map((r: { version: string }) => r.version);
    for (const v of kept) expect(remaining).toContain(v);
    for (const v of day1) expect(remaining).not.toContain(v);
    const archive = (await Bun.file(join(pub.dir, "v1", "archive", "index.json")).json()) as { version: string }[];
    expect(archive.some((e) => day1.includes(e.version))).toBe(false);
  }, 60_000);
});
