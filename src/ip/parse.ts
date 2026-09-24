export type Family = 4 | 6;

/** An address as a number: 32 bits for IPv4, 128 bits for IPv6. */
export type IpValue = { family: Family; value: bigint };

export type ParseIpResult =
  | { ok: true; ip: string; family: Family }
  | { ok: false; message: string };


/** Strict dotted quad: four decimal octets 0–255, no leading zeros. */
export function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null; // ambiguous (octal in some parsers)
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** IPv6 with optional `::` and an optional trailing dotted-quad group. No zone id. */
export function parseIpv6(text: string): bigint | null {
  if (text.length === 0) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string, allowIpv4Tail: boolean): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      const isLast = i === groups.length - 1;
      if (isLast && allowIpv4Tail && group.includes(".")) {
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0]!, false);
    const tail = parseGroups(halves[1]!, true);
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const all = parseGroups(text, true);
    if (all === null || all.length !== 8) return null;
    groups = all;
  }

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) becomes the IPv4 address it wraps. */
export function unwrapMapped(ip: IpValue): IpValue {
  if (ip.family === 6 && ip.value >> 32n === 0xffffn) {
    return { family: 4, value: ip.value & 0xffffffffn };
  }
  return ip;
}

export function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** RFC 5952: lower case, no leading zeros, longest zero run (first on a tie, length ≥ 2) as `::`. */
export function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn));

  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

export function formatIp(ip: IpValue): string {
  return ip.family === 4 ? formatIpv4(ip.value) : formatIpv6(ip.value);
}

/** Parses user input into a normalised address, or explains why it is not one. */
export function toIpValue(input: string): IpValue | { error: string } {
  const text = input.trim();
  if (text === "") return { error: "empty input" };
  if (text.includes("/")) return { error: "CIDR notation is not accepted; pass a single address" };

  if (text.includes(":")) {
    const zoneAt = text.indexOf("%");
    const bare = zoneAt === -1 ? text : text.slice(0, zoneAt);
    if (zoneAt !== -1 && zoneAt === text.length - 1) return { error: "empty IPv6 zone id" };
    const value = parseIpv6(bare);
    if (value === null) return { error: `not a valid IPv6 address: ${JSON.stringify(input)}` };
    return unwrapMapped({ family: 6, value });
  }

  if (text.includes("%")) return { error: "zone ids are only valid for IPv6" };
  const value = parseIpv4(text);
  if (value === null) {
    const hasLeadingZero = text.split(".").some((p) => p.length > 1 && p.startsWith("0"));
    return {
      error: hasLeadingZero
        ? `IPv4 octets with leading zeros are ambiguous: ${JSON.stringify(input)}`
        : `not a valid IPv4 address: ${JSON.stringify(input)}`,
    };
  }
  return { family: 4, value };
}

export function parseIp(input: string): ParseIpResult {
  const parsed = toIpValue(input);
  if ("error" in parsed) return { ok: false, message: parsed.error };
  return { ok: true, ip: formatIp(parsed), family: parsed.family };
}

