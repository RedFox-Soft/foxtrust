import { expect, test } from "bun:test";
import { evaluate } from "../../src/eval/evaluate";
import { loadKnownGood } from "../../src/eval/known-good";
import { loadConfig } from "../../src/scoring/config";
import { behaviorSighting, category, isoDaysAgo } from "../helpers/accuracy";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { STAGE2_CONFIG } from "../helpers/fixture-data";
import { seedRows } from "../helpers/seed";

const HOUR = 1 / 24;

// Public, non-bogon addresses: documentation ranges would add a bogon category to every score.
describeDb("US4 (spec 003): what each feed adds", () => {
  const db = withTestDb();

  test("US4-1: per feed, the active entries and how many keep medium or high without that feed", async () => {
    await resetData(db.sql);
    const at = new Date();
    const config = await loadConfig(STAGE2_CONFIG);
    await seedRows(db.sql, {
      versions: [{ at: isoDaysAgo(30, at) }],
      categories: [category({ prefix: "45.81.0.1/32", code: "tor_exit", source: "tor-exit", from: isoDaysAgo(10, at) })],
      sightings: [
        // Two feeds: high with either one alone.
        behaviorSighting({ prefix: "45.80.0.1/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR, at) }),
        behaviorSighting({ prefix: "45.80.0.1/32", source: "feodo-tracker", code: "botnet_c2", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR, at) }),
        // One feed only: medium with it, low without.
        behaviorSighting({ prefix: "45.80.0.2/32", source: "blocklist-de", code: "ssh_bruteforce", recordedAt: isoDaysAgo(1, at), lastSeen: isoDaysAgo(HOUR, at) }),
      ],
    }, config);

    const report = await evaluate(db.sql, { knownGood: await loadKnownGood(), at, now: at, contribution: { perFeed: 1000 } });
    const rows = Object.fromEntries(report.configs[0]!.contribution!.map((r) => [r.feed, r]));
    expect(rows["blocklist-de"]).toEqual({ feed: "blocklist-de", kind: "behavior", active: 2, sampled: 2, keepMedium: 1, keepHigh: 1, dropBelowMedium: 1 });
    expect(rows["feodo-tracker"]).toEqual({ feed: "feodo-tracker", kind: "behavior", active: 1, sampled: 1, keepMedium: 1, keepHigh: 0, dropBelowMedium: 0 });
    expect(rows["tor-exit"]).toEqual({ feed: "tor-exit", kind: "category", active: 1, sampled: 1, keepMedium: 0, keepHigh: 0, dropBelowMedium: 1 });
    expect(rows.iptoasn).toBeUndefined(); // network feeds carry no risk signal
  });
});
