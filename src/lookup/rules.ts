import { BITS, parseCidr } from "../ip/cidr";
import type { IpValue } from "../ip/parse";
import { isSpecialPurposeBogon } from "../ip/special-purpose";
import type { Signal } from "../model/types";

/**
 * Rules that turn stored rows into signals at evaluation time `at` (data-model.md, "Signal").
 * The queries only select the rows valid at `at`; every decision about times is made here, once,
 * for lookups and snapshots alike.
 */

export const BUILTIN_BOGON_SOURCE = "iana-special-purpose";

/** Each feed's latest successful run (`applied` or `unchanged`) at or before `at`. */
export type LatestRuns = ReadonlyMap<string, Date>;

const later = (a: Date, b: Date | undefined) => (b !== undefined && b > a ? b : a);
const earlier = (a: Date, b: Date) => (b < a ? b : a);

/**
 * A category interval valid at `at` was listed by every successful run of its feed since it opened,
 * or it would have closed: its lastSeen is the feed's latest run, never before the interval began.
 */
export function categoryLastSeen(firstSeen: Date, latestRun: Date | undefined): Date {
  return later(firstSeen, latestRun);
}

/**
 * A listing episode was last observed by the feed's latest run at or before `at`, but not after the
 * episode ended (`lastSeen`); without such a run, at its start. Feed-provided times stay as they are
 * (a future time is clamped to `at` by the scorer).
 */
export function episodeLastSeen(
  episode: { firstSeen: Date; lastSeen: Date; feedTime: boolean },
  latestRun: Date | undefined,
): Date {
  return episode.feedTime ? episode.lastSeen : earlier(episode.lastSeen, latestRun ?? episode.firstSeen);
}

/** The built-in bogon signal of a special-purpose address, which needs no feed data. */
export function builtinBogonSignal(ip: IpValue, at: Date): Signal | null {
  const builtin = isSpecialPurposeBogon(ip);
  if (!builtin) return null;
  const cidr = parseCidr(builtin.cidr)!;
  return {
    kind: "category",
    code: "bogon",
    source: BUILTIN_BOGON_SOURCE,
    prefix: builtin.cidr,
    prefixLength: cidr.family === ip.family ? cidr.length : BITS[ip.family],
    firstSeen: at,
    lastSeen: at,
    confidence: null,
    shippable: true,
  };
}
