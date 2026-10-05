import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../../src/eval/evaluate";
import { loadKnownGood, type KnownGood } from "../../src/eval/known-good";
import type { ScoringConfig } from "../../src/model/types";
import { loadConfig } from "../../src/scoring/config";
import { buildAndRelease, type ReleaseOptions } from "../../src/snapshot/publish";
import type { ReleaseReport } from "../../src/snapshot/report";
import { loadSigningKey } from "../../src/snapshot/sign";
import { behaviorSighting, category, isoDaysAgo, knownGoodFile } from "../helpers/accuracy";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { fixturePath, loadFixtureFeeds, STAGE2_CONFIG } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";
import { seedRows } from "../helpers/seed";

const DAY = 86_400_000;
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

// Public, non-bogon addresses: documentation ranges would add a bogon category to every score.
describeDb("US3 (spec 003): early detection in the evaluation", () => {
  const db = withTestDb();
  let knownGood: KnownGood;
  let config: ScoringConfig;

  beforeAll(async () => {
    knownGood = await loadKnownGood();
    config = await loadConfig(STAGE2_CONFIG);
  });
  beforeEach(async () => {
    await resetData(db.sql);
  });

  test("US3-1: addresses first reported after the moment are counted with their level at the moment, overall and per feed", async () => {
    const at = new Date();
    const moment = plusDays(at, -7);
    const iso = (days: number) => plusDays(moment, days).toISOString();
    await seedRows(db.sql, {
      versions: [{ at: isoDaysAgo(30, at) }],
      categories: [
        category({ prefix: "45.71.0.5/32", code: "tor_exit", source: "tor-exit", from: isoDaysAgo(40, at) }),
        category({ prefix: "45.70.0.0/16", code: "hosting", source: "x4bnet-datacenter", from: isoDaysAgo(40, at) }),
      ],
      sightings: [
        behaviorSighting({ prefix: "45.71.0.5/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: iso(1) }), // Tor at T: medium
        behaviorSighting({ prefix: "45.70.1.5/32", source: "feodo-tracker", code: "botnet_c2", recordedAt: iso(2) }), // hosting at T: low
        behaviorSighting({ prefix: "45.72.0.9/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: iso(3) }), // nothing at T: low
        // Not new: recorded before T.
        behaviorSighting({ prefix: "45.73.0.1/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: iso(-1), lastSeen: iso(1) }),
        // Not new: covered by a netblock recorded before T.
        behaviorSighting({ prefix: "45.74.0.0/24", source: "spamhaus-drop", code: "hijacked_netblock", recordedAt: iso(-2) }),
        behaviorSighting({ prefix: "45.74.0.8/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: iso(1) }),
        // Outside the window: recorded after T + 7 days.
        behaviorSighting({ prefix: "45.75.0.1/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: iso(7.5) }),
      ],
    }, config);

    const report = await evaluate(db.sql, { knownGood, at, now: at });
    expect(report.earlyDetectionRefused).toBeUndefined();
    const early = report.configs[0]!.earlyDetection!;
    expect(early).toMatchObject({
      moment: moment.toISOString(),
      windowDays: 7,
      found: 3,
      medium: { count: 1, share: 1 / 3 },
      high: { count: 0, share: 0 },
    });
    expect(early.byFeed["blocklist-de"]).toMatchObject({ found: 2, medium: { count: 1, share: 0.5 } });
    expect(early.byFeed["feodo-tracker"]).toMatchObject({ found: 1, medium: { count: 0, share: 0 } });
    expect(early.byFeed["spamhaus-drop"]).toBeUndefined();
  });

  test("US3-4: a moment older than the raw retention is refused with the oldest valid moment; the other sections still print", async () => {
    await seedRows(db.sql, { versions: [{ at: isoDaysAgo(200) }] }, config);
    const at = isoDaysAgo(100);
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "eval", "--at", at], {
      env: { ...Bun.env, DATABASE_URL: db.url },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(3);
    expect(await new Response(proc.stderr).text()).toContain("the oldest measurable moment is");
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("False positives");
    expect(stdout).toContain("Known-bad sample");
    expect(stdout).toContain("Early detection: not measured.");
  });
});

describeDb("US3 (spec 003): early detection in release reports", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let opts: ReleaseOptions;
  let t0: Date;
  let first: { version: string; reportPath: string | null };
  let torExit: string;

  async function releaseAt(at: Date) {
    const r = await buildAndRelease(db.sql, "full", { ...opts, at, now: at });
    if (r.status !== "published") throw new Error(`release at ${at.toISOString()}: ${JSON.stringify(r)}`);
    return r;
  }
  const reportOf = async (version: string) => (await Bun.file(join(pub.dir, "v1", "reports", `${version}.json`)).json()) as ReleaseReport;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-003-us3-"));
    // The Tor exit in US3-2 needs its category; the tests seed the sightings they measure.
    await loadFixtureFeeds(db.sql, ["tor-exit"]);
    t0 = new Date();
    pub = await createTestPublication();
    opts = {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 150, knownGoodFile: await knownGoodFile(tmp),
    };
    torExit = (await Bun.file(fixturePath("tor-exit", "exit-list.txt")).text())
      .split(/\r?\n/).find((l) => l.startsWith("ExitAddress"))!.split(/\s+/)[1]!;
    first = await releaseAt(t0);
  }, 300_000);

  afterAll(async () => {
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US3-3: the first release has no earlier release to measure", async () => {
    const report = await reportOf(first.version);
    expect(report.earlyDetection).toEqual({ available: false, reason: expect.stringContaining("7 days old") });
  });

  test("US3-2: a later release reports early detection of the earlier release, on shippable addresses only and without feeds", async () => {
    // Shippable sightings use a shippable source on purpose: no behavior feed is shippable today.
    const day1 = plusDays(t0, 1).toISOString();
    await seedRows(db.sql, {
      sightings: [
        behaviorSighting({ prefix: `${torExit}/32`, source: "tor-exit", code: "ssh_bruteforce", recordedAt: day1, shippable: true }),
        behaviorSighting({ prefix: "45.72.0.9/32", source: "tor-exit", code: "ssh_bruteforce", recordedAt: day1, shippable: true }),
        behaviorSighting({ prefix: "45.72.0.10/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: day1 }), // local-only
      ],
    });
    const later = await releaseAt(plusDays(t0, 8));
    const report = await reportOf(later.version);
    expect(report.earlyDetection).toEqual({
      available: true,
      release: first.version,
      moment: expect.any(String),
      windowDays: 7,
      found: 2,
      medium: { count: 1, share: 0.5 },
      high: { count: 0, share: 0 },
    });
    expect(JSON.stringify(report)).not.toContain("byFeed");
  }, 300_000);

  test("US3-3: a release whose window holds only local-only sightings reports early detection as not available", async () => {
    await seedRows(db.sql, {
      sightings: [behaviorSighting({ prefix: "45.72.0.11/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: plusDays(t0, 9).toISOString() })],
    });
    const third = await releaseAt(plusDays(t0, 20));
    const report = await reportOf(third.version);
    expect(report.earlyDetection).toEqual({ available: false, reason: expect.stringContaining("no shippable behavior address") });
  }, 300_000);
});
