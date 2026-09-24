import { decodeText, parsePrefixList, type FeedDefinition, type ParsedEntry } from "./types";

const BASE = "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter";

/** X4BNet lists_vpn datacenter ranges (MIT). One CIDR per line. */
export const x4bnetDatacenter: FeedDefinition = {
  id: "x4bnet-datacenter",
  kind: "category",
  codes: ["hosting"],
  schedule: "20 4 * * *",
  timestamps: "run",
  files: [
    { name: "ipv4.txt", url: `${BASE}/ipv4.txt` },
    { name: "ipv6.txt", url: `${BASE}/ipv6.txt` },
  ],
  parse(files) {
    const entries: ParsedEntry[] = [];
    let invalidLines = 0;
    for (const file of files) {
      const result = parsePrefixList(decodeText(file.body), (prefix) => ({ prefix, code: "hosting" }));
      entries.push(...result.entries);
      invalidLines += result.invalidLines;
    }
    return { entries, invalidLines };
  },
};
