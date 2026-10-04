import { FEEDS } from "../feeds/registry";
import type { FeedKind } from "../feeds/types";
import { BITS, parseCidr } from "../ip/cidr";
import { formatIp } from "../ip/parse";

/** Feeds whose entries are known-bad evidence: kind `behavior` (spec 003 research R2). */
export const behaviorFeedIds = (): string[] => feedIdsOfKind("behavior");

export const feedIdsOfKind = (...kinds: FeedKind[]): string[] =>
  FEEDS.filter((f) => kinds.includes(f.kind)).map((f) => f.id);

/**
 * The address that stands for a stored prefix: the prefix itself for a host prefix, otherwise the
 * first address after the network address (research R3). Every host of the prefix gets the same
 * signals from the feed that stored it, so the choice only has to be stable.
 */
export function representativeAddress(prefix: string): string {
  const cidr = parseCidr(prefix, { allowHostBits: true });
  if (!cidr) throw new Error(`invalid prefix ${prefix}`);
  const hostBits = BITS[cidr.family] - cidr.length;
  const value = hostBits === 0 ? cidr.network : cidr.network + 1n;
  return formatIp({ family: cidr.family, value });
}
