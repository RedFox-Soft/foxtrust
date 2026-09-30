import { contains, type Cidr } from "../ip/cidr";
import { toIpValue, type IpValue } from "../ip/parse";

/** At most this many X-Forwarded-For entries are examined (a long header is not a reason to spin). */
const MAX_FORWARDED_ENTRIES = 32;

const parse = (text: string): IpValue | null => {
  // "[2001:db8::1]:443" and "203.0.113.7:8080" forms appear in some proxies' headers.
  let t = text.trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(t);
  if (bracket) t = bracket[1]!;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(t)) t = t.slice(0, t.lastIndexOf(":"));
  const v = toIpValue(t);
  return "error" in v ? null : v;
};

const trusted = (ip: IpValue, proxies: Cidr[]) => proxies.some((c) => contains(c, ip));

/**
 * The client address for a forward-auth request (FR-019): the connection peer, unless the peer
 * is a trusted proxy; then the right-most X-Forwarded-For entry that is not a trusted proxy.
 * IPv4-mapped IPv6 is unwrapped. Returns null when no usable address exists.
 */
export function clientAddress(peer: string | null, forwardedFor: string | null, trustedProxies: Cidr[]): IpValue | null {
  const peerIp = peer ? parse(peer) : null;
  if (!peerIp) return null;
  if (!forwardedFor || !trusted(peerIp, trustedProxies)) return peerIp;

  const entries = forwardedFor.split(",").slice(-MAX_FORWARDED_ENTRIES);
  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = parse(entries[i]!);
    // An unparsable hop cannot be vouched for: stop at the last trusted address before it.
    if (!ip) break;
    if (!trusted(ip, trustedProxies)) return ip;
  }
  return peerIp;
}
