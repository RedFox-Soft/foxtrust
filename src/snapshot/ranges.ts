import type { SQL } from "bun";
import { BITS, parseCidr, type Cidr } from "../ip/cidr";
import type { Family } from "../ip/parse";
import { specialPurposeEntries } from "../ip/special-purpose";
import { BUILTIN_BOGON_SOURCE } from "../lookup/signals";
import type { Network, ScoringConfig, Signal } from "../model/types";
import type { MmdbValue } from "../mmdb/writer";
import { customerVerdict } from "../verdict/customer";

/**
 * Flattens the customer view of one data state into disjoint ranges (research R2):
 * collect prefixes → sweep boundaries → score each elementary range once per signal set →
 * merge neighbours with identical records.
 */

export type SnapshotRecord = { [key: string]: MmdbValue };

export type Range = { family: Family; start: bigint; end: bigint; record: SnapshotRecord };

type Item =
  | { kind: "network"; family: Family; start: bigint; end: bigint; length: number; network: Network; source: string }
  | { kind: "signal"; family: Family; start: bigint; end: bigint; length: number; signal: Signal; id: string }
  | { kind: "special"; family: Family; start: bigint; end: bigint; length: number; bogon: boolean; cidr: string };

const SUCCESS = ["applied", "unchanged"];

function span(cidr: Cidr): { start: bigint; end: bigint } {
  const size = 1n << BigInt(BITS[cidr.family] - cidr.length);
  return { start: cidr.network, end: cidr.network + size - 1n };
}

function itemFromPrefix(prefix: string): { family: Family; start: bigint; end: bigint; length: number } {
  const cidr = parseCidr(prefix);
  if (!cidr) throw new Error(`bad prefix from database: ${prefix}`);
  return { family: cidr.family, length: cidr.length, ...span(cidr) };
}

/** Reads everything a customer-facing snapshot may contain at `at`: shippable rows only. */
export async function collectItems(tx: SQL, at: Date): Promise<Item[]> {
  const items: Item[] = [];

  const networks = await tx`
    SELECT prefix::text AS prefix, asn, org, country, source
    FROM network_interval
    WHERE valid @> ${at}::timestamptz`;
  for (const n of networks) {
    items.push({
      kind: "network",
      ...itemFromPrefix(n.prefix),
      source: n.source,
      network: {
        asn: n.asn === null ? null : Number(n.asn),
        org: n.org ?? null,
        prefix: n.prefix,
        country: n.country ? String(n.country).trim() : null,
      },
    });
  }

  const categories = await tx`
    SELECT ci.prefix::text AS prefix, masklen(ci.prefix) AS length, ci.code, ci.source,
           lower(ci.valid) AS first_seen,
           CASE WHEN ci.last_seen <= ${at} THEN ci.last_seen
                ELSE COALESCE((SELECT max(fr.committed_at) FROM feed_run fr
                               WHERE fr.feed_id = ci.source AND fr.status IN ${tx(SUCCESS)}
                                 AND fr.committed_at <= ${at}), lower(ci.valid))
           END AS last_seen
    FROM category_interval ci
    WHERE ci.valid @> ${at}::timestamptz AND ci.shippable`;
  for (const c of categories) {
    items.push({
      kind: "signal",
      ...itemFromPrefix(c.prefix),
      id: `c:${c.source}:${c.code}:${c.prefix}`,
      signal: {
        kind: "category", code: c.code, source: c.source, prefix: c.prefix, prefixLength: Number(c.length),
        firstSeen: new Date(c.first_seen), lastSeen: new Date(c.last_seen), confidence: null, shippable: true,
      },
    });
  }

  const behavior = await tx`
    WITH raw AS (
      SELECT s.prefix, s.code, s.source, s.first_seen, s.confidence,
             CASE WHEN s.feed_time THEN s.last_seen
                  ELSE LEAST(s.last_seen, COALESCE((SELECT max(fr.committed_at) FROM feed_run fr
                                                   WHERE fr.feed_id = s.source AND fr.status IN ${tx(SUCCESS)}
                                                     AND fr.committed_at <= ${at}), s.first_seen))
             END AS last_seen
      FROM behavior_sighting s
      WHERE s.shippable AND s.recorded_at <= ${at}
      UNION ALL
      SELECT d.prefix, d.code, d.source, d.first_seen, d.confidence, d.last_seen
      FROM behavior_daily d
      WHERE d.shippable AND ((d.day + 1)::timestamp AT TIME ZONE 'UTC') <= ${at}
    )
    SELECT prefix::text AS prefix, masklen(prefix) AS length, code, source,
           min(first_seen) AS first_seen, max(last_seen) AS last_seen, max(confidence) AS confidence
    FROM raw GROUP BY prefix, code, source`;
  for (const b of behavior) {
    items.push({
      kind: "signal",
      ...itemFromPrefix(b.prefix),
      id: `b:${b.source}:${b.code}:${b.prefix}`,
      signal: {
        kind: "behavior", code: b.code, source: b.source, prefix: b.prefix, prefixLength: Number(b.length),
        firstSeen: new Date(b.first_seen), lastSeen: new Date(b.last_seen),
        confidence: b.confidence === null ? null : Number(b.confidence), shippable: true,
      },
    });
  }

  for (const e of specialPurposeEntries()) {
    items.push({ kind: "special", ...itemFromPrefix(e.cidr), bogon: !e.globallyReachable, cidr: e.cidr });
  }
  return items;
}

