import type { SQL } from "bun";
import { FEEDS } from "../feeds/registry";
import { toIpValue } from "../ip/parse";
import { gatherSignals } from "../lookup/signals";
import type { Level, ScoringConfig } from "../model/types";
import { score } from "../scoring/score";
import { representativeAddress } from "./addresses";
import { orderKey } from "./sample";

const DAY = 86_400_000;
const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

export type FeedContribution = {
  feed: string;
  kind: "behavior" | "category";
  active: number;
  sampled: number;
  keepMedium: number;
  keepHigh: number;
  dropBelowMedium: number;
};

/** Distinct prefixes a feed has active at `at`: behavior listings overlapping the window, or category intervals valid then. */
async function activePrefixes(tx: SQL, feed: string, kind: "behavior" | "category", at: Date, since: Date, label: string, limit: number) {
  if (kind === "behavior") {
    const [{ n }] = await tx`
      SELECT count(DISTINCT prefix)::int AS n FROM behavior_sighting
      WHERE source = ${feed} AND recorded_at <= ${at} AND last_seen > ${since}`;
    const rows = await tx`
      SELECT prefix::text AS prefix FROM behavior_sighting
      WHERE source = ${feed} AND recorded_at <= ${at} AND last_seen > ${since}
      GROUP BY prefix ORDER BY ${orderKey(tx, label, feed)} LIMIT ${limit}`;
    return { active: Number(n), prefixes: (rows as { prefix: string }[]).map((r) => r.prefix) };
  }
  const [{ n }] = await tx`
    SELECT count(DISTINCT prefix)::int AS n FROM category_interval WHERE source = ${feed} AND valid @> ${at}::timestamptz`;
  const rows = await tx`
    SELECT prefix::text AS prefix FROM category_interval WHERE source = ${feed} AND valid @> ${at}::timestamptz
    GROUP BY prefix ORDER BY ${orderKey(tx, label, feed)} LIMIT ${limit}`;
  return { active: Number(n), prefixes: (rows as { prefix: string }[]).map((r) => r.prefix) };
}

/**
 * What each feed adds beyond the others (spec 003 US4, research R5): a deterministic sample of its
 * active entries, each scored at `at` with and without that feed. One result list per config.
 */
export async function feedContribution(
  tx: SQL,
  opts: { at: Date; windowDays: number; perFeed: number; dataVersionLabel: string; configs: ScoringConfig[]; now: Date },
): Promise<FeedContribution[][]> {
  const since = new Date(opts.at.getTime() - opts.windowDays * DAY);
  const out: FeedContribution[][] = opts.configs.map(() => []);
  for (const def of FEEDS) {
    if (def.kind === "network") continue;
    const kind = def.kind;
    const { active, prefixes } = await activePrefixes(tx, def.id, kind, opts.at, since, opts.dataVersionLabel, opts.perFeed);
    const rows = opts.configs.map(() => ({ feed: def.id, kind, active, sampled: prefixes.length, keepMedium: 0, keepHigh: 0, dropBelowMedium: 0 }));
    for (const prefix of prefixes) {
      const ip = toIpValue(representativeAddress(prefix));
      if ("error" in ip) throw new Error(`prefix ${prefix}: ${ip.error}`);
      const withFeed = (await gatherSignals(tx, ip, opts.at)).signals;
      const without = (await gatherSignals(tx, ip, opts.at, [def.id])).signals;
      opts.configs.forEach((config, i) => {
        const a = score(withFeed, config, opts.at, opts.now).level;
        const b = score(without, config, opts.at, opts.now).level;
        const row = rows[i]!;
        if (RANK[b] >= RANK.medium) row.keepMedium++;
        if (RANK[b] >= RANK.high) row.keepHigh++;
        if (RANK[a] >= RANK.medium && RANK[b] < RANK.medium) row.dropBelowMedium++;
      });
    }
    rows.forEach((row, i) => out[i]!.push(row));
  }
  return out;
}
