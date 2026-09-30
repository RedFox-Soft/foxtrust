import type { SQL } from "bun";
import { readSnapshot, type Db } from "../db/client";
import { resolveVersionAt, type ResolvedVersion } from "../db/versions";
import { BITS, rangeToCidrs } from "../ip/cidr";
import { parseIpv4, parseIpv6, type IpValue } from "../ip/parse";
import { gatherSignals } from "../lookup/signals";
import type { Network } from "../model/types";
import { openMmdb, overlay } from "../mmdb/reader";
import { MmdbWriter } from "../mmdb/writer";
import { collectItems, customerRecord, deserializeRanges, diffRanges, flatten, itemSources, serializeRanges, type Range } from "./ranges";

/** Snapshot builds (research R2, R3, R10). Validation runs before anything is published. */

export const SNAPSHOT_DB_TYPE = "FoxTrust-Customer-Verdict";
export const SIZE_BUDGET_BYTES = 250 * 1024 * 1024;
const DOUBLE_KEYS = ["risk", "contribution"];

export type Build = {
  kind: "full" | "delta";
  version: string;
  base: string | null;
  builtAt: Date;
  bytes: Uint8Array;
  /** Range table of the full customer view at build time (the base for later deltas). */
  rangeTable: Uint8Array;
  recordCount: number;
  rangeCount: number;
  dataVersion: ResolvedVersion;
  /** Sources with rows in the customer view (their licence notices go into the manifest). */
  sources: string[];
};

