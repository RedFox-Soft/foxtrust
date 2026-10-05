import { beforeAll, expect, test } from "bun:test";
import { Reader } from "mmdb-lib";
import { activateConfig } from "../../src/db/versions";
import { createIpTrust } from "../../src/lookup/lookup";
import type { Verdict } from "../../src/model/types";
import { loadConfig } from "../../src/scoring/config";
import { buildFull } from "../../src/snapshot/build";
import { describeDb, withTestDb } from "../helpers/db";
import { CLOUD_CONFIG, ingestCloudFixture, loadFixtureFeeds } from "../helpers/fixture-data";

type SnapshotRecord = { categories: string[]; reasons: Record<string, unknown>[] };

const AWS_V4 = "3.5.140.2"; // AS16509 fixture prefix 3.0.0.0/8
const GCP_V6 = "2001:671:fc00::1"; // AS396982 fixture prefix 2001:671:fc00::/38
const HOSTING_AND_AWS = "1.44.96.1"; // AS16509 1.44.96.0/24, also in the X4BNet fixture

describeDb("US1 (spec 005): cloud addresses carry the cloud category", () => {
  const db = withTestDb();
  const lookup = async (ip: string): Promise<Verdict> => {
    const client = createIpTrust({ databaseUrl: db.url });
    try {
      const result = await client.lookup(ip);
      if (!result.ok) throw new Error(`lookup ${ip}: ${JSON.stringify(result.error)}`);
      return result.verdict;
    } finally {
      await client.close();
    }
  };

  beforeAll(async () => {
    await loadFixtureFeeds(db.sql, ["x4bnet-datacenter"]); // hosting for US1-4
    await ingestCloudFixture(db.sql);
    await activateConfig(db.sql, await loadConfig(CLOUD_CONFIG));
  }, 120_000);

  test("US1-1: an address of a listed cloud ASN has category cloud and a cloud reason (IPv4/IPv6)", async () => {
    for (const [ip, prefix] of [[AWS_V4, "3.0.0.0/8"], [GCP_V6, "2001:671:fc00::/38"]] as const) {
      const v = await lookup(ip);
      expect(v.categories).toContain("cloud");
      const reason = v.reasons.find((r) => r.code === "cloud");
      expect(reason).toMatchObject({ kind: "category", source: "ipverse-cloud", prefix, shippable: true });
      expect(reason!.contribution).toBeGreaterThan(0);
      expect(Date.parse(reason!.lastSeen)).not.toBeNaN();
    }
  });

  test("US1-2: addresses of unlisted or excluded ASNs have no cloud category", async () => {
    for (const ip of ["8.8.8.8", "9.9.9.9", "2001:4860:4860::8888"]) {
      const v = await lookup(ip);
      expect({ ip, cloud: v.categories.includes("cloud") }).toEqual({ ip, cloud: false });
    }
  });

  test("US1-3: a snapshot read by a standard MMDB reader lists cloud with code, time and contribution only", async () => {
    const build = await buildFull(db.sql, { disputeUrl: "https://foxtrust.example/dispute" });
    const reader = new Reader(Buffer.from(build.bytes));
    for (const ip of [AWS_V4, GCP_V6]) {
      const record = reader.get(ip) as unknown as SnapshotRecord | null;
      expect(record?.categories).toContain("cloud");
      const reason = record!.reasons.find((r) => r.code === "cloud");
      expect(Object.keys(reason!).sort()).toEqual(["code", "contribution", "last_seen"]);
    }
    expect(JSON.stringify(reader.get(AWS_V4))).not.toContain("ipverse");
  });

  test("US1-4: an address in a cloud and a hosting prefix lists both categories and stays below high", async () => {
    const v = await lookup(HOSTING_AND_AWS);
    expect(v.categories).toEqual(expect.arrayContaining(["cloud", "hosting"]));
    expect(v.level).not.toBe("high");
  });
});
