import type { SQL } from "bun";
import { toIpValue } from "../ip/parse";
import { gatherSignalsMany } from "../lookup/signals";
import type { ScoringConfig } from "../model/types";
import { score } from "../scoring/score";
import { representativeAddress } from "./addresses";
import { levelShares, type ByLevel, type Scored } from "./metrics";

const DAY = 86_400_000;

export type NewAddress = { ip: string; prefix: string; feed: string };

export type EarlyDetection = {
  moment: string;
  windowDays: number;
  found: number;
} & ByLevel<{ count: number; share: number }>;

export type EarlyDetectionByFeed = EarlyDetection & { byFeed: Record<string, Omit<EarlyDetection, "moment" | "windowDays">> };

/** The moment cannot be measured: its window is not over yet, or it is older than the raw data. */
export class EarlyDetectionRefused extends Error {
  constructor(
    message: string,
    readonly validMoment: Date,
  ) {
    super(message);
  }
}

/** Throws EarlyDetectionRefused unless `moment + window <= now` and `moment >= now − rawDays` (FR-013). */
export function assertMeasurable(moment: Date, windowDays: number, now: Date, rawDays: number): void {
  const latest = new Date(now.getTime() - windowDays * DAY);
  const oldest = new Date(now.getTime() - rawDays * DAY);
  if (moment.getTime() > latest.getTime()) {
    throw new EarlyDetectionRefused(
      `early detection for ${moment.toISOString()} needs its ${windowDays}-day window to be over; the latest measurable moment is ${latest.toISOString()}`,
      latest,
    );
  }
  if (moment.getTime() < oldest.getTime()) {
    throw new EarlyDetectionRefused(
      `early detection for ${moment.toISOString()} reaches past the ${rawDays}-day raw behavior data; the oldest measurable moment is ${oldest.toISOString()}`,
      oldest,
    );
  }
}

/**
 * Addresses first recorded by a behavior feed in `(moment, moment + window]` and not covered by any
 * behavior sighting recorded at or before `moment` (research R4). `recorded_at` is used: what
 * counts is when FoxTrust learned of the address. With `shippableOnly`, only shippable sightings
 * count, for public outputs (Principle III).
 */
export async function findNewAddresses(
  tx: SQL,
  opts: { moment: Date; windowDays: number; shippableOnly?: boolean },
): Promise<NewAddress[]> {
  const end = new Date(opts.moment.getTime() + opts.windowDays * DAY);
  const shippableOnly = opts.shippableOnly ?? false;
  // `rep` is the representative address of research R3 (the host itself, or network + 1), as /32 or /128.
  const rows = (await tx`
    WITH firsts AS (
      SELECT DISTINCT ON (prefix) prefix, source, recorded_at FROM behavior_sighting
      WHERE recorded_at <= ${end} AND (shippable OR NOT ${shippableOnly})
      ORDER BY prefix, recorded_at, source
    ), fresh AS (
      SELECT prefix, source,
             CASE WHEN masklen(prefix) = CASE family(prefix) WHEN 4 THEN 32 ELSE 128 END
                  THEN host(prefix)::inet ELSE host(network(prefix)::inet + 1)::inet END AS rep
      FROM firsts WHERE recorded_at > ${opts.moment}
    )
    SELECT prefix::text AS prefix, source FROM fresh n
    WHERE NOT EXISTS (
      SELECT 1 FROM behavior_sighting e
      WHERE e.prefix >>= n.rep AND e.recorded_at <= ${opts.moment} AND (e.shippable OR NOT ${shippableOnly}))
    ORDER BY prefix`) as { prefix: string; source: string }[];
  return rows.map(({ prefix, source }) => ({ ip: representativeAddress(prefix), prefix, feed: source }));
}

/** Shares of `found` rated at least `medium` / `high`, with counts. */
export function summarize(moment: Date, windowDays: number, scored: Scored[]): EarlyDetection {
  return { moment: moment.toISOString(), windowDays, found: scored.length, ...levelShares(scored) };
}

/** Internal early detection for one configuration: the verdict at `moment`, overall and per first-reporting feed. */
export async function internalEarlyDetection(
  tx: SQL,
  found: NewAddress[],
  opts: { moment: Date; windowDays: number; config: ScoringConfig; now: Date },
): Promise<EarlyDetectionByFeed> {
  const values = found.map((address) => {
    const value = toIpValue(address.ip);
    if ("error" in value) throw new Error(`address ${address.ip}: ${value.error}`);
    return value;
  });
  const gathered = await gatherSignalsMany(tx, values, opts.moment);
  const scored: (Scored & { feed: string })[] = found.map((address, i) => {
    const result = score(gathered[i]!.signals, opts.config, opts.moment, opts.now);
    return { ip: address.ip, feed: address.feed, level: result.level, risk: result.risk };
  });
  const byFeed: EarlyDetectionByFeed["byFeed"] = {};
  for (const feed of [...new Set(scored.map((s) => s.feed))].sort()) {
    const { moment: _m, windowDays: _w, ...rest } = summarize(opts.moment, opts.windowDays, scored.filter((s) => s.feed === feed));
    byFeed[feed] = rest;
  }
  return { ...summarize(opts.moment, opts.windowDays, scored), byFeed };
}
