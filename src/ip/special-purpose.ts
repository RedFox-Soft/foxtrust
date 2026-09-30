import { contains, parseCidr, type Cidr } from "./cidr";
import type { IpValue } from "./parse";

/**
 * IANA IPv4 and IPv6 Special-Purpose Address Registries, plus the multicast blocks
 * (RFC 5771, RFC 4291) that the spec also treats as bogons.
 * Source: https://www.iana.org/assignments/iana-ipv4-special-registry/ and
 * https://www.iana.org/assignments/iana-ipv6-special-registry/, transcribed on this date.
 */
export const REGISTRY_SNAPSHOT_DATE = "2026-09-24";

export type SpecialPurposeEntry = {
  cidr: string;
  name: string;
  rfc: string;
  /** "Globally Reachable" from the registry. Globally reachable blocks are not bogons. */
  globallyReachable: boolean;
};

const ENTRIES: SpecialPurposeEntry[] = [
  // IPv4
  { cidr: "0.0.0.0/8", name: "This network", rfc: "RFC 791", globallyReachable: false },
  { cidr: "0.0.0.0/32", name: "This host on this network", rfc: "RFC 1122", globallyReachable: false },
  { cidr: "10.0.0.0/8", name: "Private-Use", rfc: "RFC 1918", globallyReachable: false },
  { cidr: "100.64.0.0/10", name: "Shared Address Space", rfc: "RFC 6598", globallyReachable: false },
  { cidr: "127.0.0.0/8", name: "Loopback", rfc: "RFC 1122", globallyReachable: false },
  { cidr: "169.254.0.0/16", name: "Link Local", rfc: "RFC 3927", globallyReachable: false },
  { cidr: "172.16.0.0/12", name: "Private-Use", rfc: "RFC 1918", globallyReachable: false },
  { cidr: "192.0.0.0/24", name: "IETF Protocol Assignments", rfc: "RFC 6890", globallyReachable: false },
  { cidr: "192.0.0.0/29", name: "IPv4 Service Continuity Prefix", rfc: "RFC 7335", globallyReachable: false },
  { cidr: "192.0.0.8/32", name: "IPv4 dummy address", rfc: "RFC 7600", globallyReachable: false },
  { cidr: "192.0.0.9/32", name: "Port Control Protocol Anycast", rfc: "RFC 7723", globallyReachable: true },
  { cidr: "192.0.0.10/32", name: "TURN Anycast", rfc: "RFC 8155", globallyReachable: true },
  { cidr: "192.0.0.170/32", name: "NAT64/DNS64 Discovery", rfc: "RFC 8880", globallyReachable: false },
  { cidr: "192.0.0.171/32", name: "NAT64/DNS64 Discovery", rfc: "RFC 8880", globallyReachable: false },
  { cidr: "192.0.2.0/24", name: "Documentation (TEST-NET-1)", rfc: "RFC 5737", globallyReachable: false },
  { cidr: "192.31.196.0/24", name: "AS112-v4", rfc: "RFC 7535", globallyReachable: true },
  { cidr: "192.52.193.0/24", name: "AMT", rfc: "RFC 7450", globallyReachable: true },
  { cidr: "192.88.99.0/24", name: "Deprecated (6to4 Relay Anycast)", rfc: "RFC 7526", globallyReachable: false },
  { cidr: "192.88.99.2/32", name: "6a44-relay anycast address", rfc: "RFC 6751", globallyReachable: false },
  { cidr: "192.168.0.0/16", name: "Private-Use", rfc: "RFC 1918", globallyReachable: false },
  { cidr: "192.175.48.0/24", name: "Direct Delegation AS112 Service", rfc: "RFC 7534", globallyReachable: true },
  { cidr: "198.18.0.0/15", name: "Benchmarking", rfc: "RFC 2544", globallyReachable: false },
  { cidr: "198.51.100.0/24", name: "Documentation (TEST-NET-2)", rfc: "RFC 5737", globallyReachable: false },
  { cidr: "203.0.113.0/24", name: "Documentation (TEST-NET-3)", rfc: "RFC 5737", globallyReachable: false },
  { cidr: "224.0.0.0/4", name: "Multicast", rfc: "RFC 5771", globallyReachable: false },
  { cidr: "240.0.0.0/4", name: "Reserved", rfc: "RFC 1112", globallyReachable: false },
  { cidr: "255.255.255.255/32", name: "Limited Broadcast", rfc: "RFC 919", globallyReachable: false },
  // IPv6
  { cidr: "::1/128", name: "Loopback Address", rfc: "RFC 4291", globallyReachable: false },
  { cidr: "::/128", name: "Unspecified Address", rfc: "RFC 4291", globallyReachable: false },
  { cidr: "64:ff9b::/96", name: "IPv4-IPv6 Translation", rfc: "RFC 6052", globallyReachable: true },
  { cidr: "64:ff9b:1::/48", name: "Local-Use IPv4-IPv6 Translation", rfc: "RFC 8215", globallyReachable: false },
  { cidr: "100::/64", name: "Discard-Only Address Block", rfc: "RFC 6666", globallyReachable: false },
  { cidr: "100:0:0:1::/64", name: "Dummy IPv6 Prefix", rfc: "RFC 9780", globallyReachable: false },
  { cidr: "2001::/23", name: "IETF Protocol Assignments", rfc: "RFC 2928", globallyReachable: false },
  { cidr: "2001::/32", name: "TEREDO", rfc: "RFC 4380", globallyReachable: true },
  { cidr: "2001:1::1/128", name: "Port Control Protocol Anycast", rfc: "RFC 7723", globallyReachable: true },
  { cidr: "2001:1::2/128", name: "TURN Anycast", rfc: "RFC 8155", globallyReachable: true },
  { cidr: "2001:1::3/128", name: "DNS-SD SRP Anycast", rfc: "RFC 9665", globallyReachable: true },
  { cidr: "2001:2::/48", name: "Benchmarking", rfc: "RFC 5180", globallyReachable: false },
  { cidr: "2001:3::/32", name: "AMT", rfc: "RFC 7450", globallyReachable: true },
  { cidr: "2001:4:112::/48", name: "AS112-v6", rfc: "RFC 7535", globallyReachable: true },
  { cidr: "2001:10::/28", name: "Deprecated (previously ORCHID)", rfc: "RFC 4843", globallyReachable: false },
  { cidr: "2001:20::/28", name: "ORCHIDv2", rfc: "RFC 7343", globallyReachable: true },
  { cidr: "2001:30::/28", name: "Drone Remote ID Protocol Entity Tags", rfc: "RFC 9374", globallyReachable: true },
  { cidr: "2001:db8::/32", name: "Documentation", rfc: "RFC 3849", globallyReachable: false },
  { cidr: "2002::/16", name: "6to4", rfc: "RFC 3056", globallyReachable: true },
  { cidr: "2620:4f:8000::/48", name: "Direct Delegation AS112 Service", rfc: "RFC 7534", globallyReachable: true },
  { cidr: "3fff::/20", name: "Documentation", rfc: "RFC 9637", globallyReachable: false },
  { cidr: "5f00::/16", name: "Segment Routing (SRv6) SIDs", rfc: "RFC 9602", globallyReachable: false },
  { cidr: "fc00::/7", name: "Unique-Local", rfc: "RFC 4193", globallyReachable: false },
  { cidr: "fe80::/10", name: "Link-Local Unicast", rfc: "RFC 4291", globallyReachable: false },
  { cidr: "ff00::/8", name: "Multicast", rfc: "RFC 4291", globallyReachable: false },
];

