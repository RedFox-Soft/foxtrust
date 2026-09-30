import type { SQL } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { runFeed } from "../../src/ingest/run";
import { loadConfig } from "../../src/scoring/config";

const FIX = join(import.meta.dir, "..", "fixtures", "feeds");
const WIKI = join(import.meta.dir, "..", "..", "docs", "wiki", "entities");
export const STAGE2_CONFIG = join(import.meta.dir, "..", "..", "config", "scoring", "2026-09-30.1.json");

export const FIXTURE_FILES: Record<string, string[]> = {
  iptoasn: ["ip2asn-combined.tsv.gz"],
  "x4bnet-datacenter": ["ipv4.txt", "ipv6.txt"],
  "tor-exit": ["exit-list.txt"],
  "cymru-fullbogons": ["fullbogons-ipv4.txt", "fullbogons-ipv6.txt"],
  "spamhaus-drop": ["drop_v4.json", "drop_v6.json"],
  "feodo-tracker": ["ipblocklist.json"],
  "blocklist-de": ["ssh.txt", "bruteforcelogin.txt"],
  "iana-address-space": ["ipv4-address-space.csv", "ipv6-unicast-address-assignments.csv"],
};

export const fixturePath = (feed: string, name: string) => join(FIX, feed, name);

/** Activates config 2026-09-30.1 and ingests all 8 fixture feeds (overrides per feed allowed). */
export async function loadFixtureDataset(
  sql: SQL,
  overrides: Record<string, string[]> = {},
): Promise<void> {
  await activateConfig(sql, await loadConfig(STAGE2_CONFIG));
  const artifactRoot = await mkdtemp(join(tmpdir(), "foxtrust-fixture-artifacts-"));
  for (const [feed, names] of Object.entries(FIXTURE_FILES)) {
    const fromFiles = overrides[feed] ?? names.map((n) => fixturePath(feed, n));
    const report = await runFeed(sql, feed, { fromFiles, wikiRoot: WIKI, artifactRoot });
    if (report.status !== "applied" && report.status !== "unchanged") {
      throw new Error(`fixture ingest ${feed}: ${report.status} ${report.error ?? ""}`);
    }
  }
}