const pad = (n: number) => String(n).padStart(2, "0");
export const fullVersion = (at: Date) => `f${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
export const deltaVersion = (at: Date) => `d${fullVersion(at).slice(1)}T${pad(at.getUTCHours())}`;

// IPv6 space that standard readers map to IPv4 (::/96 and ::ffff:0:0/96) must not hold IPv6 data.
const V4_ALIASES: [bigint, bigint][] = [
  [0n, 0xffffffffn],
  [0xffffn << 32n, (0xffffn << 32n) + 0xffffffffn],
];

function clipIpv4Aliases(r: Range): Range[] {
  if (r.family !== 6) return [r];
  let parts: [bigint, bigint][] = [[r.start, r.end]];
  for (const [s, e] of V4_ALIASES) {
    parts = parts.flatMap(([a, z]): [bigint, bigint][] => {
      if (z < s || a > e) return [[a, z]];
      const out: [bigint, bigint][] = [];
      if (a < s) out.push([a, s - 1n]);
      if (z > e) out.push([e + 1n, z]);
      return out;
    });
  }
  return parts.map(([start, end]) => ({ ...r, start, end }));
}

function writeMmdb(ranges: Range[], version: string, at: Date, disputeUrl: string | null): { bytes: Uint8Array; records: number } {
  const writer = new MmdbWriter({
    databaseType: SNAPSHOT_DB_TYPE,
    description: {
      en: `FoxTrust customer verdicts, snapshot ${version} built ${at.toISOString()} from shippable data only.${disputeUrl ? ` Dispute a listing: ${disputeUrl}` : ""}`,
    },
    languages: ["en"],
    doubleKeys: DOUBLE_KEYS,
    buildEpoch: Math.floor(at.getTime() / 1000),
  });
  for (const r of ranges.flatMap(clipIpv4Aliases)) {
    for (const cidr of rangeToCidrs({ family: r.family, value: r.start }, { family: r.family, value: r.end })) {
      writer.insert(cidr, r.record);
    }
  }
  return { bytes: writer.build(), records: writer.recordCount };
}

async function customerRanges(tx: SQL, at: Date): Promise<{ ranges: Range[]; dataVersion: ResolvedVersion; sources: string[] }> {
  const dataVersion = await resolveVersionAt(tx, at);
  if (!dataVersion) throw new Error(`no data version exists at or before ${at.toISOString()}`);
  const items = await collectItems(tx, at);
  return { ranges: flatten(items, dataVersion.config, at), dataVersion, sources: itemSources(items) };
}

export async function buildFull(sql: Db, opts: { at?: Date; disputeUrl?: string | null } = {}): Promise<Build> {
  const at = opts.at ?? new Date();
  return readSnapshot(sql, async (tx) => {
    const { ranges, dataVersion, sources } = await customerRanges(tx, at);
    const version = fullVersion(at);
    const { bytes, records } = writeMmdb(ranges, version, at, opts.disputeUrl ?? null);
    return {
      kind: "full" as const, version, base: null, builtAt: at, bytes, rangeTable: serializeRanges(ranges),
      recordCount: records, rangeCount: ranges.length, dataVersion, sources,
    };
  });
}

/** Cumulative delta: every range whose record differs from the base full snapshot (research R3). */
export async function buildDelta(
  sql: Db,
  opts: { at?: Date; base: string; baseTable: Uint8Array; disputeUrl?: string | null },
): Promise<Build> {
  const at = opts.at ?? new Date();
  return readSnapshot(sql, async (tx) => {
    const { ranges, dataVersion, sources } = await customerRanges(tx, at);
    const changes = diffRanges(deserializeRanges(opts.baseTable), ranges);
    const version = deltaVersion(at);
    const { bytes, records } = writeMmdb(changes, version, at, opts.disputeUrl ?? null);
    return {
      kind: "delta" as const, version, base: opts.base, builtAt: at, bytes, rangeTable: serializeRanges(ranges),
      recordCount: records, rangeCount: changes.length, dataVersion, sources,
    };
  });
}

/** Deterministic PRNG so validation samples are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIn(start: bigint, end: bigint, random: () => number): bigint {
  const size = end - start + 1n;
  if (size <= 1n) return start;
  const r = BigInt(Math.floor(random() * 2 ** 52)) % size;
  return start + r;
}

const isEmptyNetwork = (n: Network) => n.asn === null && n.org === null && n.prefix === null && n.country === null;

/**
 * Validates a build before publication (FR-010, FR-002, SC-002):
 * - the file reads back with the in-house reader (and the base, for a delta);
 * - it fits the size budget;
 * - for a sample of addresses (random ranges plus addresses that carry local-only data) the
 *   snapshot answer equals the customer verdict computed from all stored signals, with the
 *   local-only ones dropped, and records never carry a source or a prefix.
 */
export async function validateBuild(
  sql: Db,
  build: Build,
  opts: { baseBytes?: Uint8Array | undefined; sample?: number | undefined; seed?: number } = {},
): Promise<string[]> {
  const problems: string[] = [];
  if (build.bytes.length > SIZE_BUDGET_BYTES) problems.push(`snapshot is ${build.bytes.length} bytes, over the ${SIZE_BUDGET_BYTES} budget`);
  let get: (ip: IpValue) => unknown;
  try {
    const file = openMmdb(build.bytes);
    if (file.metadata.database_type !== SNAPSHOT_DB_TYPE) problems.push(`unexpected database_type ${file.metadata.database_type}`);
    if (build.kind === "delta") {
      if (!opts.baseBytes) throw new Error("a delta needs its base to validate");
      get = overlay(openMmdb(opts.baseBytes), file);
    } else {
      get = (ip) => file.get(ip);
    }
  } catch (error) {
    return [...problems, `snapshot does not read back: ${(error as Error).message}`];
  }

  const sampleSize = opts.sample ?? 2000;
  const random = prng(opts.seed ?? 20260930);
  const ranges = deserializeRanges(build.rangeTable);
  const addresses: IpValue[] = [];
  for (let i = 0; i < Math.floor(sampleSize / 2) && ranges.length > 0; i++) {
    const r = ranges[Math.floor(random() * ranges.length)]!;
    addresses.push({ family: r.family, value: randomIn(r.start, r.end, random) });
  }

  return readSnapshot(sql, async (tx) => {
    const localOnly = await tx`
      SELECT prefix::text AS prefix FROM (
        SELECT prefix FROM category_interval WHERE NOT shippable AND valid @> ${build.builtAt}::timestamptz
        UNION SELECT prefix FROM behavior_sighting WHERE NOT shippable
        UNION SELECT prefix FROM behavior_daily WHERE NOT shippable) x
      ORDER BY md5(prefix::text) LIMIT ${Math.ceil(sampleSize / 2)}`;
    for (const row of localOnly) {
      const [ip, len] = String(row.prefix).split("/");
      const family = ip!.includes(":") ? 6 : 4;
      const bits = BigInt(BITS[family] - Number(len));
      const start = family === 6 ? parseIpv6(ip!)! : parseIpv4(ip!)!;
      addresses.push({ family, value: randomIn(start, start + (1n << bits) - 1n, random) });
    }

    const config = build.dataVersion.config;
    let checked = 0;
    for (const ip of addresses) {
      const { signals, network } = await gatherSignals(tx, ip, build.builtAt);
      const expected = customerRecord(signals, isEmptyNetwork(network) ? null : network, config, build.builtAt);
      const actual = get(ip);
      const a = JSON.stringify(actual ?? null);
      const e = JSON.stringify(expected);
      if (a !== e) {
        if (problems.length < 20) problems.push(`address sample mismatch: snapshot ${a.slice(0, 160)} ≠ expected ${e.slice(0, 160)}`);
      }
      if (/"source"|"prefix"/.test(a)) problems.push("a snapshot record carries a source or prefix field");
      checked++;
    }
    if (checked === 0 && ranges.length > 0) problems.push("validation sampled no addresses");
    return problems;
  });
}
