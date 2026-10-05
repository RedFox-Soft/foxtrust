import { beforeAll, beforeEach, expect, test } from "bun:test";
import { evaluate } from "../../src/eval/evaluate";
import { loadKnownGood, type KnownGood } from "../../src/eval/known-good";
import type { ScoringConfig } from "../../src/model/types";
import { loadConfig } from "../../src/scoring/config";
import { behaviorSighting, isoDaysAgo } from "../helpers/accuracy";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { STAGE2_CONFIG } from "../helpers/fixture-data";
import { seedRows } from "../helpers/seed";

// Public, non-bogon addresses: documentation ranges would add a bogon category to every score.
const HOUR_IN_DAYS = 1 / 24;

describeDb("US2 (spec 003): known-bad evaluation on a fresh sample", () => {
  const db = withTestDb();
  let knownGood: KnownGood;
  let config: ScoringConfig;
  let at: Date;

  const versionLongAgo = () => ({ versions: [{ at: isoDaysAgo(30) }] });

  beforeAll(async () => {
    knownGood = await loadKnownGood();
    config = await loadConfig(STAGE2_CONFIG);
  });

  beforeEach(async () => {
    await resetData(db.sql);
    at = new Date();
  });

  test("US2-1: only addresses reported inside the window are sampled, reproducibly, and the report states how", async () => {
    await seedRows(db.sql, {
      ...versionLongAgo(),
      sightings: [
        behaviorSighting({ prefix: "45.67.89.10/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(2, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
        behaviorSighting({ prefix: "45.67.89.20/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(10, at) }),
        behaviorSighting({ prefix: "45.68.0.0/24", source: "spamhaus-drop", code: "hijacked_netblock", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
        // Recorded after the evaluation time: not known at `at`.
        behaviorSighting({ prefix: "45.67.89.30/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(-HOUR_IN_DAYS, at) }),
      ],
    }, config);

    const report = await evaluate(db.sql, { knownGood, at });
    const sampled = report.configs[0]!.badResults.map((r) => r.ip).sort();
    expect(sampled).toEqual(["45.67.89.10", "45.68.0.1"]);
    expect(report.sample.windowDays).toBe(7);
    expect(report.sample.perFeed).toBe(100);
    expect(report.sample.method).toContain("md5");
    expect(report.sample.byFeed).toEqual({
      "blocklist-de": { size: 1 },
      "feodo-tracker": { size: 0, noSample: true },
      "spamhaus-drop": { size: 1 },
    });

    // Same data, same time: the same sample and rates (FR-009).
    expect(await evaluate(db.sql, { knownGood, at })).toEqual(report);

    // Nine days earlier the window holds the older sighting only.
    const earlier = await evaluate(db.sql, { knownGood, at: new Date(at.getTime() - 9 * 86_400_000) });
    expect(earlier.configs[0]!.badResults.map((r) => r.ip)).toEqual(["45.67.89.20"]);
  });

  test("US2-2: an address reported by two feeds is scored without the feed it was sampled from only", async () => {
    await seedRows(db.sql, {
      ...versionLongAgo(),
      sightings: [
        behaviorSighting({ prefix: "45.67.89.7/32", source: "feodo-tracker", code: "botnet_c2", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
        behaviorSighting({ prefix: "45.67.89.7/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
      ],
    }, config);

    const report = await evaluate(db.sql, { knownGood, at });
    const results = report.configs[0]!.badResults;
    const fromFeodo = results.find((r) => r.feed === "feodo-tracker")!;
    const fromBlocklist = results.find((r) => r.feed === "blocklist-de")!;
    // Without Feodo only the SSH brute force remains (medium); without blocklist.de, the C2 (high).
    expect(fromFeodo).toMatchObject({ ip: "45.67.89.7", level: "medium" });
    expect(fromBlocklist).toMatchObject({ ip: "45.67.89.7", level: "high" });
    expect(report.sample.byFeed["feodo-tracker"]).toEqual({ size: 1 });
    expect(report.configs[0]!.knownBad.byFeed["feodo-tracker"]!.high).toEqual({ badTotal: 1, falseNegatives: 1, fnRate: 1 });
  });

  test("US2-3: two configurations are compared on one sample, with the addresses whose level changed", async () => {
    await seedRows(db.sql, {
      ...versionLongAgo(),
      sightings: [
        behaviorSighting({ prefix: "45.67.89.7/32", source: "feodo-tracker", code: "botnet_c2", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
        behaviorSighting({ prefix: "45.67.89.7/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
        behaviorSighting({ prefix: "45.67.89.8/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
      ],
    }, config);
    const variant: ScoringConfig = {
      ...config,
      version: "2026-09-30.98",
      codes: { ...config.codes, ssh_bruteforce: { ...config.codes.ssh_bruteforce!, weight: 0.1 } },
    };

    const report = await evaluate(db.sql, { knownGood, at, configs: [config, variant] });
    const [a, b] = report.configs;
    expect(a!.badResults.map((r) => `${r.feed}:${r.ip}`)).toEqual(b!.badResults.map((r) => `${r.feed}:${r.ip}`));
    const changed = report.comparison!.knownBad.changed;
    expect(changed).toContainEqual(expect.objectContaining({ ip: "feodo-tracker:45.67.89.7", from: "medium", to: "low" }));
    expect(report.comparison!.knownBad.deltas.medium.fnRate).toBeCloseTo(b!.knownBad.rates.medium.fnRate - a!.knownBad.rates.medium.fnRate, 10);
  });

  test("US2-4: a behavior feed with nothing in the window reports no sample instead of a rate", async () => {
    await seedRows(db.sql, {
      ...versionLongAgo(),
      sightings: [
        behaviorSighting({ prefix: "45.67.89.8/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR_IN_DAYS, at) }),
        behaviorSighting({ prefix: "45.68.0.0/24", source: "spamhaus-drop", code: "hijacked_netblock", recordedAt: isoDaysAgo(20, at) }),
      ],
    }, config);

    const report = await evaluate(db.sql, { knownGood, at });
    expect(report.sample.byFeed["spamhaus-drop"]).toEqual({ size: 0, noSample: true });
    expect(report.configs[0]!.knownBad.byFeed["spamhaus-drop"]).toBeUndefined();
    expect(report.configs[0]!.knownBad.byFeed["blocklist-de"]).toBeDefined();
  });
});
