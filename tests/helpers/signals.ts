import { contains, formatCidr, parseCidr, type Cidr } from "../../src/ip/cidr";
import type { IpValue } from "../../src/ip/parse";
import { builtinBogonSignal, categoryLastSeen, episodeLastSeen } from "../../src/lookup/rules";
import type { GatheredSignals } from "../../src/lookup/signals";
import type { Signal } from "../../src/model/types";
import type { SeedRows } from "./seed";

const cidrOf = (text: string): Cidr => {
  const cidr = parseCidr(text);
  if (!cidr) throw new Error(`bad prefix in scenario: ${text}`);
  return cidr;
};
const time = (iso: string) => new Date(iso);
const validAt = (from: string, to: string | null | undefined, at: Date) => time(from) <= at && (!to || at < time(to));
const endOfDay = (day: string) => new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000;

/**
 * What a lookup gathers from `seed` at `at`, built in memory: the row selection of the queries in
 * src/lookup/signals.ts, then the shared rules of src/lookup/rules.ts. The runs are the ones
 * seedRows records (listed runs, plus one at every from / lastSeen / recordedAt a row mentions).
 * Scenarios marked "layer": "sql" also run against PostgreSQL, which keeps this model honest.
 */
export function gatherFromSeed(seed: SeedRows, ip: IpValue, at: Date, excludeSources: string[] = []): GatheredSignals {
  const runs: { feed: string; at: string }[] = [
    ...(seed.runs ?? []),
    ...(seed.categories ?? []).flatMap((c) => [{ feed: c.source, at: c.from }, { feed: c.source, at: c.lastSeen }]),
    ...(seed.sightings ?? []).flatMap((s) => [{ feed: s.source, at: s.recordedAt ?? s.firstSeen }, { feed: s.source, at: s.lastSeen }]),
  ];
  const latest = new Map<string, Date>();
  for (const r of runs) {
    const t = time(r.at);
    if (t <= at && (latest.get(r.feed) ?? new Date(0)) < t) latest.set(r.feed, t);
  }

  const covering = <T extends { prefix: string }>(rows: T[] | undefined) =>
    (rows ?? []).map((row) => ({ row, cidr: cidrOf(row.prefix) })).filter(({ cidr }) => contains(cidr, ip));
  const fields = (row: { code: string; source: string; shippable?: boolean }, cidr: Cidr) => ({
    code: row.code, source: row.source, prefix: formatCidr(cidr), prefixLength: cidr.length, shippable: row.shippable ?? true,
  });

  const signals: Signal[] = [];
  for (const { row, cidr } of covering(seed.categories)) {
    if (!validAt(row.from, row.to, at)) continue;
    const firstSeen = time(row.from);
    signals.push({ kind: "category", ...fields(row, cidr), firstSeen, lastSeen: categoryLastSeen(firstSeen, latest.get(row.source)), confidence: null });
  }
  for (const { row, cidr } of covering(seed.sightings)) {
    if (time(row.recordedAt ?? row.firstSeen) > at) continue;
    const firstSeen = time(row.firstSeen);
    const lastSeen = episodeLastSeen({ firstSeen, lastSeen: time(row.lastSeen), feedTime: row.feedTime ?? false }, latest.get(row.source));
    signals.push({ kind: "behavior", ...fields(row, cidr), firstSeen, lastSeen, confidence: row.confidence ?? null });
  }
  for (const { row, cidr } of covering(seed.daily)) {
    if (endOfDay(row.day) > at.getTime()) continue;
    signals.push({ kind: "behavior", ...fields(row, cidr), firstSeen: time(row.firstSeen), lastSeen: time(row.lastSeen), confidence: row.confidence ?? null });
  }
  const builtin = builtinBogonSignal(ip, at);
  if (builtin) signals.push(builtin);

  const net = covering(seed.network).filter(({ row }) => validAt(row.from, row.to, at)).sort((a, b) => b.cidr.length - a.cidr.length)[0];
  const network = net
    ? { asn: net.row.asn, org: net.row.org, prefix: formatCidr(net.cidr), country: net.row.country }
    : { asn: null, org: null, prefix: null, country: null };

  const excluded = new Set(excludeSources);
  return { signals: signals.filter((s) => !excluded.has(s.source)), network };
}
