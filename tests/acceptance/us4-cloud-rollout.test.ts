import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reader } from "mmdb-lib";
import { activateConfig } from "../../src/db/versions";
import { evaluate } from "../../src/eval/evaluate";
import { loadKnownGood, type KnownGood } from "../../src/eval/known-good";
import { createIpTrust } from "../../src/lookup/lookup";
import type { ScoringConfig } from "../../src/model/types";
import { loadConfig } from "../../src/scoring/config";
import { buildAndRelease, type ReleaseOptions } from "../../src/snapshot/publish";
import type { ReleaseReport } from "../../src/snapshot/report";
import { loadSigningKey } from "../../src/snapshot/sign";
import { describeDb, withTestDb } from "../helpers/db";
import { CLOUD_CONFIG, ingestCloudFixture, loadFixtureDataset, STAGE2_CONFIG } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";

const DAY = 86_400_000;
const AWS_V4 = "3.5.140.2";

describeDb("US4 (spec 005): enabling the cloud category is measured before it ships", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let knownGood: KnownGood;
  let current: ScoringConfig;
  let proposed: ScoringConfig;

  const categoriesOf = async (ip: string) => {
    const client = createIpTrust({ databaseUrl: db.url });
    try {
      const result = await client.lookup(ip);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.verdict.categories;
    } finally {
      await client.close();
    }
  };

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-005-us4-"));
    await loadFixtureDataset(db.sql); // config 2026-09-30.1 stays active
    await ingestCloudFixture(db.sql);
    knownGood = await loadKnownGood();
    current = await loadConfig(STAGE2_CONFIG);
    proposed = await loadConfig(CLOUD_CONFIG);
    pub = await createTestPublication();
  }, 120_000);

  afterAll(async () => {
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US4-1: before activation the cloud data changes no verdict; the comparison shows no known-good change", async () => {
    expect(await categoriesOf(AWS_V4)).not.toContain("cloud");

    const report = await evaluate(db.sql, { knownGood, configs: [current, proposed] });
    const fp = report.comparison!.falsePositives;
    expect(fp.deltas.medium.fpRate).toBe(0);
    expect(fp.deltas.high.fpRate).toBe(0);
    expect(fp.changed).toEqual([]);

    const proc = Bun.spawn(["bun", "run", "src/cli/main.ts", "eval", "--compare", STAGE2_CONFIG, CLOUD_CONFIG, "--json"], {
      env: { ...Bun.env, DATABASE_URL: db.url }, stdout: "pipe", stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const cli = JSON.parse(await new Response(proc.stdout).text()) as typeof report;
    expect(cli.configs.map((c) => c.configVersion)).toEqual(["2026-09-30.1", "2026-10-06.1"]);
    expect(cli.comparison!.falsePositives.changed).toEqual([]);
  }, 120_000);

  test("US4-2: the first release with cloud passes the known-good gate and carries cloud", async () => {
    const opts: ReleaseOptions = {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 50,
    };
    const t0 = new Date();
    const before = await buildAndRelease(db.sql, "full", { ...opts, at: t0, now: t0 });
    expect(before.status).toBe("published");

    await activateConfig(db.sql, proposed);
    const t1 = new Date(t0.getTime() + DAY);
    const after = await buildAndRelease(db.sql, "full", { ...opts, at: t1, now: t1 });
    expect(after.status).toBe("published");
    const version = (after as { version: string }).version;
    const report = (await Bun.file(join(pub.dir, "v1", "reports", `${version}.json`)).json()) as ReleaseReport;
    expect(report.regressions).toEqual([]);
    expect(report.changed.filter((c) => c.to === "medium" || c.to === "high")).toEqual([]);

    const bytes = new Uint8Array(await Bun.file(join(pub.dir, (after as { path: string }).path)).arrayBuffer());
    const record = new Reader(Buffer.from(bytes)).get(AWS_V4) as unknown as { categories: string[] } | null;
    expect(record?.categories).toContain("cloud");
  }, 300_000);
});
