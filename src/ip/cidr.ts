import { formatIp, parseIpv4, parseIpv6, unwrapMapped, type Family, type IpValue } from "./parse";

export type Cidr = { family: Family; network: bigint; length: number };

export const BITS: Record<Family, number> = { 4: 32, 6: 128 };

function mask(family: Family, length: number): bigint {
  const bits = BigInt(BITS[family]);
  const host = bits - BigInt(length);
  return ((1n << bits) - 1n) ^ ((1n << host) - 1n);
}

function parseAddress(text: string): IpValue | null {
  if (text.includes(":")) {
    const value = parseIpv6(text);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { family: 4, value };
}

/**
 * Parses `a.b.c.d/n`, `x::/n`, or a bare address (host prefix).
 * With `allowHostBits`, host bits are cleared instead of rejected (feeds are not always tidy).
 * IPv4-mapped IPv6 prefixes (::ffff:0:0/96 and longer) become IPv4 prefixes.
 */
export function parseCidr(text: string, options: { allowHostBits?: boolean } = {}): Cidr | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf("/");
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const address = parseAddress(addressText);
  if (address === null) return null;

  let length = BITS[address.family];
  if (slash !== -1) {
    const lengthText = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(lengthText)) return null;
    length = Number(lengthText);
    if (length > BITS[address.family]) return null;
  }

  const network = address.value & mask(address.family, length);
  if (network !== address.value && !options.allowHostBits) return null;

  if (address.family === 6 && length >= 96 && network >> 32n === 0xffffn) {
    const v4 = unwrapMapped({ family: 6, value: network });
    return { family: 4, network: v4.value, length: length - 96 };
  }
  return { family: address.family, network, length };
}

export function formatCidr(cidr: Cidr): string {
  return `${formatIp({ family: cidr.family, value: cidr.network })}/${cidr.length}`;
}

export function hostCidr(ip: IpValue): Cidr {
  return { family: ip.family, network: ip.value, length: BITS[ip.family] };
}

export function contains(cidr: Cidr, ip: IpValue): boolean {
  if (cidr.family !== ip.family) return false;
  return (ip.value & mask(cidr.family, cidr.length)) === cidr.network;
}

/** Minimal set of CIDR blocks that exactly covers the inclusive range [start, end]. */
export function rangeToCidrs(start: IpValue, end: IpValue): Cidr[] {
  if (start.family !== end.family) throw new Error("range endpoints are of different families");
  if (start.value > end.value) throw new Error("range start is after range end");
  const family = start.family;
  const bits = BITS[family];
  const out: Cidr[] = [];
  let current = start.value;
  while (current <= end.value) {
    // Largest block aligned at `current`.
    let hostBits = 0;
    while (hostBits < bits && ((current >> BigInt(hostBits)) & 1n) === 0n) hostBits++;
    // Shrink until the block fits inside the range.
    while (hostBits > 0 && current + (1n << BigInt(hostBits)) - 1n > end.value) hostBits--;
    out.push({ family, network: current, length: bits - hostBits });
    current += 1n << BigInt(hostBits);
  }
  return out;
}
