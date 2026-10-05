import type { SQL } from "bun";
import { BITS, parseCidr } from "../ip/cidr";
import { formatIp, type IpValue } from "../ip/parse";
import { isSpecialPurposeBogon } from "../ip/special-purpose";
import type { Network, Signal } from "../model/types";

export const BUILTIN_BOGON_SOURCE = "iana-special-purpose";

export type GatheredSignals = { signals: Signal[]; network: Network };

const SUCCESS = ["applied", "unchanged"];
const asDate = (v: unknown) => new Date(v as string | Date);
const asNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Builds the signals for `ip` at evaluation time `at` from stored data, following the rules in
 * data-model.md ("Signal"). Only data committed at or before `at` counts, so a past `at`
 * reproduces the verdict that was current then (FR-004, FR-028–FR-031).
 */
export async function gatherSignals(
  tx: SQL,
  ip: IpValue,
  at: Date,
  excludeSources: string[] = [],
): Promise<GatheredSignals> {
  const address = formatIp(ip);

  // The four reads are independent; sent together they cost one round trip, not four.
  const [categoryRows, sightingRows, dailyRows, [networkRow]] = await Promise.all([
    // Categories: interval valid at `at`. lastSeen is the latest successful run of the feed at or
    // before `at`: every such run since the interval opened listed the prefix, or it would have closed.
    tx`
      SELECT ci.prefix::text AS prefix, masklen(ci.prefix) AS length, ci.code, ci.source, ci.shippable,
             lower(ci.valid) AS first_seen,
             GREATEST(lower(ci.valid), (SELECT max(fr.committed_at) FROM feed_run fr
                                        WHERE fr.feed_id = ci.source AND fr.status IN ${tx(SUCCESS)}
                                          AND fr.committed_at <= ${at})) AS last_seen
      FROM category_interval ci
      WHERE ci.prefix >>= ${address}::inet AND ci.valid @> ${at}::timestamptz`,

    // Raw behavior observations recorded by `at`. For listing episodes, the latest observation at
    // or before `at` is the latest successful run of the feed at or before `at` (research R3).
    // Feed-provided times are used as they are (a future time is clamped to `at` by the scorer).
    tx`
      SELECT s.prefix::text AS prefix, masklen(s.prefix) AS length, s.code, s.source, s.shippable,
             s.confidence, s.first_seen,
             CASE WHEN s.feed_time THEN s.last_seen
                  ELSE LEAST(s.last_seen, COALESCE((SELECT max(fr.committed_at) FROM feed_run fr
                                                   WHERE fr.feed_id = s.source AND fr.status IN ${tx(SUCCESS)}
                                                     AND fr.committed_at <= ${at}), s.first_seen))
             END AS last_seen
      FROM behavior_sighting s
      WHERE s.prefix >>= ${address}::inet AND s.recorded_at <= ${at}`,

    // Daily aggregates whose UTC day has ended by `at` (whole-day precision beyond the raw window).
    tx`
      SELECT d.prefix::text AS prefix, masklen(d.prefix) AS length, d.code, d.source, d.shippable,
             d.confidence, d.first_seen, d.last_seen
      FROM behavior_daily d
      WHERE d.prefix >>= ${address}::inet
        AND ((d.day + 1)::timestamp AT TIME ZONE 'UTC') <= ${at}`,

    tx`
      SELECT prefix::text AS prefix, asn, org, country
      FROM network_interval
      WHERE prefix >>= ${address}::inet AND valid @> ${at}::timestamptz
      ORDER BY masklen(prefix) DESC
      LIMIT 1`,
  ]);

  const excluded = new Set(excludeSources);
  const signals: Signal[] = [];
  for (const row of categoryRows) {
    signals.push({
      kind: "category",
      code: row.code,
      source: row.source,
      prefix: row.prefix,
      prefixLength: Number(row.length),
      firstSeen: asDate(row.first_seen),
      lastSeen: asDate(row.last_seen),
      confidence: null,
      shippable: row.shippable,
    });
  }
  for (const row of [...sightingRows, ...dailyRows]) {
    signals.push({
      kind: "behavior",
      code: row.code,
      source: row.source,
      prefix: row.prefix,
      prefixLength: Number(row.length),
      firstSeen: asDate(row.first_seen),
      lastSeen: asDate(row.last_seen),
      confidence: asNumber(row.confidence),
      shippable: row.shippable,
    });
  }

  const builtin = isSpecialPurposeBogon(ip);
  if (builtin) {
    const cidr = parseCidr(builtin.cidr)!;
    signals.push({
      kind: "category",
      code: "bogon",
      source: BUILTIN_BOGON_SOURCE,
      prefix: builtin.cidr,
      prefixLength: cidr.family === ip.family ? cidr.length : BITS[ip.family],
      firstSeen: at,
      lastSeen: at,
      confidence: null,
      shippable: true,
    });
  }

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
  const out: GatheredSignals[] = [];
  for (let i = 0; i < ips.length; i += BATCH) {
    out.push(...await Promise.all(ips.slice(i, i + BATCH).map((ip) => gatherSignals(tx, ip, at, excludeSources))));
  }
  return out;
}
