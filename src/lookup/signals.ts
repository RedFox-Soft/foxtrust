import type { SQL } from "bun";
import { formatIp, type IpValue } from "../ip/parse";
import type { Network, Signal } from "../model/types";
import { builtinBogonSignal, categoryLastSeen, episodeLastSeen, type LatestRuns } from "./rules";

export { BUILTIN_BOGON_SOURCE } from "./rules";

export type GatheredSignals = { signals: Signal[]; network: Network };

const SUCCESS = ["applied", "unchanged"];
const asDate = (v: unknown) => new Date(v as string | Date);
const asNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Each feed's latest successful run at or before `at` (the input of the lastSeen rules). */
export async function latestRuns(tx: SQL, at: Date): Promise<LatestRuns> {
  const rows = await tx`
    SELECT feed_id, max(committed_at) AS committed_at FROM feed_run
    WHERE status IN ${tx(SUCCESS)} AND committed_at <= ${at}
    GROUP BY feed_id`;
  return new Map(rows.map((r: { feed_id: string; committed_at: unknown }) => [r.feed_id, asDate(r.committed_at)]));
}

async function gather(
  tx: SQL,
  ip: IpValue,
  at: Date,
  excludeSources: string[],
  runs: Promise<LatestRuns>,
): Promise<GatheredSignals> {
  const address = formatIp(ip);

  // The reads are independent; sent together they cost one round trip.
  const [categoryRows, sightingRows, dailyRows, [networkRow], latest] = await Promise.all([
    // Category intervals valid at `at`.
    tx`
      SELECT prefix::text AS prefix, masklen(prefix) AS length, code, source, shippable, lower(valid) AS first_seen
      FROM category_interval
      WHERE prefix >>= ${address}::inet AND valid @> ${at}::timestamptz`,

    // Raw behavior observations recorded by `at`.
    tx`
      SELECT prefix::text AS prefix, masklen(prefix) AS length, code, source, shippable, confidence,
             first_seen, last_seen, feed_time
      FROM behavior_sighting
      WHERE prefix >>= ${address}::inet AND recorded_at <= ${at}`,

    // Daily aggregates whose UTC day has ended by `at` (whole-day precision beyond the raw window).
    tx`
      SELECT prefix::text AS prefix, masklen(prefix) AS length, code, source, shippable, confidence,
             first_seen, last_seen
      FROM behavior_daily
      WHERE prefix >>= ${address}::inet
        AND ((day + 1)::timestamp AT TIME ZONE 'UTC') <= ${at}`,

    tx`
      SELECT prefix::text AS prefix, asn, org, country
      FROM network_interval
      WHERE prefix >>= ${address}::inet AND valid @> ${at}::timestamptz
      ORDER BY masklen(prefix) DESC
      LIMIT 1`,

    runs,
  ]);

  const excluded = new Set(excludeSources);
  const signals: Signal[] = [];
  const base = (row: { prefix: string; length: unknown; code: string; source: string; shippable: boolean }) => ({
    code: row.code,
    source: row.source,
    prefix: row.prefix,
    prefixLength: Number(row.length),
    shippable: row.shippable,
  });
  for (const row of categoryRows) {
    const firstSeen = asDate(row.first_seen);
    signals.push({
      kind: "category", ...base(row), firstSeen,
      lastSeen: categoryLastSeen(firstSeen, latest.get(row.source)),
      confidence: null,
    });
  }
  for (const row of sightingRows) {
    const firstSeen = asDate(row.first_seen);
    signals.push({
      kind: "behavior", ...base(row), firstSeen,
      lastSeen: episodeLastSeen({ firstSeen, lastSeen: asDate(row.last_seen), feedTime: row.feed_time }, latest.get(row.source)),
      confidence: asNumber(row.confidence),
    });
  }
  for (const row of dailyRows) {
    signals.push({
      kind: "behavior", ...base(row), firstSeen: asDate(row.first_seen), lastSeen: asDate(row.last_seen),
      confidence: asNumber(row.confidence),
    });
  }
  const builtin = builtinBogonSignal(ip, at);
  if (builtin) signals.push(builtin);

  const network: Network = networkRow
    ? {
        asn: asNumber(networkRow.asn),
        org: networkRow.org ?? null,
        prefix: networkRow.prefix,
        country: networkRow.country ? String(networkRow.country).trim() : null,
      }
    : { asn: null, org: null, prefix: null, country: null };

  return { signals: signals.filter((s) => !excluded.has(s.source)), network };
}

/**
 * Builds the signals for `ip` at evaluation time `at` from stored data, following the rules in
 * data-model.md ("Signal"). Only data committed at or before `at` counts, so a past `at`
 * reproduces the verdict that was current then (FR-004, FR-028–FR-031).
 */
export function gatherSignals(tx: SQL, ip: IpValue, at: Date, excludeSources: string[] = []): Promise<GatheredSignals> {
  return gather(tx, ip, at, excludeSources, latestRuns(tx, at));
}

const BATCH = 500;

/**
 * `gatherSignals` for many addresses, in input order. Addresses go to the server in batches
 * without waiting for each answer, so a batch costs about one round trip instead of one per
 * address (evaluations and snapshot validation score hundreds to thousands of addresses).
 */
export async function gatherSignalsMany(
  tx: SQL,
  ips: IpValue[],
  at: Date,
  excludeSources: string[] = [],
): Promise<GatheredSignals[]> {
  if (ips.length === 0) return [];
  const runs = latestRuns(tx, at);
  const out: GatheredSignals[] = [];
  for (let i = 0; i < ips.length; i += BATCH) {
    out.push(...await Promise.all(ips.slice(i, i + BATCH).map((ip) => gather(tx, ip, at, excludeSources, runs))));
  }
  return out;
}