/** Sources whose rows are in `items` (the manifest lists their licence notices, FR-008a). */
export function itemSources(items: Item[]): string[] {
  const out = new Set<string>();
  for (const it of items) {
    if (it.kind === "network") out.add(it.source);
    else if (it.kind === "signal") out.add(it.signal.source);
    else if (it.bogon) out.add(BUILTIN_BOGON_SOURCE);
  }
  return [...out].sort();
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The MMDB record for a customer verdict (contracts/snapshot-record.schema.json). */
export function customerRecord(signals: Signal[], network: Network | null, config: ScoringConfig, at: Date): SnapshotRecord | null {
  const hasNetwork = network !== null && (network.asn !== null || network.org !== null || network.country !== null);
  // Local-only signals never reach a customer record, so they cannot make one exist either.
  if (!signals.some((s) => s.shippable) && !hasNetwork) return null;
  const empty: Network = { asn: null, org: null, prefix: null, country: null };
  const v = customerVerdict(signals, network ?? empty, config, at, at);
  const net: SnapshotRecord = {};
  if (network?.asn) net.asn = network.asn;
  if (network?.org) net.org = network.org;
  if (network?.country) net.country = network.country;
  return {
    risk: v.risk,
    level: v.level,
    categories: v.categories,
    reasons: v.reasons.map((r) => ({ code: r.code, last_seen: unix(r.lastSeen), contribution: r.contribution })),
    network: net,
  };
}

/** Sweeps the items of one family into merged ranges with their customer records. */
function sweepFamily(items: Item[], config: ScoringConfig, at: Date): Range[] {
  if (items.length === 0) return [];
  const family = items[0]!.family;
  type Event = { at: bigint; open: boolean; item: Item };
  const events: Event[] = [];
  for (const item of items) {
    events.push({ at: item.start, open: true, item });
    events.push({ at: item.end + 1n, open: false, item });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const active = new Set<Item>();
  const scoreCache = new Map<string, SnapshotRecord | null>();
  const out: Range[] = [];
  let lastKey: string | null = null;

  const emit = (start: bigint, end: bigint) => {
    let network: Network | null = null;
    let networkLength = -1;
    let special: Extract<Item, { kind: "special" }> | null = null;
    const signals: Signal[] = [];
    const ids: string[] = [];
    for (const it of active) {
      if (it.kind === "network" && it.length > networkLength) {
        network = it.network;
        networkLength = it.length;
      } else if (it.kind === "special" && (special === null || it.length > special.length)) {
        special = it;
      } else if (it.kind === "signal") {
        signals.push(it.signal);
        ids.push(it.id);
      }
    }
    if (special?.bogon) {
      signals.push({
        kind: "category", code: "bogon", source: BUILTIN_BOGON_SOURCE, prefix: special.cidr, prefixLength: special.length,
        firstSeen: at, lastSeen: at, confidence: null, shippable: true,
      });
      ids.push(`s:${special.cidr}`);
    }
    ids.sort();
    const netKey = network ? `${network.asn}|${network.org}|${network.country}` : "-";
    const cacheKey = `${ids.join(",")}#${netKey}`;
    let record = scoreCache.get(cacheKey);
    if (record === undefined) {
      record = customerRecord(signals, network, config, at);
      if (scoreCache.size < 500_000) scoreCache.set(cacheKey, record);
    }
    if (record === null) {
      lastKey = null;
      return;
    }
    const key = JSON.stringify(record);
    const prev = out[out.length - 1];
    if (prev && lastKey === key && prev.end + 1n === start) prev.end = end;
    else out.push({ family, start, end, record });
    lastKey = key;
  };

  for (let i = 0; i < events.length; ) {
    const point = events[i]!.at;
    while (i < events.length && events[i]!.at === point) {
      const e = events[i]!;
      if (e.open) active.add(e.item);
      else active.delete(e.item);
      i++;
    }
    const next = i < events.length ? events[i]!.at : null;
    if (next !== null && active.size > 0) emit(point, next - 1n);
    else if (active.size === 0) lastKey = null;
  }
  return out;
}

/** Customer-facing ranges for one data state (both families). */
export function flatten(items: Item[], config: ScoringConfig, at: Date): Range[] {
  return [
    ...sweepFamily(items.filter((i) => i.family === 4), config, at),
    ...sweepFamily(items.filter((i) => i.family === 6), config, at),
  ];
}

// ---- range tables (for deltas) -------------------------------------------------------------

/** Gzipped JSON lines: first line the record dictionary, then [family, start, end, recordIndex]. */
export function serializeRanges(ranges: Range[]): Uint8Array {
  const dict = new Map<string, number>();
  const records: SnapshotRecord[] = [];
  const lines: string[] = [];
  for (const r of ranges) {
    const key = JSON.stringify(r.record);
    let idx = dict.get(key);
    if (idx === undefined) {
      idx = records.length;
      records.push(r.record);
      dict.set(key, idx);
    }
    lines.push(JSON.stringify([r.family, r.start.toString(16), r.end.toString(16), idx]));
  }
  const text = `${JSON.stringify({ records })}\n${lines.join("\n")}\n`;
  return Bun.gzipSync(new TextEncoder().encode(text));
}

export function deserializeRanges(bytes: Uint8Array): Range[] {
  const text = new TextDecoder().decode(Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>));
  const [head, ...rest] = text.split("\n").filter(Boolean);
  const { records } = JSON.parse(head!) as { records: SnapshotRecord[] };
  return rest.map((line) => {
    const [family, s, e, idx] = JSON.parse(line) as [Family, string, string, number];
    return { family, start: BigInt(`0x${s}`), end: BigInt(`0x${e}`), record: records[idx]! };
  });
}

export const TOMBSTONE: SnapshotRecord = { removed: true };

/** Ranges whose record changed from `base` to `next`; ranges that disappeared become tombstones. */
export function diffRanges(base: Range[], next: Range[]): Range[] {
  const out: Range[] = [];
  for (const family of [4, 6] as const) {
    type Seg = { start: bigint; end: bigint; key: string | null; record: SnapshotRecord | null };
    const segs = (list: Range[]): Seg[] =>
      list.filter((r) => r.family === family).map((r) => ({ start: r.start, end: r.end, key: JSON.stringify(r.record), record: r.record }));
    const a = segs(base);
    const b = segs(next);
    const points = new Set<bigint>();
    for (const s of [...a, ...b]) {
      points.add(s.start);
      points.add(s.end + 1n);
    }
    const sorted = [...points].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const at = (list: Seg[], idx: { v: number }, p: bigint): Seg | null => {
      while (idx.v < list.length && list[idx.v]!.end < p) idx.v++;
      const s = list[idx.v];
      return s && s.start <= p && p <= s.end ? s : null;
    };
    const ra = { v: 0 };
    const rb = { v: 0 };
    for (let i = 0; i + 1 < sorted.length; i++) {
      const start = sorted[i]!;
      const end = sorted[i + 1]! - 1n;
      const sa = at(a, ra, start);
      const sb = at(b, rb, start);
      if ((sa?.key ?? null) === (sb?.key ?? null)) continue;
      const record = sb ? sb.record! : TOMBSTONE;
      const prev = out[out.length - 1];
      if (prev && prev.family === family && prev.end + 1n === start && JSON.stringify(prev.record) === JSON.stringify(record)) prev.end = end;
      else out.push({ family, start, end, record });
    }
  }
  return out;
}