const PARSED: { entry: SpecialPurposeEntry; cidr: Cidr }[] = ENTRIES.map((entry) => {
  const cidr = parseCidr(entry.cidr);
  if (cidr === null) throw new Error(`bad special-purpose CIDR ${entry.cidr}`);
  return { entry, cidr };
});

/**
 * The most specific registry entry containing `ip`, or null. The entry is a bogon unless it is
 * globally reachable (e.g. 192.0.0.9/32 inside 192.0.0.0/24).
 */
export function specialPurpose(ip: IpValue): SpecialPurposeEntry | null {
  let best: { entry: SpecialPurposeEntry; cidr: Cidr } | null = null;
  for (const item of PARSED) {
    if (contains(item.cidr, ip) && (best === null || item.cidr.length > best.cidr.length)) best = item;
  }
  return best?.entry ?? null;
}

export function isSpecialPurposeBogon(ip: IpValue): SpecialPurposeEntry | null {
  const entry = specialPurpose(ip);
  return entry !== null && !entry.globallyReachable ? entry : null;
}

/** True when some non-globally-reachable registry entry contains the whole block `cidr`. */
export function coveredBySpecialPurposeBogon(cidr: Cidr): boolean {
  return PARSED.some(
    ({ entry, cidr: e }) =>
      !entry.globallyReachable &&
      e.family === cidr.family &&
      e.length <= cidr.length &&
      contains(e, { family: cidr.family, value: cidr.network }),
  );
}

/** All registry entries (bogon and globally reachable), for building snapshots. */
export function specialPurposeEntries(): readonly SpecialPurposeEntry[] {
  return ENTRIES;
}
