import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { evaluate, type EvaluationReport } from "../../src/eval/evaluate";
import { loadKnownGood, type KnownGood } from "../../src/eval/known-good";
import { runFeed } from "../../src/ingest/run";
import type { ScoringConfig } from "../../src/model/types";
import { describeDb, withTestDb } from "../helpers/db";
import { shippedConfig } from "../helpers/seed";

const FIX = join(import.meta.dir, "..", "fixtures", "feeds");
const WIKI = join(import.meta.dir, "..", "..", "docs", "wiki", "entities");
const f = (feed: string, name: string) => join(FIX, feed, name);
// Early detection scores every fixture address (all recorded at ingestion, so all inside the
// window), which takes longer than the default 5 s.

// Spec 001 US3, amended by spec 003: false positives on the known-good reference, false negatives
// on a fresh known-bad sample. US3-3 is superseded by spec 003 US2-2 (us2-known-bad-sample.test.ts).
describeDb("US3: accuracy baseline", () => {
  const db = withTestDb();
  let tmp: string;
  let knownGood: KnownGood;
  let base: ScoringConfig;
  let freshFeodo: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-us3-"));
    knownGood = await loadKnownGood();
    base = await shippedConfig();
    // The recorded Feodo entries were last online months ago; a copy seen today puts them inside
    // the sample window.
    const today = new Date().toISOString().slice(0, 10);
    const records = JSON.parse(await Bun.file(f("feodo-tracker", "ipblocklist.json")).text());
    freshFeodo = join(tmp, "ipblocklist.json");
    await Bun.write(freshFeodo, JSON.stringify(records.map((r: object) => ({ ...r, last_online: today }))));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // The tests only read, so the fixture feeds are loaded once for the file.
  beforeAll(async () => {
    await activateConfig(db.sql, base);
    const files: Record<string, string[]> = {
      iptoasn: [f("iptoasn", "ip2asn-combined.tsv.gz")],
      "x4bnet-datacenter": [f("x4bnet-datacenter", "ipv4.txt"), f("x4bnet-datacenter", "ipv6.txt")],
      "tor-exit": [f("tor-exit", "exit-list.txt")],
      "cymru-fullbogons": [f("cymru-fullbogons", "fullbogons-ipv4.txt"), f("cymru-fullbogons", "fullbogons-ipv6.txt")],
      "spamhaus-drop": [f("spamhaus-drop", "drop_v4.json"), f("spamhaus-drop", "drop_v6.json")],
      "feodo-tracker": [freshFeodo],
      "blocklist-de": [f("blocklist-de", "ssh.txt"), f("blocklist-de", "bruteforcelogin.txt")],
    };
    for (const [feed, paths] of Object.entries(files)) {
      const report = await runFeed(db.sql, feed, { fromFiles: paths, wikiRoot: WIKI, artifactRoot: join(tmp, "artifacts") });
      if (report.status !== "applied") throw new Error(`${feed}: ${report.status} ${report.error}`);
    }
  }, 60_000);

  test("US3-1: the report shows FP rates on the known-good reference, FN rates on the sample, and the data version", async () => {
    const report = await evaluate(db.sql, { knownGood });
    expect(report.dataVersion).toMatch(/^dv\d+\.noisy-or\/1\.[0-9a-f]{8}$/);
    expect(report.reference).toEqual(knownGood.reference);
    expect(report.configs).toHaveLength(1);
    const [only] = report.configs;
    expect(only!.configVersion).toBe("2026-09-24.1");

    const sampled = Object.values(report.sample.byFeed).reduce((n, b) => n + b.size, 0);
    expect(report.sample.byFeed["feodo-tracker"]!.size).toBeGreaterThan(0);
    expect(report.sample.byFeed["spamhaus-drop"]!.size).toBeGreaterThan(0);
    for (const level of ["medium", "high"] as const) {
      const fp = only!.falsePositives[level];
      expect(fp.goodTotal).toBe(knownGood.entries.length);
      expect(fp.fpRate).toBeCloseTo(fp.falsePositives / fp.goodTotal, 10);
      const fn = only!.knownBad.rates[level];
      expect(fn.badTotal).toBe(sampled);
      expect(fn.fnRate).toBeCloseTo(fn.falseNegatives / sampled, 10);
    }
  }, 60_000);

  test("US3-2: comparing two configurations shows the rate deltas and the addresses whose level changed", async () => {
    const variant: ScoringConfig = {
      ...base,
      version: "2026-09-24.2",
      codes: { ...base.codes, hosting: { ...base.codes.hosting!, weight: 0.4 } },
    };
    const report = await evaluate(db.sql, { knownGood, configs: [base, variant] });
    const [a, b] = report.configs;
    const fp = report.comparison!.falsePositives;
    expect(fp.deltas.medium.fpRate).toBeCloseTo(b!.falsePositives.medium.fpRate - a!.falsePositives.medium.fpRate, 10);
    expect(report.comparison!.knownBad.deltas.medium.fnRate).toBeCloseTo(b!.knownBad.rates.medium.fnRate - a!.knownBad.rates.medium.fnRate, 10);
    expect(a!.badResults.map((r) => r.ip)).toEqual(b!.badResults.map((r) => r.ip));

    // Hosting-only known-good addresses go from 12 (low) to 32 (medium) under the variant.
    const hostingOnly = a!.goodResults.filter((r) => r.risk === 12);
    expect(hostingOnly.length).toBeGreaterThan(0);
    for (const r of hostingOnly) {
      expect(fp.changed).toContainEqual({ ip: r.ip, from: "low", to: "medium", riskFrom: 12, riskTo: 32 });
    }
    const unchanged = a!.goodResults.filter((r) => r.risk === 0).map((r) => r.ip);
    expect(fp.changed.some((c) => unchanged.includes(c.ip))).toBe(false);
  }, 60_000);

  test("US3-1: the CLI prints the same report as the library", async () => {
    const report: EvaluationReport = await evaluate(db.sql, { knownGood });
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "eval", "--at", report.at, "--json"], {
      env: { ...Bun.env, DATABASE_URL: db.url },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const cli = JSON.parse(await new Response(proc.stdout).text());
    expect(cli).toEqual({ ...report, configs: report.configs.map(({ goodResults: _g, badResults: _b, ...c }) => c) });
  }, 60_000);
});
