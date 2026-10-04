import type { SQL } from "bun";
import { contains, parseCidr } from "../ip/cidr";
import { toIpValue } from "../ip/parse";
import { behaviorFeedIds, representativeAddress } from "./addresses";
import type { KnownGoodEntry } from "./known-good";

const DAY = 86_400_000;

export type SampledAddress = { ip: string; prefix: string; feed: string };

export type SampleSummary = {
  windowDays: number;
  perFeed: number;
  method: string;
  byFeed: Record<string, { size: number; noSample?: true }>;
  /** Sampled prefixes that cover a known-good address; left out of both measures. */
  conflicts: { prefix: string; feed: string; knownGood: string[] }[];
};

export const SAMPLE_METHOD =
  "Per behavior feed, prefixes recorded at or before the evaluation time and last seen inside the window, " +
  "ordered by md5(data version | feed | prefix) and cut at the per-feed size; each address is scored at the " +
  "evaluation time without the feed it was sampled from.";

/**
 * SQL fragment shared by every deterministic sample (research R3): one stable order per data
 * version, so two configurations and two runs see the same rows.
 */
export const orderKey = (sql: SQL, dataVersionLabel: string, source: string) =>
  sql`md5(${dataVersionLabel} || '|' || ${source} || '|' || prefix::text)`;

/**
 * Fresh known-bad sample at `at` (spec 003 FR-008, FR-009): per behavior feed, the prefixes it had
 * recorded by `at` whose listing overlaps `(at − window, at]`.
 */
export async function drawSample(
  tx: SQL,
  opts: { at: Date; windowDays: number; perFeed: number; dataVersionLabel: string; knownGood: KnownGoodEntry[] },
): Promise<{ addresses: SampledAddress[]; summary: SampleSummary }> {
  const since = new Date(opts.at.getTime() - opts.windowDays * DAY);
  const good = opts.knownGood.map((g) => ({ ip: g.ip, value: toIpValue(g.ip) }));
  const addresses: SampledAddress[] = [];
  const summary: SampleSummary = { windowDays: opts.windowDays, perFeed: opts.perFeed, method: SAMPLE_METHOD, byFeed: {}, conflicts: [] };

  for (const feed of behaviorFeedIds()) {
    const rows = await tx`
      SELECT prefix::text AS prefix FROM behavior_sighting
      WHERE source = ${feed} AND recorded_at <= ${opts.at} AND last_seen > ${since}
      GROUP BY prefix
      ORDER BY ${orderKey(tx, opts.dataVersionLabel, feed)}
      LIMIT ${opts.perFeed}`;
    let size = 0;
    for (const { prefix } of rows as { prefix: string }[]) {
      const cidr = parseCidr(prefix, { allowHostBits: true })!;
      const covered = good.filter((g) => !("error" in g.value) && contains(cidr, g.value)).map((g) => g.ip);
      if (covered.length > 0) {
        summary.conflicts.push({ prefix, feed, knownGood: covered });
        continue;
      }
      addresses.push({ ip: representativeAddress(prefix), prefix, feed });
      size++;
    }
    summary.byFeed[feed] = size > 0 ? { size } : { size: 0, noSample: true };
  }
  return { addresses, summary };
}
