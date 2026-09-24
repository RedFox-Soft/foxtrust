import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { evaluate } from "../../src/eval/evaluate";
import { loadLabels, type LabelledAddress } from "../../src/eval/labels";
import { runFeed } from "../../src/ingest/run";
import { createIpTrust } from "../../src/lookup/lookup";
import type { ScoringConfig } from "../../src/model/types";
import { describeDb, resetData, withTestDb } from "../helpers/db";
import { shippedConfig } from "../helpers/seed";

const FIX = join(import.meta.dir, "..", "fixtures", "feeds");
const WIKI = join(import.meta.dir, "..", "..", "docs", "wiki", "entities");
const f = (feed: string, name: string) => join(FIX, feed, name);

describeDb("US3: accuracy baseline", () => {
  const db = withTestDb();
  let tmp: string;
  let labels: LabelledAddress[];
  let base: ScoringConfig;
  let freshFeodo: string;
  let feodoIp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-us3-"));
    labels = await loadLabels();
    base = await shippedConfig();
    // The recorded Feodo entries were last online months ago and have decayed to ~0; a copy seen
    // today makes the leave-one-source-out effect visible (US3-3).
    const today = new Date().toISOString().slice(0, 10);
    const records = JSON.parse(await Bun.file(f("feodo-tracker", "ipblocklist.json")).text());
    feodoIp = records[0].ip_address;
    freshFeodo = join(tmp, "ipblocklist.json");
    await Bun.write(freshFeodo, JSON.stringify(records.map((r: object) => ({ ...r, last_online: today }))));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetData(db.sql);
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
  });

  test("US3-1: the report shows FP and FN rates for medium and high, per-source counts and the data version", async () => {
    const report = await evaluate(db.sql, { labels });
    expect(report.dataVersion).toMatch(/^dv\d+\.noisy-or\/1\.[0-9a-f]{8}$/);
    expect(report.configs).toHaveLength(1);
    const [only] = report.configs;
    expect(only!.configVersion).toBe("2026-09-24.1");

    const good = labels.filter((l) => l.label === "good").length;
    const bad = labels.filter((l) => l.label === "bad").length;
    for (const level of ["medium", "high"] as const) {
      const r = only!.rates[level];
      expect(r.goodTotal).toBe(good);
      expect(r.badTotal).toBe(bad);
      expect(r.fpRate).toBeCloseTo(r.falsePositives / good, 10);
      expect(r.fnRate).toBeCloseTo(r.falseNegatives / bad, 10);
    }
    expect(report.labelSources["feodo-tracker"]).toBe(labels.filter((l) => l.labelSource === "feodo-tracker").length);
    expect(report.labelSources["spamhaus-drop"]).toBeGreaterThan(0);
    expect(Object.values(report.labelSources).reduce((a, b) => a + b, 0)).toBe(labels.length);
  });

  test("US3-2: comparing two configurations shows the rate deltas and the addresses whose level changed", async () => {
    const variant: ScoringConfig = {
      ...base,
      version: "2026-09-24.2",
      codes: { ...base.codes, hosting: { ...base.codes.hosting!, weight: 0.4 } as ScoringConfig["codes"][string] },
    };
    const report = await evaluate(db.sql, { labels, configs: [base, variant] });
    const [a, b] = report.configs;
    const comparison = report.comparison!;
    expect(comparison.deltas.medium.fpRate).toBeCloseTo(b!.rates.medium.fpRate - a!.rates.medium.fpRate, 10);
    expect(comparison.deltas.medium.fnRate).toBeCloseTo(b!.rates.medium.fnRate - a!.rates.medium.fnRate, 10);

    // Hosting-only addresses go from 12 (low) to 32 (medium) under the variant.
    const hostingOnly = a!.results.filter((r) => r.risk === 12);
    expect(hostingOnly.length).toBeGreaterThan(0);
    for (const r of hostingOnly) {
      expect(comparison.changed).toContainEqual({ ip: r.ip, label: r.label, from: "low", to: "medium", riskFrom: 12, riskTo: 32 });
    }
    const unchanged = a!.results.filter((r) => r.risk === 0).map((r) => r.ip);
    expect(comparison.changed.some((c) => unchanged.includes(c.ip))).toBe(false);
  });

  test("US3-3: a Feodo-labelled address is scored without Feodo signals and counts as a false negative", async () => {
    const client = createIpTrust({ databaseUrl: db.url });
    try {
      const full = await client.lookup(feodoIp);
      if (!full.ok) throw new Error("lookup failed");
      expect(full.verdict.reasons.map((r) => r.source)).toContain("feodo-tracker");
      expect(full.verdict.level).toBe("high");
    } finally {
      await client.close();
    }

    const report = await evaluate(db.sql, { labels });
    const result = report.configs[0]!.results.find((r) => r.ip === feodoIp)!;
    expect(result.label).toBe("bad");
    expect(result.labelSource).toBe("feodo-tracker");
    expect(result.level).not.toBe("high"); // only the Feodo signal made it high
    const bad = report.configs[0]!.results.filter((r) => r.label === "bad");
    expect(report.configs[0]!.rates.high.falseNegatives).toBe(bad.filter((r) => r.level !== "high").length);
  });

  test("US3-1: the CLI prints the same report as the library", async () => {
    const report = await evaluate(db.sql, { labels });
    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "eval", "--at", report.at, "--json"], {
      env: { ...Bun.env, DATABASE_URL: db.url },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const cli = JSON.parse(await new Response(proc.stdout).text());
    expect(cli).toEqual({ ...report, configs: report.configs.map(({ results: _r, ...c }) => c) });
  });
});
