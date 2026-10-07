import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { evaluate } from "../../src/eval/evaluate";
import { loadKnownGood } from "../../src/eval/known-good";
import { FEEDS } from "../../src/feeds/registry";
import { runFeed } from "../../src/ingest/run";
import { shippedConfig } from "../helpers/seed";
import { measureAccuracyEvaluation } from "./accuracy.bench";
import { measureApi } from "./api.bench";
import { measureApiParity } from "./api-parity.measure";
import { measureCategoryCap } from "./category-cap.measure";
import { measureChallenge } from "./challenge.bench";
import { measureIngest } from "./ingest.bench";
import { measureLookup } from "./lookup.bench";
import { measureSecondReader } from "./second-reader.measure";
import { measureSnapshot } from "./snapshot.bench";
import { measureVerify } from "./verify.bench";
import { tempDb, type Measurement } from "./util";

const FIX = join(import.meta.dir, "..", "fixtures", "feeds");
const FIXTURE_FILES: Record<string, string[]> = {
  "x4bnet-datacenter": ["ipv4.txt", "ipv6.txt"],
  "cymru-fullbogons": ["fullbogons-ipv4.txt", "fullbogons-ipv6.txt"],
  "spamhaus-drop": ["drop_v4.json", "drop_v6.json"],
  "blocklist-de": ["ssh.txt", "bruteforcelogin.txt"],
  "tor-exit": ["exit-list.txt"],
  "feodo-tracker": ["ipblocklist.json"],
  iptoasn: ["ip2asn-combined.tsv.gz"],
  "iana-address-space": ["ipv4-address-space.csv", "ipv6-unicast-address-assignments.csv"],
};

/** SC-007: FP rate at `high` on the known-good set, against the fixture dataset. */
async function measureAccuracy(): Promise<Measurement[]> {
  const db = await tempDb("bench_eval");
  try {
    await activateConfig(db.sql, await shippedConfig());
    for (const def of FEEDS.filter((f) => FIXTURE_FILES[f.id])) {
      await runFeed(db.sql, def.id, { fromFiles: FIXTURE_FILES[def.id]!.map((n) => join(FIX, def.id, n)) });
    }
    const report = await evaluate(db.sql, { knownGood: await loadKnownGood() });
    const high = report.configs[0]!.falsePositives.high;
    const fnHigh = report.configs[0]!.knownBad.rates.high;
    const fnMedium = report.configs[0]!.knownBad.rates.medium;
    return [
      {
        criterion: "SC-007 FP rate at high on known-good (fixture data)",
        target: "≤ 2 %",
        measured: `${(high.fpRate * 100).toFixed(1)} % (${high.falsePositives}/${high.goodTotal}); FN on the fresh sample at high ${(fnHigh.fnRate * 100).toFixed(1)} %, at medium ${(fnMedium.fnRate * 100).toFixed(1)} %`,
        pass: high.fpRate <= 0.02,
      },
    ];
  } finally {
    await db.drop();
  }
}

const measurements: Measurement[] = [];
for (const [name, fn] of [
  ["SC-003", measureCategoryCap],
  ["SC-007", measureAccuracy],
  ["SC-001", measureLookup],
  ["SC-004", measureIngest],
  ["stage 2 SC-001", measureSecondReader],
  ["stage 2 SC-004/SC-005", measureVerify],
  ["stage 2 SC-006/SC-007", measureSnapshot],
  ["spec 003 SC-006", measureAccuracyEvaluation],
  ["spec 006 SC-001/SC-005", measureChallenge],
  ["spec 010 SC-003", measureApiParity],
  ["spec 010 SC-004", measureApi],
] as const) {
  console.error(`measuring ${name}…`);
  measurements.push(...(await fn()));
}

const width = Math.max(...measurements.map((m) => m.criterion.length));
for (const m of measurements) {
  console.log(`${m.pass ? "PASS" : "FAIL"}  ${m.criterion.padEnd(width)}  target ${m.target.padEnd(9)}  ${m.measured}`);
}
process.exitCode = measurements.every((m) => m.pass) ? 0 : 1;
