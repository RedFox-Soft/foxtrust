import { join } from "node:path";
import type { Db } from "../db/client";
import { findNewAddresses } from "../eval/early-detection";
import type { KnownGood, KnownGoodEntry, ReferenceVersion } from "../eval/known-good";
import { compareFp, fpLevelRates, levelShares, type ByLevel, type Changed, type FpRates, type Scored } from "../eval/metrics";
import { toIpValue, type IpValue } from "../ip/parse";
import type { Level } from "../model/types";
import { openMmdb, overlay } from "../mmdb/reader";
import type { MmdbValue } from "../mmdb/writer";
import { configSha256 } from "../scoring/config";
import type { Build } from "./build";

/**
 * Release report v2 and regression gate (spec 003, research R6; constitution Principle VI). The
 * known-good reference is looked up in the file customers get (base + delta for a delta), and
 * compared with the previous release of the same kind; the first delta of a day is compared with
 * its full snapshot. The report is public: it names no feed or source.
 */

/** A regression: the FP rate on the known-good reference at `medium` or `high` up by more than 0.5 pp. */
export const MAX_FP_INCREASE_MEDIUM = 0.005;
export const MAX_FP_INCREASE_HIGH = 0.005;
/** Days after a full release in which newly reported addresses count for its early detection. */
export const EARLY_DETECTION_WINDOW_DAYS = 7;

export type EarlyDetectionSummary =
  | {
      available: true;
      release: string;
      moment: string;
      windowDays: number;
      found: number;
      medium: { count: number; share: number };
      high: { count: number; share: number };
    }
  | { available: false; reason: string };

export type ReleaseReport = {
  reportVersion: 2;
  version: string;
  kind: "full" | "delta";
  base: string | null;
  builtAt: string;
  dataVersion: string;
  algorithm: string;
  configSha256: string;
  method: string;
  knownGood: ReferenceVersion;
  rates: ByLevel<FpRates>;
  previous: { version: string; rates: ByLevel<FpRates> } | null;
  deltas: ByLevel<{ fpRate: number }> | null;
  changed: Changed[];
  regressions: string[];
  earlyDetection: EarlyDetectionSummary;
  releaseNote: string | null;
};

type Get = (ip: IpValue) => MmdbValue | null;

/** Level and risk of each address in a customer view; an address the view does not list is `low`. */
export function customerResults(get: Get, entries: { ip: string }[]): Scored[] {
  return entries.map((entry) => {
    const ip = toIpValue(entry.ip);
    if ("error" in ip) throw new Error(`address ${entry.ip}: ${ip.error}`);
    const record = get(ip) as { level?: MmdbValue; risk?: MmdbValue } | null;
    const level = (typeof record?.level === "string" ? record.level : "low") as Level;
    return { ip: entry.ip, level, risk: Number(record?.risk ?? 0) };
  });
}

const pp = (x: number) => `${(x * 100).toFixed(1)} pp`;

/** The release a build is compared with, as a lookup, or null for the very first release. */
async function previousRelease(sql: Db, dir: string, build: Build): Promise<{ version: string; get: Get } | null> {
  const read = async (path: string) => openMmdb(new Uint8Array(await Bun.file(join(dir, path)).arrayBuffer()));
  const [full] = await sql`
    SELECT version, file_path FROM snapshot_release
    WHERE kind = 'full' AND status = 'published' AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`;
  if (build.kind === "full") return full ? { version: full.version, get: (await read(full.file_path)).get } : null;

  const base = full && full.version === build.base ? await read(full.file_path) : null;
  if (!base) return null;
  const [delta] = await sql`
    SELECT version, file_path FROM snapshot_release
    WHERE kind = 'delta' AND status = 'published' AND valid_to IS NULL AND base_version = ${build.base}
    ORDER BY valid_from DESC LIMIT 1`;
  if (!delta) return { version: full.version, get: base.get };
  return { version: delta.version, get: overlay(base, await read(delta.file_path)) };
}

/**
 * Early detection of the latest published full release whose window is over, on the customer view
 * it published, over shippable behavior sightings only (research R4, Principle III). Aggregate only:
 * a public report names no feed. It never adds a regression (FR-007).
 */
async function releaseEarlyDetection(sql: Db, dir: string, now: Date): Promise<EarlyDetectionSummary> {
  const windowDays = EARLY_DETECTION_WINDOW_DAYS;
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000);
  const [row] = await sql`
    SELECT version, file_path, valid_from FROM snapshot_release
    WHERE kind = 'full' AND status = 'published' AND valid_from <= ${cutoff}
    ORDER BY valid_from DESC LIMIT 1`;
  if (!row) return { available: false, reason: `no published full release is ${windowDays} days old yet` };
  const moment = new Date(row.valid_from);
  const found = await findNewAddresses(sql, { moment, windowDays, shippableOnly: true });
  if (found.length === 0) {
    return { available: false, reason: `no shippable behavior address was first reported in the ${windowDays} days after ${row.version}` };
  }
  const view = openMmdb(new Uint8Array(await Bun.file(join(dir, row.file_path)).arrayBuffer()));
  return {
    available: true,
    release: row.version,
    moment: moment.toISOString(),
    windowDays,
    found: found.length,
    ...levelShares(customerResults(view.get, found)),
  };
}

export async function releaseReport(
  sql: Db,
  build: Build,
  opts: { dir: string; baseBytes?: Uint8Array | undefined; knownGood: KnownGood; now?: Date },
): Promise<ReleaseReport> {
  const entries: KnownGoodEntry[] = opts.knownGood.entries;
  const file = openMmdb(build.bytes);
  const get: Get = build.kind === "delta" ? overlay(openMmdb(opts.baseBytes!), file) : file.get;
  const current = customerResults(get, entries);
  const prev = await previousRelease(sql, opts.dir, build);
  const prevResults = prev ? customerResults(prev.get, entries) : null;
  const comparison = prevResults ? compareFp(prevResults, current) : null;

  const regressions: string[] = [];
  if (comparison) {
    const { medium, high } = comparison.deltas;
    if (medium.fpRate > MAX_FP_INCREASE_MEDIUM) regressions.push(`FP rate at medium rose by ${pp(medium.fpRate)} (limit ${pp(MAX_FP_INCREASE_MEDIUM)})`);
    if (high.fpRate > MAX_FP_INCREASE_HIGH) regressions.push(`FP rate at high rose by ${pp(high.fpRate)} (limit ${pp(MAX_FP_INCREASE_HIGH)})`);
  }
  const config = build.dataVersion.config;
  return {
    reportVersion: 2,
    version: build.version,
    kind: build.kind,
    base: build.base,
    builtAt: build.builtAt.toISOString(),
    dataVersion: build.dataVersion.label,
    algorithm: config.algorithm,
    configSha256: configSha256(config),
    method:
      "Known-good addresses are looked up in the published customer view (base + delta for a delta) " +
      "and compared with the previous release of the same kind.",
    knownGood: opts.knownGood.reference,
    rates: fpLevelRates(current),
    previous: prev && prevResults ? { version: prev.version, rates: fpLevelRates(prevResults) } : null,
    deltas: comparison?.deltas ?? null,
    changed: comparison?.changed ?? [],
    regressions,
    earlyDetection: await releaseEarlyDetection(sql, opts.dir, opts.now ?? new Date()),
    releaseNote: null,
  };
}
