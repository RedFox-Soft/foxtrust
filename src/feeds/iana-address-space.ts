import { BITS, formatCidr, parseCidr, rangeToCidrs, type Cidr } from "../ip/cidr";
import { coveredBySpecialPurposeBogon } from "../ip/special-purpose";
import { csvRecords } from "./csv";
import { decodeText, FeedParseError, type CategoryEntry, type FeedDefinition } from "./types";

const BASE = "https://www.iana.org/assignments";
const GLOBAL_UNICAST = parseCidr("2000::/3")!;

/** "001/8" → 1.0.0.0/8 (the registry writes the first octet with leading zeros). */
function ipv4Block(prefix: string): Cidr | null {
  const match = /^(\d{1,3})\/8$/.exec(prefix);
  if (!match) return null;
  const octet = Number(match[1]);
  return octet <= 255 ? parseCidr(`${octet}.0.0.0/8`) : null;
}

const cidrEnd = (c: Cidr) => c.network + (1n << BigInt(BITS[c.family] - c.length)) - 1n;


/** Subtracts allocated ranges from [start, end] and returns the remaining ranges. */
function subtract(start: bigint, end: bigint, allocated: [bigint, bigint][]): [bigint, bigint][] {
  const sorted = [...allocated].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: [bigint, bigint][] = [];
  let cursor = start;
  for (const [s, e] of sorted) {
    if (e < cursor || s > end) continue;
    if (s > cursor) out.push([cursor, s - 1n]);
    if (e + 1n > cursor) cursor = e + 1n;
    if (cursor > end) break;
  }
  if (cursor <= end) out.push([cursor, end]);
  return out;
}

/**
 * IANA IPv4 address space + IPv6 unicast assignments (CC0): space that is reserved or not
 * allocated at IANA level becomes `bogon` (research R6). Blocks fully inside a built-in
 * special-purpose bogon are skipped so the same fact is not counted twice.
 */
export const ianaAddressSpace: FeedDefinition = {
  id: "iana-address-space",
  kind: "category",
  codes: ["bogon"],
  schedule: "15 5 * * *",
  timestamps: "run",
  files: [
    { name: "ipv4-address-space.csv", url: `${BASE}/ipv4-address-space/ipv4-address-space.csv` },
    { name: "ipv6-unicast-address-assignments.csv", url: `${BASE}/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv` },
  ],
  parse(files) {
    const entries: CategoryEntry[] = [];
    let invalidLines = 0;
    const byName = new Map(files.map((f) => [f.name, decodeText(f.body)]));

    const v4 = csvRecords(byName.get("ipv4-address-space.csv") ?? "");
    if (v4.length === 0 || !("Prefix" in v4[0]!)) throw new FeedParseError("ipv4-address-space.csv: no Prefix column");
    for (const row of v4) {
      const block = ipv4Block(row.Prefix ?? "");
      const status = (row["Status [1]"] ?? row.Status ?? "").toUpperCase();
      if (!block || !status) {
        invalidLines++;
        continue;
      }
      if (status === "RESERVED" && !coveredBySpecialPurposeBogon(block)) entries.push({ prefix: formatCidr(block), code: "bogon" });
    }

    const v6 = csvRecords(byName.get("ipv6-unicast-address-assignments.csv") ?? "");
    if (v6.length === 0 || !("Prefix" in v6[0]!)) {
      throw new FeedParseError("ipv6-unicast-address-assignments.csv: no Prefix column");
    }
    const allocated: [bigint, bigint][] = [];
    for (const row of v6) {
      const block = parseCidr(row.Prefix ?? "");
      if (!block || block.family !== 6) {
        invalidLines++;
        continue;
      }
      if ((row.Status ?? "").toUpperCase() === "ALLOCATED") allocated.push([block.network, cidrEnd(block)]);
    }
    if (allocated.length === 0) throw new FeedParseError("ipv6-unicast-address-assignments.csv: no ALLOCATED rows");
    for (const [s, e] of subtract(GLOBAL_UNICAST.network, cidrEnd(GLOBAL_UNICAST), allocated)) {
      for (const cidr of rangeToCidrs({ family: 6, value: s }, { family: 6, value: e })) {
        if (!coveredBySpecialPurposeBogon(cidr)) entries.push({ prefix: formatCidr(cidr), code: "bogon" });
      }
    }
    return { entries, invalidLines };
  },
};
