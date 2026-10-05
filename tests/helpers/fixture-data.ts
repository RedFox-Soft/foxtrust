import type { SQL } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateConfig } from "../../src/db/versions";
import { cloudFeed } from "../../src/feeds/ipverse-cloud";
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

/** Spec 005: the fixture cloud ASN list and the recorded ipverse files of its included ASNs. */
export const CLOUD_LIST = fixturePath("ipverse-cloud", "asns.csv");
export const CLOUD_FILES = [16509, 396982, 8075, 20473].map((asn) => fixturePath("ipverse-cloud", `as${asn}.json`));
export const CLOUD_CONFIG = join(import.meta.dir, "..", "..", "config", "scoring", "2026-10-06.1.json");

/** Ingests the cloud fixture with the fixture list (not part of loadFixtureDataset). */
export async function ingestCloudFixture(sql: SQL, opts: { listText?: string; files?: string[] } = {}): Promise<void> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "foxtrust-cloud-artifacts-"));
  const report = await runFeed(sql, "ipverse-cloud", {
    definition: cloudFeed(opts.listText ?? (await Bun.file(CLOUD_LIST).text())),
    fromFiles: opts.files ?? CLOUD_FILES,
    wikiRoot: WIKI,
    artifactRoot,
  });
  if (report.status !== "applied" && report.status !== "unchanged") {
    throw new Error(`cloud fixture ingest: ${report.status} ${report.error ?? ""}`);
  }
}

/** Activates config 2026-09-30.1 and ingests all 8 fixture feeds (overrides per feed allowed). */
export function loadFixtureDataset(sql: SQL, overrides: Record<string, string[]> = {}): Promise<void> {
  return loadFixtureFeeds(sql, Object.keys(FIXTURE_FILES), overrides);
}

/**
 * Activates config 2026-09-30.1 and ingests only `feeds` from the fixtures: tests that need some
 * data, not all of it, stay fast (a full dataset costs about 1.3 s).
 */
export async function loadFixtureFeeds(sql: SQL, feeds: string[], overrides: Record<string, string[]> = {}): Promise<void> {
  await activateConfig(sql, await loadConfig(STAGE2_CONFIG));
  const artifactRoot = await mkdtemp(join(tmpdir(), "foxtrust-fixture-artifacts-"));
  for (const feed of feeds) {
    const names = FIXTURE_FILES[feed];
    if (!names) throw new Error(`no fixture for feed ${feed}`);
    const fromFiles = overrides[feed] ?? names.map((n) => fixturePath(feed, n));
    const report = await runFeed(sql, feed, { fromFiles, wikiRoot: WIKI, artifactRoot });
    if (report.status !== "applied" && report.status !== "unchanged") {
      throw new Error(`fixture ingest ${feed}: ${report.status} ${report.error ?? ""}`);
    }
  }
}
