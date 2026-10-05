import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEEDS } from "../../src/feeds/registry";
import { KnownGoodError } from "../../src/eval/known-good";
import { buildAndRelease, type ReleaseOptions } from "../../src/snapshot/publish";
import type { ReleaseReport } from "../../src/snapshot/report";
import { loadSigningKey } from "../../src/snapshot/sign";
import { behaviorSighting, category, knownGoodFile } from "../helpers/accuracy";
import { describeDb, withTestDb } from "../helpers/db";
import { loadFixtureDataset } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { seedRows } from "../helpers/seed";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();

describeDb("US1 (spec 003): release gate on the known-good reference", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let opts: ReleaseOptions;
  let t0: Date;
  let firstVersion: string;

  const reportOf = async (version: string, staged?: string) =>
    (await Bun.file(staged ?? join(pub.dir, "v1", "reports", `${version}.json`)).json()) as ReleaseReport;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-003-us1-"));
    await loadFixtureDataset(db.sql);
    t0 = new Date();
    pub = await createTestPublication();
    opts = {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 150, knownGoodFile: await knownGoodFile(tmp),
    };
    const first = await buildAndRelease(db.sql, "full", { ...opts, at: t0, now: t0 });
    if (first.status !== "published") throw new Error(`first release: ${JSON.stringify(first)}`);
    firstVersion = first.version;
  }, 300_000);

  afterAll(async () => {
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US1-1: the report shows FP rates on the known-good reference and its version, with no FN rate and no feed name", async () => {
    const report = await reportOf(firstVersion);
    expect(report.reportVersion).toBe(2);
    expect(report.knownGood).toEqual({ file: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), count: 168 });
    for (const level of ["medium", "high"] as const) {
      expect(report.rates[level]).toEqual({ goodTotal: 168, falsePositives: expect.any(Number), fpRate: expect.any(Number) });
    }
    const text = JSON.stringify(report);
    for (const key of ["fnRate", "falseNegatives", "badTotal", "labels"]) expect(text).not.toContain(`"${key}"`);
    for (const feed of FEEDS) expect(text).not.toContain(feed.id);
  });

  test("US1-2: a release that newly rates a known-good address medium or high is held and lists it", async () => {
    // medium: a shippable Tor category on Quad9 (categories alone stop below high, Principle I).
    const mediumAt = new Date(t0.getTime() + DAY);
    await seedRows(db.sql, {
      categories: [category({ prefix: "9.9.9.9/32", code: "tor_exit", source: "tor-exit", from: iso(new Date(mediumAt.getTime() - 3_600_000)) })],
    });
    const medium = await buildAndRelease(db.sql, "full", { ...opts, at: mediumAt, now: mediumAt });
    expect(medium.status).toBe("held");
    const mediumReport = await reportOf("", (medium as { reportPath: string }).reportPath);
    expect(mediumReport.regressions.join(" ")).toContain("FP rate at medium rose");
    expect(mediumReport.changed.map((c) => c.ip)).toContain("9.9.9.9");

    // high: a shippable behavior sighting on 1.0.0.1 (a local-only one never reaches the
    // customer view).
    const highAt = new Date(t0.getTime() + 2 * DAY);
    await seedRows(db.sql, {
      sightings: [behaviorSighting({ prefix: "1.0.0.1/32", source: "tor-exit", code: "botnet_c2", recordedAt: iso(new Date(highAt.getTime() - 3_600_000)), shippable: true })],
    });
    const high = await buildAndRelease(db.sql, "full", { ...opts, at: highAt, now: highAt });
    expect(high.status).toBe("held");
    const highReport = await reportOf("", (high as { reportPath: string }).reportPath);
    expect(highReport.regressions.join(" ")).toContain("FP rate at high rose");
    expect(highReport.changed.find((c) => c.ip === "1.0.0.1")?.to).toBe("high");
  }, 300_000);

  test("US1-3: an invalid known-good reference stops the release before anything is recorded", async () => {
    const bad = await knownGoodFile(tmp, ["1.1.1.1,duplicate of an existing row,public:dns:one.one.one.one,2026-10-04"], "bad.csv");
    const at = new Date(t0.getTime() + 3 * DAY);
    const before = await db.sql`SELECT count(*)::int AS n FROM snapshot_release`;
    const error = await buildAndRelease(db.sql, "full", { ...opts, knownGoodFile: bad, at, now: at }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnownGoodError);
    expect((error as KnownGoodError).message).toContain("bad.csv");
    expect((error as KnownGoodError).problems.join(" ")).toMatch(/line 170: duplicate ip 1\.1\.1\.1/);
    const after = await db.sql`SELECT count(*)::int AS n FROM snapshot_release`;
    expect(after[0].n).toBe(before[0].n);

    // The evaluation refuses the same file with exit 2 and the same line.
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "eval", "--known-good", bad], {
      env: { ...Bun.env, DATABASE_URL: db.url },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("line 170: duplicate ip 1.1.1.1");
  }, 120_000);
});
